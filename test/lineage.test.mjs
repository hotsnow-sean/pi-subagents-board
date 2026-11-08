import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeCount,
  applyComplete,
  applyStarted,
  createState,
  failureStageOf,
  groupActivityOf,
  groupStartedAt,
  healFromSnapshots,
  healDeadProcesses,
  lastRunIdOf,
  linkRevived,
  listLineages,
  mergeLiveStates,
  mergeStatus,
  normalizeState,
  pickVisible,
  RECENT_ENDED_MS,
  relinkOrphans,
  adoptRevivedFromSnapshots,
  samePath,
  startedAtOf,
  clearTerminalPending,
} from '../lib/lineage.mjs'

const BASE = 1_700_000_000_000

function fresh() {
  return createState({ sessionKey: 'abc', sessionFile: 'C:/sessions/a.jsonl', pid: 42, startedAt: BASE })
}

test('normalizeState: 认得的原样返回，认不得的按 success/stopped 兜底', () => {
  assert.equal(normalizeState('running'), 'running')
  assert.equal(normalizeState('COMPLETE'), 'complete')
  // stop 受理后的中间态：必须原样保留，否则用户点了停止却看到「未知」
  assert.equal(normalizeState('stopping'), 'stopping')
  assert.equal(normalizeState('weird', true), 'complete')
  assert.equal(normalizeState('weird', false), 'failed')
  assert.equal(normalizeState(undefined, undefined, true), 'stopped')
  assert.equal(normalizeState(undefined), 'unknown')
})

test('applyStarted: 第一段自成一链，段状态 running', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w', asyncDir: 'C:/tmp/async-1' }, BASE + 100)
  assert.equal(state.lineages.length, 1)
  const lineage = state.lineages[0]
  assert.equal(lineage.lineageRoot, 'run-1')
  assert.equal(lineage.agent, 'worker')
  assert.equal(lineage.cwd, 'C:/w')
  assert.equal(lineage.state, 'running')
  assert.equal(lineage.segments.length, 1)
  assert.equal(lineage.segments[0].runId, 'run-1')
  assert.equal(lineage.segments[0].state, 'running')
  assert.equal(lineage.segments[0].startedAt, BASE + 100)
})

test('applyStarted: 同一个 run 重复到达不新增段', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE + 100)
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE + 200)
  assert.equal(state.lineages.length, 1)
  assert.equal(state.lineages[0].segments.length, 1)
})

test('applyComplete: 补全终态、耗时、tokens、成本、子会话与 children', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w', asyncDir: 'C:/tmp/async-1' }, BASE)
  applyComplete(
    state,
    {
      id: 'run-1',
      agent: 'worker',
      state: 'complete',
      success: true,
      summary: 'done',
      exitCode: 0,
      durationMs: 12_000,
      timestamp: BASE + 12_000,
      sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl',
      totalTokens: { input: 10, output: 20, total: 30 },
      totalCost: { costUsd: 0.5 },
      results: [{ agent: 'worker', model: 'm1', status: 'complete', success: true, sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl' }],
    },
    BASE + 12_100,
  )
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.state, 'complete')
  assert.equal(segment.endedAt, BASE + 12_000)
  assert.equal(segment.durationMs, 12_000)
  assert.equal(segment.summary, 'done')
  assert.equal(segment.childSessionFile, 'C:/sessions/a/run-1/run-0/session.jsonl')
  assert.deepEqual(segment.tokens, { input: 10, output: 20, total: 30 })
  assert.equal(segment.costUsd, 0.5)
  assert.equal(segment.children.length, 1)
  assert.equal(segment.children[0].model, 'm1')
  assert.equal(state.lineages[0].state, 'complete')
})

test('applyComplete: 只有完成事件（插件中途才起来）也能补出一段', () => {
  const state = fresh()
  applyComplete(
    state,
    { id: 'run-9', agent: 'delegate', state: 'failed', success: false, durationMs: 3_000, timestamp: BASE + 3_000 },
    BASE + 3_100,
  )
  assert.equal(state.lineages.length, 1)
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.origin, 'complete')
  assert.equal(segment.state, 'failed')
  // 没有 started 事件时用「结束时间 - 耗时」倒推开始时间
  assert.equal(segment.startedAt, BASE)
})

