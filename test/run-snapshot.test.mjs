import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import {
  clearLaunchCache,
  clearRunEventsCache,
  clearRunSnapshotCache,
  clearTaskTextCache,
  describeSteerFailure,
  isReviveNoise,
  launchDescriptorPath,
  launchKindOf,
  normalizeSteering,
  parseRunEventsTail,
  pendingStepsOf,
  isProcessAlive,
  readLaunchDescriptor,
  readRunEvents,
  readRunSnapshot,
  readRunTaskText,
  resolveRunTitle,
  resumeSourceOf,
  runIdFromSessionFile,
  stepLabel,
  steeringEntry,
} from '../lib/run-snapshot.mjs'

/** 实测形状（pi-subagents 0.86.0 的 status.json，删掉面板用不到的字段） */
const REAL_STEERING = {
  requested: 2,
  scheduled: 0,
  pending: 0,
  delivered: 1,
  failed: 1,
  recovered: 0,
  lastRequestedAt: 1794052674959,
  lastDeliveredAt: 1794052584019,
  recent: [
    {
      id: 'c45acc17-64af-4e54-847f-710915dd3a98',
      requestedAt: 1794052569523,
      source: 'steer-action',
      messagePreview: '回归插话测试：从下一个回合开始…',
      targets: [{ index: 0, state: 'delivered', routedAt: 1794052569531, deliveredAt: 1794052584019 }],
    },
    {
      id: 'afe7f1dd-fc29-4201-8551-c667c3399b26',
      requestedAt: 1794052674959,
      source: 'steer-action',
      messagePreview: '停下来，直接回报',
      targets: [{ index: 0, state: 'failed', reason: 'run became complete before steering request was consumed' }],
    },
  ],
}

function tmpRunDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-snap-'))
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

/** 造一个 runs 根目录：`<root>/<runId>/status.json`，形状与扩展的 async-subagent-runs 一致 */
function runsRoot(runs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-runs-'))
  for (const [runId, body] of Object.entries(runs)) {
    fs.mkdirSync(path.join(root, runId))
    fs.writeFileSync(path.join(root, runId, 'status.json'), JSON.stringify(body))
  }
  return root
}

test('normalizeSteering: 只留面板要的字段，messagePreview 这类不上车', () => {
  const steering = normalizeSteering(REAL_STEERING)
  assert.equal(steering.requested, 2)
  assert.equal(steering.delivered, 1)
  assert.equal(steering.failed, 1)
  assert.equal(steering.recent.length, 2)
  assert.deepEqual(Object.keys(steering.recent[0]).sort(), ['at', 'id', 'targets'])
  assert.equal(steering.recent[0].targets[0].state, 'delivered')
  assert.equal(steering.recent[0].targets[0].deliveredAt, 1794052584019)
  assert.ok(!('messagePreview' in steering.recent[0]), '正文不该被插件再存一份')
})

