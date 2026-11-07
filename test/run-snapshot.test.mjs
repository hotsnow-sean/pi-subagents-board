import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearRunSnapshotCache,
  describeSteerFailure,
  normalizeSteering,
  readRunSnapshot,
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

test('readRunSnapshot: 缺文件 / 空路径 / 坏 JSON / 超大文件 → null，不抛', () => {
  clearRunSnapshotCache()
  assert.equal(readRunSnapshot(''), null)
  assert.equal(readRunSnapshot(null), null)
  assert.equal(readRunSnapshot(path.join(os.tmpdir(), 'board-nope-does-not-exist')), null)

  const broken = tmpRunDir({ 'status.json': '{ not json' })
  assert.equal(readRunSnapshot(broken), null)

  const huge = tmpRunDir({ 'status.json': JSON.stringify({ pad: 'x'.repeat(600 * 1024) }) })
  assert.equal(readRunSnapshot(huge), null, 'workflow 大 run 的文件不值得读')
})