test('applyComplete: resume 出的新段靠 childParentSession 接回原链', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  applyComplete(
    state,
    {
      id: 'run-1',
      state: 'complete',
      success: true,
      timestamp: BASE + 1_000,
      sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl',
      results: [{ sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl' }],
    },
    BASE + 1_000,
  )
  applyStarted(state, { id: 'run-2', agent: 'worker' }, BASE + 5_000)
  applyComplete(
    state,
    {
      id: 'run-2',
      state: 'complete',
      success: true,
      timestamp: BASE + 9_000,
      sessionFile: 'C:/sessions/a/run-2/run-0/session.jsonl',
      childParentSession: 'C:/sessions/a/run-1/run-0/session.jsonl',
    },
    BASE + 9_100,
  )
  assert.equal(state.lineages.length, 1, '两段应当挂在同一条链上')
  const lineage = state.lineages[0]
  assert.equal(lineage.lineageRoot, 'run-1')
  assert.equal(lineage.segments.length, 2)
  assert.equal(lineage.segments[1].runId, 'run-2')
})

test('applyComplete: resume 复用同一个子会话文件 → 接回原链（实测行为）', () => {
  const state = fresh()
  const shared = 'C:/sessions/a/run-1/run-0/session.jsonl'
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  applyComplete(
    state,
    { id: 'run-1', state: 'complete', success: true, timestamp: BASE + 1_000, sessionFile: shared, summary: '第一段' },
    BASE + 1_000,
  )
  // resume：新 runId，但 sessionFile 是同一个文件（pi 往原 session.jsonl 继续写），
  // 首行 parentSession 指向的是父会话——靠 parentSession 接不上，必须靠文件复用匹配
  applyStarted(state, { id: 'run-2', agent: 'worker' }, BASE + 5_000)
  applyComplete(
    state,
    {
      id: 'run-2',
      state: 'complete',
      success: true,
      timestamp: BASE + 9_000,
      sessionFile: shared,
      childParentSession: 'C:/sessions/parent.jsonl',
      summary: '第二段',
    },
    BASE + 9_100,
  )
  assert.equal(state.lineages.length, 1, '复用同一子会话文件的两段必须同链')
  const lineage = state.lineages[0]
  assert.equal(lineage.segments.length, 2)
  assert.equal(lineage.segments[1].runId, 'run-2')
  assert.equal(lineage.segments[1].revivedFrom, 'run-1')
  assert.equal(lineage.segments[1].summary, '第二段', '链尾段的摘要要是新段自己的')
  assert.equal(lineage.segments[0].summary, '第一段', '前一段摘要不被覆盖')
})

test('applyComplete: resume 链的第三次接链取链尾，不接回第一段', () => {
  const state = fresh()
  const shared = 'C:/sessions/a/run-1/run-0/session.jsonl'
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  applyComplete(state, { id: 'run-1', state: 'complete', success: true, timestamp: BASE + 1_000, sessionFile: shared }, BASE + 1_000)
  applyComplete(state, { id: 'run-2', state: 'complete', success: true, timestamp: BASE + 2_000, sessionFile: shared }, BASE + 2_000)
  applyComplete(state, { id: 'run-3', state: 'complete', success: true, timestamp: BASE + 3_000, sessionFile: shared }, BASE + 3_000)
  assert.equal(state.lineages.length, 1)
  const segments = state.lineages[0].segments
  assert.equal(segments.length, 3)
  assert.equal(segments[2].runId, 'run-3')
  assert.equal(segments[2].revivedFrom, 'run-2', 'revivedFrom 必须指向前一段（链尾），不能跳回 run-1')
})

test('applyComplete: 没有 started 的 resume 段也靠 parentSession 接到已有链', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  applyComplete(
    state,
    {
      id: 'run-1',
      state: 'complete',
      success: true,
      timestamp: BASE + 1_000,
      sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl',
      results: [{ sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl' }],
    },
    BASE + 1_000,
  )
  applyComplete(
    state,
    {
      id: 'run-2',
      state: 'complete',
      success: true,
      timestamp: BASE + 4_000,
      sessionFile: 'C:/sessions/a/run-2/run-0/session.jsonl',
      childParentSession: 'C:/sessions/a/run-1/run-0/session.jsonl',
    },
    BASE + 4_100,
  )
  assert.equal(state.lineages.length, 1)
  assert.equal(state.lineages[0].segments.length, 2)
})

test('mergeStatus: 只覆盖进度，不新增 status 里没有的字段', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w' }, BASE)
  mergeStatus(
    state,
    {
      asyncSnapshot: {
        runs: [
          {
            id: 'run-1',
            state: 'running',
            startedAt: BASE,
            updatedAt: BASE + 5_000,
            activity: { lastActivityAt: BASE + 4_900, turnCount: 3, toolCount: 2 },
            children: [{ index: 0, agent: 'worker', state: 'running', model: 'm2', thinking: 'high', activity: { lastActivityAt: BASE + 4_900 } }],
          },
        ],
      },
    },
    BASE + 5_000,
  )
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.cwd, 'C:/w', 'status 不该把 started 带来的 cwd 抹掉')
  assert.equal(segment.activity.turnCount, 3)
  assert.equal(segment.children[0].model, 'm2')
  assert.equal(segment.children[0].thinking, 'high')
})

test('mergeStatus: run 中途才起来时补出一条段（origin=status）', () => {
  const state = fresh()
  mergeStatus(state, { runs: [{ id: 'run-x', label: 'reviewer', state: 'running', startedAt: BASE }] }, BASE + 10)
  assert.equal(state.lineages.length, 1)
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.origin, 'status')
  assert.equal(segment.runId, 'run-x')
  assert.equal(state.lineages[0].agent, 'reviewer')
})

test('mergeStatus: 多 child 的 run 不硬塞同一个子会话路径', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  mergeStatus(
    state,
    {
      runs: [
        {
          id: 'run-1',
          state: 'running',
          children: [
            { index: 0, agent: 'w0', state: 'running' },
            { index: 1, agent: 'w1', state: 'running' },
          ],
        },
      ],
    },
    BASE + 1_000,
  )
  const children = state.lineages[0].segments[0].children
  assert.equal(children.length, 2)
  assert.equal(children[0].sessionFile, null)
  assert.equal(children[1].sessionFile, null)
})

