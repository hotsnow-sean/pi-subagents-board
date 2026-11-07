import assert from 'node:assert/strict'
import test from 'node:test'

import { activeCount, applyComplete, applyStarted, createState, listLineages, mergeStatus, normalizeState } from '../lib/lineage.mjs'

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
