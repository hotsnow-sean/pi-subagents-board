import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearRunSnapshotCache,
  describeSteerFailure,
  isReviveNoise,
  normalizeSteering,
  readRunSnapshot,
  resolveRunTitle,
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