test('mergeStatus: children 不带 index 时按位置归位，不无限追加（实测刷屏 bug）', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  // pi-subagents 的 status children 实测没有 index 字段
  const snapshot = {
    runs: [
      {
        id: 'run-1',
        state: 'running',
        children: [{ agent: 'worker', state: 'running', model: 'm2', thinking: 'high', activity: { lastActivityAt: BASE + 1_000 } }],
      },
    ],
  }
  for (let i = 1; i <= 10; i += 1) {
    mergeStatus(state, JSON.parse(JSON.stringify(snapshot)), BASE + i * 1_000)
  }
  const children = state.lineages[0].segments[0].children
  assert.equal(children.length, 1, '轮询 10 次也只应有 1 条 child')
  assert.equal(children[0].model, 'm2')
  assert.equal(children[0].thinking, 'high')
})

test('mergeStatus: 已终态的段跳过 status（心跳不再写盘、lastActivityAt 不再动）', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  applyComplete(
    state,
    {
      id: 'run-1',
      state: 'complete',
      success: true,
      timestamp: BASE + 1_000,
      durationMs: 1_000,
      sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl',
      results: [{ sessionFile: 'C:/sessions/a/run-1/run-0/session.jsonl' }],
    },
    BASE + 1_000,
  )
  const before = JSON.stringify(state.lineages[0])
  mergeStatus(
    state,
    {
      runs: [{ id: 'run-1', state: 'complete', updatedAt: BASE + 999_999, children: [{ agent: 'ghost', state: 'running' }] }],
    },
    BASE + 999_999,
  )
  assert.equal(JSON.stringify(state.lineages[0]), before, '终态段必须原封不动')
})

test('listLineages: 读出时收敛重复 children（自愈旧数据）', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  const segment = state.lineages[0].segments[0]
  // 模拟修复前攒出来的脏数据：同一条 child 被 byIndex.size 兜底追加了 3 次
  // （签名相同 = 同一份 status 快照反复到达；带 sessionFile 的那条是 complete 事件补的）
  segment.children = [
    { index: 0, agent: 'worker', model: 'm1', state: 'complete', lastActivityAt: BASE, sessionFile: null },
    { index: 1, agent: 'worker', model: 'm2', state: 'complete', lastActivityAt: BASE, sessionFile: 'C:/x/session.jsonl' },
    { index: 2, agent: 'worker', model: 'm2', state: 'complete', lastActivityAt: BASE, sessionFile: null },
  ]
  const list = listLineages(state)
  assert.equal(list[0].segments[0].children.length, 2, '签名相同的两条应收敛，不同签名保留')
  assert.equal(list[0].segments[0].children[0].sessionFile, null, 'm1 没有带路径的替身，原样保留')
  assert.equal(list[0].segments[0].children[1].sessionFile, 'C:/x/session.jsonl', '签名组内优先保留带 sessionFile 的那条')
  // 状态本体不动（浅拷贝语义）
  assert.equal(segment.children.length, 3)
})

test('listLineages: model 的 :档位 后缀拆成 thinking，同一条 child 两种表述收敛为一条', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  const segment = state.lineages[0].segments[0]
  // 复刻实测脏数据形状：complete results 的 model 带 :high 后缀，status 的 model+thinking 分写
  segment.children = [
    { index: 0, agent: 'worker', model: 'deepseek/x:high', thinking: null, state: 'complete', lastActivityAt: BASE + 129, sessionFile: 'C:/x/session.jsonl' },
    { index: 1, agent: 'worker', model: 'deepseek/x', thinking: 'high', state: 'complete', lastActivityAt: BASE, sessionFile: 'C:/x/session.jsonl' },
    { index: 2, agent: 'worker', model: 'deepseek/x', thinking: 'high', state: 'complete', lastActivityAt: BASE, sessionFile: null },
  ]
  const list = listLineages(state)
  assert.equal(list[0].segments[0].children.length, 1, '同一条 child 的两种表述应收敛为一条')
  const child = list[0].segments[0].children[0]
  assert.equal(child.model, 'deepseek/x')
  assert.equal(child.thinking, 'high')
  assert.equal(child.sessionFile, 'C:/x/session.jsonl')
})

test('listLineages: 无路径的并行 children 按 lastActivityAt 区分，不误合', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  const segment = state.lineages[0].segments[0]
  segment.children = [
    { index: 0, agent: 'worker', model: 'm1', thinking: null, state: 'running', lastActivityAt: BASE + 1_000, sessionFile: null },
    { index: 1, agent: 'worker', model: 'm1', thinking: null, state: 'running', lastActivityAt: BASE + 2_000, sessionFile: null },
  ]
  const list = listLineages(state)
  assert.equal(list[0].segments[0].children.length, 2, 'lastActivityAt 不同的并行 child 必须都保留')
})

test('listLineages: 按最后活动时间降序（复活后回到顶部）', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-old', agent: 'worker' }, BASE)
  applyStarted(state, { id: 'run-new', agent: 'worker' }, BASE + 10_000)
  const [first] = listLineages(state)
  assert.equal(first.lineageRoot, 'run-new')
})

test('listLineages: 返回浅拷贝，改列表不影响状态', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE)
  const list = listLineages(state)
  list[0].segments.push({ runId: 'fake' })
  list.pop()
  assert.equal(state.lineages.length, 1)
  assert.equal(state.lineages[0].segments.length, 1)
})

test('activeCount: 数的是活跃段，不是链', () => {
  const state = fresh()
  applyStarted(state, { id: 'a', agent: 'worker' }, BASE)
  applyStarted(state, { id: 'b', agent: 'worker' }, BASE + 100)
  applyComplete(state, { id: 'a', state: 'complete', success: true, timestamp: BASE + 200 }, BASE + 200)
  assert.equal(activeCount(state), 1)
})

