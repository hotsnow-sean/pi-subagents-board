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