test('normalizeSteering: 坏输入一律 null / 空数组，不炸', () => {
  assert.equal(normalizeSteering(null), null)
  assert.equal(normalizeSteering('x'), null)
  assert.deepEqual(normalizeSteering({}).recent, [])
  assert.equal(normalizeSteering({ requested: '3' }).requested, 3)
  // recent 缺 id 的条目丢掉（没有 id 就没法跟回执对上）
  assert.deepEqual(normalizeSteering({ recent: [{ state: 'x' }, { id: 'ok' }] }).recent.map((e) => e.id), ['ok'])
  // 只留最后 20 条
  const many = { recent: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` })) }
  assert.equal(normalizeSteering(many).recent.length, 20)
  assert.equal(normalizeSteering(many).recent.at(-1).id, 'r29')
})

test('steeringEntry: 送达 / 失败（带原因）/ 还在路上', () => {
  const steering = normalizeSteering(REAL_STEERING)
  assert.equal(steeringEntry(steering, 'c45acc17-64af-4e54-847f-710915dd3a98').state, 'delivered')
  const failed = steeringEntry(steering, 'afe7f1dd-fc29-4201-8551-c667c3399b26')
  assert.equal(failed.state, 'failed')
  assert.match(failed.reason, /run became complete/)

  const pending = normalizeSteering({ recent: [{ id: 'p1', targets: [{ index: 0, state: 'pending' }] }] })
  assert.equal(steeringEntry(pending, 'p1').state, 'pending')

  assert.equal(steeringEntry(steering, 'nope'), null, '查不到就是查不到，不编一个状态')
  assert.equal(steeringEntry(null, 'x'), null)
  assert.equal(steeringEntry(steering, ''), null)
})

test('steeringEntry: 多目标里有一个失败就算失败（workflow 场景）', () => {
  const steering = normalizeSteering({
    recent: [
      {
        id: 'multi',
        targets: [
          { index: 0, state: 'delivered' },
          { index: 1, state: 'failed', reason: 'cannot be steered' },
        ],
      },
    ],
  })
  const entry = steeringEntry(steering, 'multi')
  assert.equal(entry.state, 'failed')
  assert.equal(entry.reason, 'cannot be steered')
})

test('describeSteerFailure: 已知原因翻人话，未知原样带上', () => {
  assert.match(describeSteerFailure('run became complete before steering request was consumed'), /刚好在这一刻结束了/)
  assert.match(describeSteerFailure('async run x is complete and cannot be steered'), /已经结束了/)
  assert.match(describeSteerFailure('blocked on a pending supervisor ask'), /等你回答一个问题/)
  assert.match(describeSteerFailure(''), /没投进去/)
  assert.match(describeSteerFailure('something odd happened'), /something odd happened/)
})

test('readRunSnapshot: 从 status.json 取会话名与 steering', () => {
  clearRunSnapshotCache()
  const dir = tmpRunDir({
    'status.json': JSON.stringify({
      runId: 'run-1',
      state: 'running',
      startedAt: 1,
      steering: REAL_STEERING,
      steps: [
        { agent: 'worker', sessionName: 'worker: 【实时标题探测】工作目录: C:/w', status: 'running', steering: REAL_STEERING },
        { agent: 'delegate', sessionName: 'delegate: 第二个', status: 'pending' },
      ],
    }),
  })
  const snap = readRunSnapshot(dir)
  assert.equal(snap.runId, 'run-1')
  assert.equal(snap.state, 'running')
  assert.equal(snap.steps.length, 2)
  assert.equal(snap.steps[0].sessionName, 'worker: 【实时标题探测】工作目录: C:/w')
  assert.equal(snap.steps[1].index, 1, '缺 index 时按位置补')
  assert.equal(snap.steps[0].steering.failed, 1)
  assert.equal(snap.steering.requested, 2)
})

test('readRunSnapshot: 取到 steps[].activityState（P10「等人回答」的唯一信号）', () => {
  clearRunSnapshotCache()
  const dir = tmpRunDir({
    'status.json': JSON.stringify({
      runId: 'run-wait',
      state: 'running',
      // 实测形状：`state` / `status` 都是 running，只有 activityState 说它在等人
      steps: [
        { agent: 'delegate', status: 'running', activityState: 'needs_attention' },
        { agent: 'delegate', status: 'running', activityState: 'active_long_running' },
        { agent: 'delegate', status: 'running' },
      ],
    }),
  })
  const snap = readRunSnapshot(dir)
  assert.equal(snap.state, 'running')
  assert.equal(snap.steps[0].activityState, 'needs_attention')
  assert.equal(snap.steps[1].activityState, 'active_long_running')
  assert.equal(snap.steps[2].activityState, '', '字段缺就是空串，不要继承上一步的值')
})

test('readRunSnapshot: 文件没变就复用解析结果（面板每秒一次 getState）', () => {
  clearRunSnapshotCache()
  const dir = tmpRunDir({ 'status.json': JSON.stringify({ runId: 'r', steps: [] }) })
  const first = readRunSnapshot(dir)
  const second = readRunSnapshot(dir)
  assert.equal(second, first, 'mtime + size 都没变时应当命中缓存（同一个对象）')
})

test('readRunSnapshot: 缺文件 / 空路径 / 坏 JSON / 超大文件 → null，不抛', () => {  clearRunSnapshotCache()
  assert.equal(readRunSnapshot(''), null)
  assert.equal(readRunSnapshot(null), null)
  assert.equal(readRunSnapshot(path.join(os.tmpdir(), 'board-nope-does-not-exist')), null)

  const broken = tmpRunDir({ 'status.json': '{ not json' })
  assert.equal(readRunSnapshot(broken), null)

  const huge = tmpRunDir({ 'status.json': JSON.stringify({ pad: 'x'.repeat(600 * 1024) }) })
  assert.equal(readRunSnapshot(huge), null, 'workflow 大 run 的文件不值得读')
})

/* ---------- 标题解析（报告 P1″ 结论 2 / P1′） ---------- */

const REAL_RESUME_NAME =
  'delegate: You are reviving a previous subagent conversation. Origin...'
const REAL_ORIGIN_NAME = 'delegate: 约 25 秒任务：往 playground/name-probe/a.md 写一行当前时间，sleep 15，再写...'

test('isReviveNoise: 认得出实测那句模板话，正常任务名不算', () => {
  assert.equal(isReviveNoise(REAL_RESUME_NAME), true)
  assert.equal(isReviveNoise(REAL_ORIGIN_NAME), false)
  assert.equal(isReviveNoise(''), false)
  assert.equal(isReviveNoise(null), false)
})

test('resolveRunTitle: 普通 run 用自己的 sessionName', () => {
  clearRunSnapshotCache()
  const root = runsRoot({ 'run-a': { runId: 'run-a', state: 'running', steps: [{ agent: 'worker', sessionName: REAL_ORIGIN_NAME }] } })
  const got = resolveRunTitle(path.join(root, 'run-a'))
  assert.equal(got.title, REAL_ORIGIN_NAME)
  assert.equal(got.revivedFrom, null)
})

test('resolveRunTitle: resume 段的标题去原 run 取，模板废话不上卡', () => {
  clearRunSnapshotCache()
  const root = runsRoot({
    'run-a': { runId: 'run-a', state: 'complete', steps: [{ agent: 'delegate', sessionName: REAL_ORIGIN_NAME }] },
    'run-b': {
      runId: 'run-b',
      state: 'running',
      revivedFrom: 'run-a',
      steps: [{ agent: 'delegate', sessionName: REAL_RESUME_NAME }],
    },
  })
  const got = resolveRunTitle(path.join(root, 'run-b'))
  assert.equal(got.title, REAL_ORIGIN_NAME, '拿到的必须是原任务名')
  assert.equal(got.revivedFrom, 'run-a', 'revivedFrom 同时要带出来，卡片上要标「续」')
})

test('resolveRunTitle: 连环 resume 一路往回追，并报出根 run 与续跑次数（P1″）', () => {
  clearRunSnapshotCache()
  const root = runsRoot({
    'run-a': { runId: 'run-a', steps: [{ agent: 'delegate', sessionName: REAL_ORIGIN_NAME }] },
    'run-b': { runId: 'run-b', revivedFrom: 'run-a', steps: [{ sessionName: REAL_RESUME_NAME }] },
    'run-c': { runId: 'run-c', revivedFrom: 'run-b', steps: [{ sessionName: REAL_RESUME_NAME }] },
  })
  const got = resolveRunTitle(path.join(root, 'run-c'))
  assert.equal(got.title, REAL_ORIGIN_NAME)
  assert.equal(got.revivedFrom, 'run-b', 'revivedFrom 只报直接来源，追到哪一层是内部事')
  assert.equal(got.rootRunId, 'run-a', '徽标要指最初那条，不是直接来源')
  assert.equal(got.hops, 2, '续了两次')
})

test('resolveRunTitle: 原 run 目录已被清理 → 没有标题，但 revivedFrom 照样带出来', () => {
  clearRunSnapshotCache()
  const root = runsRoot({
    'run-b': { runId: 'run-b', revivedFrom: 'run-gone', steps: [{ sessionName: REAL_RESUME_NAME }] },
  })
  const got = resolveRunTitle(path.join(root, 'run-b'))
  assert.equal(got.title, '', '读不到就退回角色名，不编')
  assert.equal(got.revivedFrom, 'run-gone')
})

test('resolveRunTitle: status.json 里若有 name（扩展将来落地 P1′）就优先用它', () => {
  clearRunSnapshotCache()
  const root = runsRoot({
    'run-a': { runId: 'run-a', name: '命名探测-甲', steps: [{ sessionName: 'delegate: 随便什么任务首行' }] },
  })
  assert.equal(resolveRunTitle(path.join(root, 'run-a')).title, '命名探测-甲')
})

test('resolveRunTitle: 空路径 / 目录不存在 → 空标题，不抛', () => {
  clearRunSnapshotCache()
  assert.deepEqual(resolveRunTitle(''), { title: '', revivedFrom: null, rootRunId: '', hops: 0 })
  assert.deepEqual(resolveRunTitle(null), { title: '', revivedFrom: null, rootRunId: '', hops: 0 })
  assert.equal(resolveRunTitle(path.join(os.tmpdir(), 'board-nope-runs')).title, '')
})

/* ---------- P6：workflow 的 label 优先于 sessionName ---------- */

test('stepLabel / resolveRunTitle: workflow 的步骤名优先，等于 workflowKey 的占位符被跳过', () => {
  clearRunSnapshotCache()
  const root = runsRoot({
    // 实测：单个 step 的 workflow，label 会退化成 workflowKey（`task-1`）
    'run-x': { runId: 'run-x', steps: [{ label: 'task-1', workflowKey: 'task-1', sessionName: 'worker: 你是测试用的' }] },
    // 实测：编排者给了真名字
    'run-y': { runId: 'run-y', steps: [{ label: '第一步-取数', workflowKey: 's1', sessionName: 'worker: 随便什么' }] },
  })
  assert.equal(stepLabel(readRunSnapshot(path.join(root, 'run-x'))), '', '占位符不算名字')
  assert.equal(resolveRunTitle(path.join(root, 'run-x')).title, 'worker: 你是测试用的', '退回 sessionName')
  assert.equal(stepLabel(readRunSnapshot(path.join(root, 'run-y'))), '第一步-取数')
  assert.equal(resolveRunTitle(path.join(root, 'run-y')).title, '第一步-取数', 'label 排在 sessionName 前面')
})

test('容器（mode=workflow）不拿第一步的 label 当自己的标题，但 steps[].runId 照常解析', () => {
  clearRunSnapshotCache()
  const root = runsRoot({
    'run-p': {
      runId: 'run-p',
      mode: 'workflow',
      steps: [
        { runId: 'run-a', label: '第一步-取数', sessionName: 'delegate: 用 bash 执行 echo 7' },
        { runId: 'run-b', label: '第二步-乘法', sessionName: 'delegate: 算乘法' },
      ],
    },
  })
  const snap = readRunSnapshot(path.join(root, 'run-p'))
  assert.deepEqual(
    snap.steps.map((step) => step.runId),
    ['run-a', 'run-b'],
    '父子关系就靠它（面板据此把子卡挂在父卡下面）',
  )
  assert.equal(stepLabel(snap), '', '第一步的名字属于子卡，父卡拿去用就撞名了')
  assert.equal(resolveRunTitle(path.join(root, 'run-p')).title, '', '父卡标题交给 UI 兜底成「角色 · 尾号」')
})

test('readRunSnapshot: steps 带上 label / workflowKey / sessionFile（P6 + P8 的数据源）', () => {
  clearRunSnapshotCache()
  const dir = tmpRunDir({
    'status.json': JSON.stringify({
      runId: 'run-1',
      steps: [{ label: '标签A-回声', workflowKey: 'a', sessionFile: 'C:/s/child.jsonl', status: 'completed' }],
    }),
  })
  const snap = readRunSnapshot(dir)
  assert.equal(snap.steps[0].label, '标签A-回声')
  assert.equal(snap.steps[0].workflowKey, 'a')
  assert.equal(snap.steps[0].sessionFile, 'C:/s/child.jsonl')
})


/* ---------- 排队中的步骤：只有容器 run 才有 ---------- */

test('pendingSteps: 普通代理的单步不算占位（steps[0] 就是它自己）', () => {
  // 实测形状：57 个 single run 全部是「1 步、无 runId」，status 取到 complete/failed/stopped
  for (const status of ['complete', 'failed', 'stopped', 'running']) {
    const snap = { mode: 'single', steps: [{ index: 0, runId: '', agent: 'delegate', status }] }
    assert.deepEqual(pendingStepsOf(snap), [], status)
  }
})

test('pendingSteps: workflow 里没 runId 的步骤才是排队占位', () => {
  const snap = {
    mode: 'workflow',
    steps: [
      { index: 0, runId: 'run-a', agent: 'delegate', status: 'running', label: '取数' },
      { index: 1, runId: '', agent: 'delegate', status: 'pending', label: '汇总' },
      { index: 2, runId: '', agent: 'delegate', status: 'completed', label: '收尾' },
    ],
  }
  assert.deepEqual(pendingStepsOf(snap), [{ index: 1, label: '汇总', agent: 'delegate' }])
})

test('pendingSteps: 终态步骤不再当排队（跑完了还挂「待启动」会以为是它没动）', () => {
  const snap = {
    mode: 'workflow',
    steps: [
      { index: 0, runId: '', status: 'complete' },
      { index: 1, runId: '', status: 'failed' },
      { index: 2, runId: '', status: 'stopped' },
      { index: 3, runId: '', status: 'cancelled' },
      { index: 4, runId: '', status: 'queued' },
    ],
  }
  assert.deepEqual(pendingStepsOf(snap), [{ index: 4, label: '', agent: '' }])
})

test('pendingSteps: 没有 mode 的老数据单步按 single 处理，多步按容器', () => {
  assert.deepEqual(pendingStepsOf({ steps: [{ index: 0, runId: '', status: 'running' }] }), [])
  // 多步：两步都还没 runId（连 status 都没有），就都是排队占位
  assert.deepEqual(pendingStepsOf({ steps: [{}, { index: 1, runId: '', status: 'pending' }] }), [
    { index: 0, label: '', agent: '' },
    { index: 1, label: '', agent: '' },
  ])
})

/* ---------- 事件流尾部：控制信号与提问（报告 P19 / P20） ---------- */

/** 实测形状（410ae341 卡死那一刻的 subagent.control） */
const IDLE_CONTROL = JSON.stringify({
  type: 'subagent.control',
  event: {
    type: 'needs_attention',
    to: 'needs_attention',
    ts: 1794120055464,
    runId: '410ae341',
    agent: 'delegate',
    index: 0,
    message: 'delegate needs attention (no observed activity for 60s)',
    reason: 'idle',
    elapsedMs: 60236,
    taskPreview: '[prompt redacted]',
  },
  channels: ['event', 'async', 'intercom'],
})

test('parseRunEventsTail: reason=idle 是「无响应」，不是「等待回答」（报告 P19）', () => {
  const { control, ask } = parseRunEventsTail(`${IDLE_CONTROL}\n`)
  assert.equal(control.reason, 'idle')
  assert.equal(control.type, 'needs_attention')
  assert.equal(control.at, 1794120055464)
  assert.equal(control.elapsedMs, 60236)
  assert.equal(control.currentTool, '', 'idle 时没有工具在跑——这正是它和「等人回答」的区别')
  assert.equal(ask, null)
})

test('parseRunEventsTail: 提问与回答按 toolCallId 配对，回答去掉前缀并留耗时（报告 P20）', () => {
  const call = JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'c1',
    toolName: 'contact_supervisor',
    args: { reason: 'need_decision', message: '请选择报告文件名：A 还是 B' },
    observedAt: 1000,
  })
  const control = JSON.stringify({
    type: 'subagent.control',
    event: { type: 'needs_attention', reason: 'supervisor_request', ts: 1200, currentTool: 'contact_supervisor', toolCallId: 'c1' },
  })
  const end = JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'c1',
    toolName: 'contact_supervisor',
    result: { content: [{ type: 'text', text: '**Reply from supervisor:**\nA（用 waiting-report.md）' }] },
    durationMs: 399349,
    observedAt: 400000,
  })

  const { control: seen, ask } = parseRunEventsTail([call, control, end].join('\n'))
  assert.equal(seen.reason, 'supervisor_request')
  assert.equal(seen.currentTool, 'contact_supervisor')
  assert.equal(ask.question, '请选择报告文件名：A 还是 B')
  assert.equal(ask.reason, 'need_decision')
  assert.equal(ask.askedAt, 1000)
  assert.equal(ask.answer, 'A（用 waiting-report.md）')
  assert.equal(ask.answeredAt, 400000)
  assert.equal(ask.durationMs, 399349)
})

test('parseRunEventsTail: 还没回答时 answer 留空；坏行不影响后面的行', () => {
  const call = JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'c2',
    toolName: 'contact_supervisor',
    args: { message: '等一个答案' },
    observedAt: 2000,
  })
  const { ask } = parseRunEventsTail([call, 'not json', '{"type":', '{"type":"turn_end"}'].join('\n'))
  assert.equal(ask.question, '等一个答案')
  assert.equal(ask.answer, '')
  assert.equal(ask.answeredAt, null)
})

test('parseRunEventsTail: 空文本 / 不完整的一行 → 空结果，不抛错', () => {
  assert.deepEqual(parseRunEventsTail(''), { control: null, ask: null })
  assert.equal(parseRunEventsTail('{"type":"message_start"').control, null)
})

test('readRunEvents: 控制事件压在几十 KB 后面也读得到，且第二次命中缓存', () => {
  clearRunEventsCache()
  const filler = Array.from({ length: 400 }, (_, i) =>
    JSON.stringify({ type: 'tool_execution_update', i, pad: 'x'.repeat(180) }),
  ).join('\n')
  const dir = tmpRunDir({ 'events.jsonl': `${filler}\n${IDLE_CONTROL}\n` })
  const events = readRunEvents(dir)
  assert.equal(events?.control?.reason, 'idle')
  assert.equal(readRunEvents(dir), events, 'mtime/size 没变就直接给同一个对象')
})

test('readRunEvents: 目录里没有 events.jsonl → null（老 run 不该报错）', () => {
  assert.equal(readRunEvents(tmpRunDir({})), null)
  assert.equal(readRunEvents(''), null)
})

test('readRunSnapshot: 续跑 run 没有超时保护，且带出真实 lastActivityAt（报告 P18）', () => {
  clearRunSnapshotCache()
  const fresh = tmpRunDir({
    'status.json': JSON.stringify({
      runId: 'fresh',
      state: 'running',
      timeoutMs: 1_800_000,
      deadlineAt: 1794120000000,
      lastActivityAt: 1794119990000,
      steps: [{ status: 'running', activityState: 'active_long_running' }],
    }),
  })
  const snap = readRunSnapshot(fresh)
  assert.equal(snap.hasDeadline, true)
  assert.equal(snap.lastActivityAt, 1794119990000)
  assert.equal(snap.currentTool, '')

  // 实测 3 个续跑 run 全都没有 deadlineAt / timeoutMs
  const resumed = tmpRunDir({
    'status.json': JSON.stringify({
      runId: 'resumed',
      state: 'running',
      revivedFrom: 'origin',
      steps: [{ status: 'running', activityState: 'needs_attention', currentTool: 'contact_supervisor' }],
    }),
  })
  const snap2 = readRunSnapshot(resumed)
  assert.equal(snap2.hasDeadline, false)
  assert.equal(snap2.currentTool, 'contact_supervisor', '需要关注时它说明到底是不是在等人回答')
})

test('isProcessAlive: 活着/死了/不知道，三种都要分对', () => {
  assert.equal(isProcessAlive(process.pid), true, '自己的 pid 当然活着')
  // 真起一个子进程再让它退出：比随便猜一个数字稳（pid 是会被系统复用的）
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(isProcessAlive(child.pid), false, '已经退出的 pid 必须判死')
  assert.equal(isProcessAlive(null), true, '没有 pid 时不能瞎判死')
  assert.equal(isProcessAlive(0), true)
})

test('readRunSnapshot: 带出 pid 与 lastUpdate（判断进程死活的唯一依据）', () => {
  const dir = tmpRunDir({
    'status.json': JSON.stringify({
      runId: 'run-1',
      state: 'running',
      pid: 4242,
      lastUpdate: 1794123328285,
      steps: [{ agent: 'worker' }],
    }),
  })
  const snap = readRunSnapshot(dir)
  assert.equal(snap.pid, 4242)
  assert.equal(snap.lastUpdate, 1794123328285)
})

/* ---------- launch 描述符：resume 的「预约单」 ---------- */

/** 造一份实测形状的 runs 根目录：`<tmp>/async-subagent-runs/<runId>` + 同级 launches */
function tmpRunsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-launch-'))
  fs.mkdirSync(path.join(root, 'async-subagent-runs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'async-subagent-launches'), { recursive: true })
  return root
}

/** @param {string} root @param {string} runId @param {Record<string, unknown>} descriptor */
function writeDescriptor(root, runId, descriptor) {
  const dir = path.join(root, 'async-subagent-launches', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'recovery-descriptor.json'), JSON.stringify(descriptor))
  return dir
}

test('launchDescriptorPath: asyncDir 是 <runsRoot>/async-subagent-runs/<runId>，launches 是它的兄弟目录', () => {
  const asyncDir = path.join('C:', 'tmp', 'runs', 'async-subagent-runs', 'abc-123')
  assert.equal(
    launchDescriptorPath(asyncDir),
    path.join('C:', 'tmp', 'runs', 'async-subagent-launches', 'abc-123', 'recovery-descriptor.json'),
  )
  assert.equal(launchDescriptorPath(''), '')
})

test('runIdFromSessionFile: 从子会话路径取出 runId，形状不对给空串', () => {
  // 用 fromCharCode 拼反斜杠：heredoc 会把 `\\` 吃掉，直接写会变成 `//`
  const win = ['C:', 'sessions', 'parent', '8bdba4a7-5310', 'run-0', 'session.jsonl'].join(String.fromCharCode(92))
  assert.equal(runIdFromSessionFile(win), '8bdba4a7-5310')
  assert.equal(runIdFromSessionFile('/home/u/sessions/6dec8284-4058/run-2/session.jsonl'), '6dec8284-4058')
  assert.equal(runIdFromSessionFile('/home/u/sessions/session.jsonl'), '')
  assert.equal(runIdFromSessionFile(''), '')
})

test('resumeSourceOf: 描述符指向别人的会话文件 = 续跑；指向自己的 = 普通 run', () => {
  clearLaunchCache()
  const root = tmpRunsRoot()
  const resumeId = 'bc779a16-fed5-4afc-9530-526077153ec9'
  const originId = '6dec8284-4058-456c-ae66-df2da5922efa'
  const shared = path.join(root, 'sessions', originId, 'run-0', 'session.jsonl')

  // 实测形状：bc779a16 的描述符 sessionFile 指向 6dec8284 的会话文件
  writeDescriptor(root, resumeId, { sourceRunId: resumeId, sessionFile: shared })
  const resumed = resumeSourceOf(path.join(root, 'async-subagent-runs', resumeId), resumeId)
  assert.deepEqual(resumed, { sessionFile: shared, sourceRunId: originId })

  const plainId = 'cfdcee75-cefb-4a11-97a5-0f2aa4241801'
  const own = path.join(root, 'sessions', plainId, 'run-0', 'session.jsonl')
  writeDescriptor(root, plainId, { sourceRunId: plainId, sessionFile: own })
  assert.equal(
    resumeSourceOf(path.join(root, 'async-subagent-runs', plainId), plainId),
    null,
    '普通 run 指向自己的新文件，不能当续跑',
  )
})

test('readLaunchDescriptor / resumeSourceOf: 没有描述符（老版本或已清理）→ null，退回探测', () => {
  clearLaunchCache()
  const root = tmpRunsRoot()
  const asyncDir = path.join(root, 'async-subagent-runs', 'no-descriptor')
  assert.equal(readLaunchDescriptor(asyncDir), null)
  assert.equal(resumeSourceOf(asyncDir, 'no-descriptor'), null)
  assert.equal(resumeSourceOf('', 'x'), null)
})

test('launchKindOf: 描述符指向自己=plain，指向别人=resume，没有描述符=unknown', () => {
  clearLaunchCache()
  const root = tmpRunsRoot()
  const plainId = 'cfdcee75-cefb-4a11-97a5-0f2aa4241801'
  writeDescriptor(root, plainId, { sessionFile: path.join(root, 's', plainId, 'run-0', 'session.jsonl') })
  assert.equal(launchKindOf(path.join(root, 'async-subagent-runs', plainId), plainId), 'plain')

  const resumeId = 'bc779a16-fed5-4afc-9530-526077153ec9'
  writeDescriptor(root, resumeId, { sessionFile: path.join(root, 's', '6dec8284-4058', 'run-0', 'session.jsonl') })
  assert.equal(launchKindOf(path.join(root, 'async-subagent-runs', resumeId), resumeId), 'resume')

  assert.equal(launchKindOf(path.join(root, 'async-subagent-runs', 'none'), 'none'), 'unknown')
  assert.equal(launchKindOf('', 'x'), 'unknown')
})

/* ---------- 任务原文：比 status.json 早二十秒的那一份 ---------- */

/** @param {string} runDir @param {Array<Record<string, unknown>>} events */
function writeRunEvents(runDir, events) {
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
}

/** @param {string} text */
const userMessage = (text) => ({
  type: 'message_start',
  message: { role: 'user', content: [{ type: 'text', text }] },
})

test('readRunTaskText: 跳过 system，取第一条 user 消息的首行并去掉 Task: 前缀', () => {
  clearTaskTextCache()
  const root = tmpRunsRoot()
  const dir = path.join(root, 'async-subagent-runs', 'run-a')
  writeRunEvents(dir, [
    { type: 'subagent.run.started', runId: 'run-a' },
    { type: 'session_info_changed', name: 'subagent-delegate-run-a-1' },
    { type: 'message_start', message: { role: 'system', content: 'SYSTEM PROMPT' } },
    userMessage('Task: 这是一次子代理功能测试，不要做任何实际的活。\n\n步骤：\n1. 用 bash 执行 sleep 15。'),
  ])
  assert.equal(readRunTaskText(dir), '这是一次子代理功能测试，不要做任何实际的活。')
})

test('readRunTaskText: 复活提示语不是任务 → 空串（交给原 run 的标题）', () => {
  clearTaskTextCache()
  const root = tmpRunsRoot()
  const dir = path.join(root, 'async-subagent-runs', 'run-r')
  writeRunEvents(dir, [
    userMessage('Task: You are reviving a previous subagent conversation.\n\nOriginal run: 3dc1a318'),
  ])
  assert.equal(readRunTaskText(dir), '')
})

test('readRunTaskText: 没有事件文件、只有 system 消息、或空目录 → 空串', () => {
  clearTaskTextCache()
  const root = tmpRunsRoot()
  assert.equal(readRunTaskText(path.join(root, 'async-subagent-runs', 'missing')), '')
  assert.equal(readRunTaskText(''), '')

  const sys = path.join(root, 'async-subagent-runs', 'only-system')
  writeRunEvents(sys, [{ type: 'message_start', message: { role: 'system', content: 'S' } }])
  assert.equal(readRunTaskText(sys), '')
})

test('readRunTaskText: 首帧还没有 user 消息时不缓存空结果——文件增长后能读到', () => {
  clearTaskTextCache()
  const root = tmpRunsRoot()
  const dir = path.join(root, 'async-subagent-runs', 'run-grow')
  writeRunEvents(dir, [{ type: 'subagent.run.started', runId: 'run-grow' }])
  assert.equal(readRunTaskText(dir), '')

  // 真实现场：run 起来 1~2 秒后才写进第一条 user 消息
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(userMessage('Task: 【单链测试】工作目录: C:/w')) + '\n')
  assert.equal(readRunTaskText(dir), '【单链测试】工作目录: C:/w')
})