/* ---------- sessionName：同角色并发时唯一能区分实例的字段（实测报告 P1） ---------- */

test('sessionName: async-complete 的 results[].sessionName 落到 children', () => {
  const state = fresh()
  applyComplete(
    state,
    {
      id: 'run-1',
      agent: 'worker',
      success: true,
      state: 'complete',
      timestamp: BASE,
      durationMs: 1_000,
      results: [{ agent: 'worker', sessionName: 'worker: 写词频 CLI', sessionFile: 'C:/child.jsonl', status: 'complete' }],
    },
    BASE,
  )
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.children[0].sessionName, 'worker: 写词频 CLI')
})

test('sessionName: status children 带上来，还捎上 currentTool', () => {
  const state = fresh()
  mergeStatus(
    state,
    {
      asyncSnapshot: {
        runs: [
          {
            id: 'run-1',
            state: 'running',
            startedAt: BASE,
            children: [
              {
                agent: 'worker',
                sessionName: 'worker: 你是测试用子代理 A',
                model: 'deepseek/deepseek-flash',
                thinking: 'high',
                state: 'running',
                currentTool: 'bash',
                currentToolStartedAt: BASE - 1_200,
              },
            ],
          },
        ],
      },
    },
    BASE + 1_000,
  )
  const child = state.lineages[0].segments[0].children[0]
  assert.equal(child.sessionName, 'worker: 你是测试用子代理 A')
  assert.equal(child.currentTool, 'bash')
  assert.equal(child.currentToolStartedAt, BASE - 1_200)
})

test('sessionName: started 给的名字被 complete 覆盖，没给不清掉', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', sessionName: 'worker: 初版任务' }, BASE)
  assert.equal(state.lineages[0].segments[0].sessionName, 'worker: 初版任务')
  applyComplete(state, { id: 'run-1', success: true, state: 'complete', timestamp: BASE + 1_000, sessionName: 'worker: 改过名' }, BASE + 1_000)
  assert.equal(state.lineages[0].segments[0].sessionName, 'worker: 改过名')
  applyComplete(state, { id: 'run-1', success: true, state: 'complete', timestamp: BASE + 2_000 }, BASE + 2_000)
  assert.equal(state.lineages[0].segments[0].sessionName, 'worker: 改过名')
})

test('failureStageOf: 跑了但没成 = run；一个子代理都没起来 = launch', () => {
  // 实测两条（2026-11-07 真实数据）：都是 state: failed，靠执行痕迹分开
  //   delegate 超时：438 tok、1 回合、有子会话
  assert.equal(
    failureStageOf({
      state: 'failed',
      error: 'Subagent timed out after 6000ms.',
      childSessionFile: 'C:/s/run-0/session.jsonl',
      tokens: { input: 329, output: 109, total: 438 },
      activity: { turnCount: 1 },
    }),
    'run',
  )
  //   workflow 脚本第 17 行抛错：steps 空、无 token、无会话
  assert.equal(
    failureStageOf({ state: 'failed', error: 'Error: 深色模式-故意失败的 workflow\n    at workflow-script.js:1:7' }),
    'launch',
  )
  // 只剩下子代理明细里的会话文件（顶层 childSessionFile 悬空是常态）也算跑过
  assert.equal(failureStageOf({ state: 'failed', children: [{ sessionFile: 'C:/s/x.jsonl' }] }), 'run')
})

test('failureStageOf: 非失败态一律空串（停止、完成、运行中都不该被说成失败）', () => {
  for (const state of ['complete', 'stopped', 'running', 'queued', 'stopping', 'unknown']) {
    assert.equal(failureStageOf({ state }), '', state)
  }
  assert.equal(failureStageOf(null), '')
})

test('failureStageOf: 被拒绝但没有任何执行痕迹 = launch（run 根本没启动）', () => {
  assert.equal(failureStageOf({ state: 'rejected', error: 'Active async run capacity exhausted' }), 'launch')
})

test('listLineages: 投影里带上 failureStage，UI 不用自己猜', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'workflow' }, BASE)
  applyComplete(
    state,
    { id: 'run-1', agent: 'workflow', state: 'failed', error: 'Error: boom', timestamp: BASE + 1_000 },
    BASE + 1_000,
  )
  const segment = listLineages(state)[0].segments[0]
  assert.equal(segment.failureStage, 'launch')
})

test('mergeLiveStates: 换实例后，老一代的段不会被新一份的空血缘冲掉', () => {
  const old = fresh()
  applyStarted(old, { id: 'run-a', agent: 'worker', asyncDir: 'C:/a' }, BASE + 100)
  applyComplete(old, { id: 'run-a', state: 'complete', success: true, durationMs: 5_000, timestamp: BASE + 5_000 }, BASE + 5_000)
  applyStarted(old, { id: 'run-b', agent: 'worker', asyncDir: 'C:/b' }, BASE + 6_000)

  // 新一代：只有它自己见过的一件事，历史一概不知
  const next = createState({ sessionKey: 'abc', sessionFile: 'C:/sessions/a.jsonl', pid: 99, startedAt: BASE + 60_000 })
  applyStarted(next, { id: 'run-c', agent: 'worker', asyncDir: 'C:/c' }, BASE + 61_000)

  const merged = mergeLiveStates([old, next])
  const runs = merged.lineages.flatMap((lineage) => lineage.segments.map((segment) => segment.runId)).sort()
  assert.deepEqual(runs, ['run-a', 'run-b', 'run-c'])
  assert.equal(merged.pid, 99)
  // 终态不能被「老一代的 running」翻回去：同 runId 以更新的那一代为准
  const a = merged.lineages.find((lineage) => lineage.lineageRoot === 'run-a')
  assert.equal(a.segments[0].state, 'complete')
})

test('mergeLiveStates: 同 runId 以新一代为准（老一代停在 running，新一代已终态）', () => {
  const old = fresh()
  applyStarted(old, { id: 'run-x', agent: 'worker', asyncDir: 'C:/x' }, BASE + 100)

  const next = createState({ sessionKey: 'abc', sessionFile: 'C:/sessions/a.jsonl', pid: 99, startedAt: BASE + 60_000 })
  applyStarted(next, { id: 'run-x', agent: 'worker', asyncDir: 'C:/x' }, BASE + 61_000)
  applyComplete(next, { id: 'run-x', state: 'complete', success: true, durationMs: 3_000, timestamp: BASE + 64_000 }, BASE + 64_000)

  const merged = mergeLiveStates([old, next])
  const segments = merged.lineages.flatMap((lineage) => lineage.segments)
  assert.equal(segments.length, 1, '同一个 run 不该出现两张卡')
  assert.equal(segments[0].state, 'complete')
})

test('healFromSnapshots: run 的 status.json 说终态了，就把卡从 running 推进去', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-h', agent: 'worker', asyncDir: 'C:/h' }, BASE + 100)
  // 事件丢了：段永远停在 running
  const healed = healFromSnapshots(state, () => ({ state: 'complete', endedAt: BASE + 9_000 }))
  assert.equal(healed, 1)
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.state, 'complete')
  assert.equal(segment.endedAt, BASE + 9_000)
  assert.equal(state.lineages[0].state, 'complete')
})

test('healFromSnapshots: 还在跑 / 没有 asyncDir / 已终态的段都不碰', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-r', agent: 'worker', asyncDir: 'C:/r' }, BASE + 100)
  assert.equal(healFromSnapshots(state, () => ({ state: 'running' })), 0)
  assert.equal(state.lineages[0].segments[0].state, 'running')

  applyStarted(state, { id: 'run-n', agent: 'worker' }, BASE + 200) // 没有 asyncDir
  const seen = []
  assert.equal(healFromSnapshots(state, (dir) => { seen.push(dir); return { state: 'running' } }), 0)
  assert.deepEqual(seen, ['C:/r'], '没有 asyncDir 的段不该去读文件')

  applyComplete(state, { id: 'run-r', state: 'complete', success: true, timestamp: BASE + 5_000 }, BASE + 5_000)
  let reads = 0
  assert.equal(healFromSnapshots(state, () => { reads += 1; return { state: 'complete' } }), 0)
  assert.equal(reads, 0, '终态段不该再去读 status.json')
})

/* ---------- pickVisible：软上限 + 保底保留 ---------- */

/** 造一条最简链：state / 最后活动 / 结束时刻（null = 还没结束） */
function chain(runId, state, at, endedAt = null) {
  return {
    lineageRoot: runId,
    agent: 'worker',
    state,
    lastActivityAt: at,
    segments: [{ runId, agent: 'worker', state, startedAt: at - 1_000, endedAt, activity: { lastActivityAt: at } }],
  }
}

test('pickVisible: 运行中的卡哪怕时间最旧也不被裁掉', () => {
  const now = BASE + 1_000_000
  // 三张历史卡都结束在保底窗口之外，才有资格参与名额竞争
  const ago = (i) => now - RECENT_ENDED_MS - i * 1_000
  const list = [
    chain('done-1', 'complete', ago(1), ago(1)),
    chain('done-2', 'complete', ago(2), ago(2)),
    chain('done-3', 'complete', ago(3), ago(3)),
    // 长跑但静默：活动时间停在一小时前，按时间序排最后
    chain('live-x', 'running', now - 3_600_000),
  ]
  const picked = pickVisible(list, { limit: 2, now })
  assert.equal(picked.pinned, 1)
  assert.deepEqual(picked.shown.map((l) => l.segments[0].runId), ['done-1', 'live-x'])
  assert.equal(picked.hidden, 2)
})

test('pickVisible: 刚结束的卡在窗口内保底，超出窗口就参与竞争', () => {
  const now = BASE + 1_000_000
  const recent = chain('just-done', 'complete', now - 60_000, now - 60_000)
  const old = chain('old-done', 'complete', now - RECENT_ENDED_MS - 2_000, now - RECENT_ENDED_MS - 2_000)
  const newest = chain('newest', 'complete', now - RECENT_ENDED_MS - 1_000, now - RECENT_ENDED_MS - 1_000)

  const picked = pickVisible([newest, recent, old], { limit: 1, now })
  assert.deepEqual(picked.shown.map((l) => l.segments[0].runId), ['just-done'])
  assert.equal(picked.recent, 1)
  assert.equal(picked.hidden, 2)

  // 刚好在窗口外 1ms：不再是 pinned，limit=1 时被挤掉
  const edge = pickVisible([newest, old], { limit: 1, now })
  assert.deepEqual(edge.shown.map((l) => l.segments[0].runId), ['newest'])
  assert.equal(edge.recent, 0)
})

test('pickVisible: 剩余名额按原时间序补历史卡，顺序不变', () => {
  const now = BASE + 1_000_000
  const list = Array.from({ length: 8 }, (_, i) =>
    chain(`old-${i}`, 'complete', now - RECENT_ENDED_MS - (i + 1) * 1_000, now - RECENT_ENDED_MS - (i + 1) * 1_000),
  )
  const picked = pickVisible(list, { limit: 3, now })
  assert.deepEqual(picked.shown.map((l) => l.segments[0].runId), ['old-0', 'old-1', 'old-2'])
  assert.equal(picked.hidden, 5)
  assert.equal(picked.pinned, 0)
})

test('pickVisible: pinned 超过上限时不裁——宁可长一点也不藏活着的卡', () => {
  const now = BASE + 1_000_000
  const list = ['a', 'b', 'c'].map((id) => chain(id, 'running', now - 10_000))
  const picked = pickVisible(list, { limit: 2, now })
  assert.equal(picked.shown.length, 3)
  assert.equal(picked.hidden, 0)
  assert.equal(picked.active, 3)
})

test('pickVisible: paused 也算保底（在等用户处理，不该被历史卡挤掉）', () => {
  const now = BASE + 1_000_000
  const list = [
    chain('done', 'complete', now - RECENT_ENDED_MS - 1_000, now - RECENT_ENDED_MS - 1_000),
    chain('hold', 'paused', now - 3_600_000),
  ]
  const picked = pickVisible(list, { limit: 1, now })
  assert.deepEqual(picked.shown.map((l) => l.segments[0].runId), ['hold'])
  assert.equal(picked.pinned, 1)
})

test('pickVisible: 条数没超上限时原样返回，不动任何卡', () => {
  const now = BASE + 1_000_000
  const list = [
    chain('a', 'complete', now - RECENT_ENDED_MS - 1_000, now - RECENT_ENDED_MS - 1_000),
    chain('b', 'running', now - 10),
  ]
  const picked = pickVisible(list, { limit: 20, now })
  assert.deepEqual(picked.shown, list)
  assert.equal(picked.hidden, 0)
  assert.equal(picked.pinned, 1)
})

/* ---------- 组的排序：只看活动锚点 ---------- */

test('groupActivityOf: 环状 children 不会死循环', () => {
  const a = chain('a', 'complete', BASE + 1)
  const b = chain('b', 'complete', BASE + 2)
  const childrenOf = new Map([['a', [b]], ['b', [a]]])
  assert.equal(groupActivityOf(a, childrenOf), BASE + 2)
})

test('groupActivityOf: 取组内（含子卡）最新活动时间', () => {
  const parent = chain('p', 'complete', BASE + 100)
  const kid = chain('k', 'complete', BASE + 900)
  assert.equal(groupActivityOf(parent, new Map([['p', [kid]]])), BASE + 900)
  assert.equal(groupActivityOf(parent), BASE + 100)
})

test('lastRunIdOf: 取末段的 runId（组锚点）', () => {
  const lineage = {
    segments: [
      { runId: 'first', state: 'complete' },
      { runId: 'last', state: 'running' },
    ],
  }
  assert.equal(lastRunIdOf(lineage), 'last')
  assert.equal(lastRunIdOf({ segments: [] }), '')
})


test('clearTerminalPending: 跑完的段不再挂「排队占位」，运行中的原样保留', () => {
  const state = {
    lineages: [
      {
        lineageRoot: 'a',
        segments: [
          // 旧版本写下的脏数据：普通代理跑完了，底下还挂着一个「第 1 步」
          { runId: 'a1', state: 'complete', pendingSteps: [{ index: 0, label: '', agent: 'delegate' }] },
          { runId: 'a2', state: 'running', pendingSteps: [{ index: 1, label: '汇总', agent: 'delegate' }] },
          // stopping 不是 active，但它也不该再显示「待启动」
          { runId: 'a3', state: 'stopping', pendingSteps: [{ index: 2, label: '', agent: 'x' }] },
        ],
      },
    ],
  }
  assert.equal(clearTerminalPending(state), 2)
  assert.deepEqual(state.lineages[0].segments[0].pendingSteps, [])
  assert.deepEqual(state.lineages[0].segments[1].pendingSteps, [{ index: 1, label: '汇总', agent: 'delegate' }])
  assert.deepEqual(state.lineages[0].segments[2].pendingSteps, [])
  // 再跑一次幂等
  assert.equal(clearTerminalPending(state), 0)
})

test('samePath: 斜杠方向与大小写不影响判定，空值一律不相等', () => {
  // 不写 `\\` 字面量：不同编辑器/工具链对它的转义处理不一致，会变成 `//`
  const backslash = String.fromCharCode(92)
  const winPath = ['C:', 'a', 'b', 'session.jsonl'].join(backslash)
  assert.equal(samePath(winPath, 'c:/a/b/session.jsonl'), true)
  assert.equal(samePath('C:/a/b/session.jsonl/', 'C:/a/b/session.jsonl'), true)
  assert.equal(samePath('C:/a/b.jsonl', 'C:/a/c.jsonl'), false)
  assert.equal(samePath('', ''), false)
  assert.equal(samePath(null, 'C:/x'), false)
})

test('linkRevived: 异链时把孤段搬进来源链，并按 startedAt 排在后面', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE + 1_000)
  applyComplete(
    state,
    { id: 'run-1', state: 'complete', success: true, timestamp: BASE + 2_000, durationMs: 1_000 },
    BASE + 2_000,
  )
  // resume 段在接链前是一条孤链（async-started 不带 revivedFrom，先建了孤链）
  applyStarted(state, { id: 'run-2', agent: 'worker' }, BASE + 5_000)
  assert.equal(state.lineages.length, 2)

  const hit = linkRevived(state, 'run-2', { revivedFrom: 'run-1' })
  assert.ok(hit)
  assert.equal(hit.merged, true)
  assert.equal(state.lineages.length, 1, '孤链要被清掉，不能留一条空链')
  const lineage = state.lineages[0]
  assert.deepEqual(lineage.segments.map((segment) => segment.runId), ['run-1', 'run-2'])
  assert.equal(lineage.segments[1].revivedFrom, 'run-1')
  assert.equal(lineage.segments[1].reviveRoot, 'run-1')
  assert.equal(lineage.segments[1].reviveHops, 1)
})

test('linkRevived: 本来就在同一条链上时只补字段，跳数不会被叠加', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE + 1_000)
  // applyStarted 带 revivedFrom 时会直接建在同一条链上
  applyStarted(state, { id: 'run-2', agent: 'worker', revivedFrom: 'run-1' }, BASE + 2_000)
  assert.equal(state.lineages.length, 1)

  const hit = linkRevived(state, 'run-2', { revivedFrom: 'run-1' })
  assert.ok(hit)
  assert.equal(hit.merged, false)
  assert.equal(hit.segment.reviveHops, 1)
  assert.equal(linkRevived(state, 'run-2', { revivedFrom: 'run-1' })?.segment.reviveHops, 1)
})

test('linkRevived: 来源段不在本会话时保持孤链，不凭空造父', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-2', agent: 'worker' }, BASE + 2_000)
  assert.equal(linkRevived(state, 'run-2', { revivedFrom: 'gone' }), null)
  assert.equal(state.lineages.length, 1)
  assert.equal(state.lineages[0].segments[0].revivedFrom, null)
})

test('linkRevived: revivedFrom 缺失时用 sessionFile 兜底（resume 复用同一份会话）', () => {
  const state = fresh()
  const shared = 'C:/s/child/9ea2d148/run-0/session.jsonl'
  const first = applyStarted(state, { id: 'run-1', agent: 'worker' }, BASE + 1_000)
  first.segment.childSessionFile = shared
  applyStarted(state, { id: 'run-2', agent: 'worker' }, BASE + 2_000)

  // 实测 status.json 里是反斜杠，段里可能记的是正斜杠
  const hit = linkRevived(state, 'run-2', { sessionFile: shared.replace(/\//g, '\\') })
  assert.ok(hit)
  assert.equal(hit.merged, true)
  assert.equal(hit.segment.revivedFrom, 'run-1')
})

test('startedAtOf: 取链尾段的启动时间，不是最早那段', () => {
  const lineage = {
    lineageRoot: 'r',
    lastActivityAt: BASE + 9_000,
    segments: [
      { runId: 'a', startedAt: BASE, endedAt: BASE + 1_000 },
      { runId: 'b', startedAt: BASE + 5_000, endedAt: BASE + 6_000 },
    ],
  }
  assert.equal(startedAtOf(lineage), BASE + 5_000)
})

test('startedAtOf: 缺 startedAt 时先回退 endedAt，再回退活动时间', () => {
  assert.equal(startedAtOf({ segments: [{ runId: 'a', startedAt: null, endedAt: BASE + 300 }] }), BASE + 300)
  assert.equal(startedAtOf({ lastActivityAt: BASE + 700, segments: [{ runId: 'a' }] }), BASE + 700)
  assert.equal(startedAtOf({ segments: [] }), 0)
})

test('groupStartedAt: 取组内最晚启动的一段（子步骤启动会让整组前移）', () => {
  const parent = { lineageRoot: 'p', segments: [{ runId: 'p1', startedAt: BASE }] }
  const child = { lineageRoot: 'c', segments: [{ runId: 'c1', startedAt: BASE + 8_000 }] }
  const childrenOf = new Map([['p1', [child]]])
  assert.equal(groupStartedAt(parent, childrenOf), BASE + 8_000)
  assert.equal(groupStartedAt(parent), BASE, '没有子卡时就是自己的启动时间')
})

test('listLineages: 按链尾启动时间倒序，不被「最近活动」带跑', () => {
  const state = fresh()
  const older = applyStarted(state, { id: 'old', agent: 'worker' }, BASE + 1_000)
  applyStarted(state, { id: 'new', agent: 'worker' }, BASE + 2_000)
  // 老卡刚说过一句话（活动时间比新卡晚）——旧的排序键会把它顶到前面
  older.segment.activity.lastActivityAt = BASE + 9_000
  const freshLineage = state.lineages.find((lineage) => lineage.lineageRoot === 'new')
  freshLineage.segments[0].activity.lastActivityAt = BASE + 3_000
  for (const lineage of state.lineages) {
    lineage.lastActivityAt = Math.max(...lineage.segments.map((segment) => segment.activity.lastActivityAt))
  }
  assert.deepEqual(listLineages(state).map((lineage) => lineage.lineageRoot), ['new', 'old'])
})

test('relinkOrphans: 历史孤链读侧收敛，连环 resume 的跳数逐级累加', () => {
  const state = {
    lineages: [
      { lineageRoot: 'run-1', segments: [{ runId: 'run-1', state: 'complete', startedAt: BASE }] },
      {
        lineageRoot: 'run-2',
        segments: [{ runId: 'run-2', state: 'complete', startedAt: BASE + 1_000, revivedFrom: 'run-1' }],
      },
      {
        lineageRoot: 'run-3',
        segments: [{ runId: 'run-3', state: 'complete', startedAt: BASE + 2_000, revivedFrom: 'run-2' }],
      },
    ],
  }
  assert.equal(relinkOrphans(state), 2)
  assert.equal(state.lineages.length, 1)
  assert.deepEqual(state.lineages[0].segments.map((segment) => segment.runId), ['run-1', 'run-2', 'run-3'])
  assert.equal(state.lineages[0].segments[2].reviveHops, 2)
  assert.equal(relinkOrphans(state), 0, '幂等：再跑一次不该再搬')
})

test('healDeadProcesses: 进程没了才判中断，活着/没 pid/已终态都不动', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', asyncDir: 'C:/run/1' }, BASE + 1_000)
  const segment = state.lineages[0].segments[0]
  segment.pendingSteps = [{ index: 1, label: '第二步', agent: 'worker' }]
  const snaps = { 'C:/run/1': { state: 'running', pid: 4242, lastUpdate: BASE + 5_000 } }
  const read = (/** @type {string} */ dir) => snaps[dir] ?? null

  assert.equal(
    healDeadProcesses(state, read, () => true),
    0,
    '进程还在 → 一个字都不该改（长思考是正常状态，不能按「多久没动」判死）',
  )
  assert.equal(segment.state, 'running')

  assert.equal(healDeadProcesses(state, read, () => false), 1)
  assert.equal(segment.state, 'lost')
  assert.equal(segment.endedAt, BASE + 5_000, '结束时间用 status 的最后一次写盘，不是我们此刻的时钟')
  assert.equal(segment.lostPid, 4242)
  assert.deepEqual(segment.pendingSteps, [], '什么都没跑完，排队中的步骤不该再挂着')
  assert.equal(healDeadProcesses(state, read, () => false), 0, '幂等：第二次不再重复计数')
})

test('healDeadProcesses: 没有 pid 或快照已是终态时一律不碰', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', asyncDir: 'C:/run/1' }, BASE + 1_000)
  applyStarted(state, { id: 'run-2', agent: 'worker', asyncDir: 'C:/run/2' }, BASE + 2_000)
  const snaps = {
    'C:/run/1': { state: 'running', pid: null, lastUpdate: BASE + 3_000 },
    'C:/run/2': { state: 'complete', pid: 4242, endedAt: BASE + 4_000 },
  }
  const read = (/** @type {string} */ dir) => snaps[dir] ?? null
  assert.equal(healDeadProcesses(state, read, () => false), 0, '无 pid 判不了；终态归 healFromSnapshots 管')
  assert.deepEqual(
    state.lineages.flatMap((lineage) => lineage.segments.map((segment) => segment.state)),
    ['running', 'running'],
  )
})

test('healDeadProcesses: 判成中断后不再算活跃（停止按钮会跟着消失）', () => {
  const state = fresh()
  applyStarted(state, { id: 'run-1', agent: 'worker', asyncDir: 'C:/run/1' }, BASE + 1_000)
  assert.equal(activeCount(state), 1)
  healDeadProcesses(state, () => ({ state: 'running', pid: 1, lastUpdate: BASE + 2_000 }), () => false)
  assert.equal(activeCount(state), 0)
  assert.equal(state.lineages[0].segments[0].state, 'lost')
})

test('adoptRevivedFromSnapshots: 段上没写 revivedFrom 时，从 run 的 status.json 补上（main 侧兜底）', () => {
  const state = {
    lineages: [
      { lineageRoot: 'run-1', segments: [{ runId: 'run-1', state: 'complete', startedAt: BASE }] },
      {
        lineageRoot: 'run-2',
        segments: [
          {
            runId: 'run-2',
            state: 'running',
            startedAt: BASE + 1_000,
            asyncDir: 'C:/runs/run-2',
            // 首帧写得太早：状态里还没有 revivedFrom
          },
        ],
      },
    ],
  }
  const snaps = {
    'C:/runs/run-2': { revivedFrom: 'run-1', steps: [{ sessionFile: 'C:/s/run-1/run-0/session.jsonl' }] },
  }
  assert.equal(adoptRevivedFromSnapshots(state, (dir) => snaps[dir] ?? null), 1)
  assert.equal(state.lineages[1].segments[0].revivedFrom, 'run-1')
  assert.equal(state.lineages[1].segments[0].childSessionFile, 'C:/s/run-1/run-0/session.jsonl')
  // 补完之后 relinkOrphans 就能照常搬——这是 main 侧「读侧自愈」的两步
  assert.equal(relinkOrphans(state), 1)
  assert.deepEqual(state.lineages[0].segments.map((segment) => segment.runId), ['run-1', 'run-2'])
})

test('adoptRevivedFromSnapshots: 终态段、已有 revivedFrom、没有目录的一律不碰（每轮都跑，要便宜）', () => {
  const state = {
    lineages: [
      {
        lineageRoot: 'run-1',
        segments: [
          { runId: 'run-1', state: 'running', asyncDir: 'C:/runs/a', revivedFrom: 'already' },
          { runId: 'run-2', state: 'complete', asyncDir: 'C:/runs/b' },
          { runId: 'run-3', state: 'running' },
        ],
      },
    ],
  }
  let reads = 0
  const value = adoptRevivedFromSnapshots(state, () => {
    reads += 1
    return { revivedFrom: 'run-1' }
  })
  assert.equal(value, 0)
  assert.equal(reads, 0, '这三段都不该触发磁盘读')
})
