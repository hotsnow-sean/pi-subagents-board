import assert from 'node:assert/strict'
import test from 'node:test'

import { buildInboxItem, ledgerKey, pruneLedgerAgainst, seedLedger, selectNewCompletions } from '../lib/inbox-watch.mjs'
import { TERMINAL_STATES } from '../lib/lineage.mjs'

const NOW = 1_700_000_000_000

/** @param {any[]} segments */
function fileOf(segments, sessionKey = 'sess-a') {
  return { file: 'C:/x.json', mtimeMs: NOW, state: { sessionKey, sessionFile: 'C:/sessions/a.jsonl', lineages: [{ agent: 'worker', segments }] } }
}

function seg(runId, state, endedAt) {
  return { runId, state, endedAt, startedAt: endedAt - 1_000, durationMs: 1_000 }
}

test('selectNewCompletions: 只挑终态、跳过未知会话、跳过台账里的', () => {
  const files = [
    fileOf([seg('r1', 'complete', NOW), seg('r2', 'running', 0), seg('r3', 'failed', NOW)]),
    fileOf([seg('r4', 'complete', NOW)], 'unknown'),
  ]
  const out = selectNewCompletions(files, { [ledgerKey('sess-a', 'r1')]: NOW }, TERMINAL_STATES)
  assert.deepEqual(
    out.map((entry) => entry.segment.runId),
    ['r3'],
  )
})

test('selectNewCompletions: 按结束时间升序（早的先通知）', () => {
  const files = [fileOf([seg('late', 'complete', NOW), seg('early', 'complete', NOW - 60_000)])]
  const out = selectNewCompletions(files, {}, TERMINAL_STATES)
  assert.deepEqual(
    out.map((entry) => entry.segment.runId),
    ['early', 'late'],
  )
})

test('seedLedger: 只把「超过宽限期」的历史段记账，返回新增条数', () => {
  const segments = [seg('old', 'complete', NOW - 300_000), seg('fresh', 'complete', NOW - 5_000)]
  const ledger = {}
  const added = seedLedger([fileOf(segments)], ledger, NOW, TERMINAL_STATES)
  assert.equal(added, 1)
  assert.ok(ledger[ledgerKey('sess-a', 'old')])
  assert.equal(ledger[ledgerKey('sess-a', 'fresh')], undefined, '刚结束的留着发通知')
})

test('seedLedger: 已在台账里的不重复记账', () => {
  const ledger = { [ledgerKey('sess-a', 'old')]: 1 }
  const added = seedLedger([fileOf([seg('old', 'complete', NOW - 300_000)])], ledger, NOW, TERMINAL_STATES)
  assert.equal(added, 0)
})

test('buildInboxItem: 标题一行、正文带耗时与摘要、观感按状态', () => {
  const entry = {
    sessionKey: 'sess-a',
    sessionFile: 'C:/sessions/a.jsonl',
    key: 'sess-a|r1',
    lineage: { agent: 'worker' },
    segment: { runId: 'r1', state: 'complete', startedAt: NOW - 64_000, endedAt: NOW, durationMs: 64_000, tokens: { total: 4769 }, summary: '已完成：\n8 轮循环' },
  }
  const item = buildInboxItem(entry, 'subagents-board', 'fleet')
  assert.equal(item.title, 'worker 已完成')
  assert.equal(item.tone, 'success')
  assert.equal(item.body, '耗时 1:04 · 4769 tok · 已完成： 8 轮循环')
  assert.equal(item.sessionFile, 'C:/sessions/a.jsonl')
  assert.deepEqual(item.target, { pluginId: 'subagents-board', panelId: 'fleet' })
  assert.equal(item.dedupeKey, 'sess-a|r1')
})

test('buildInboxItem: 失败/停止用 error/warn，摘要截断到 120 字', () => {
  const long = 'x'.repeat(400)
  const failed = buildInboxItem(
    { key: 'k', sessionFile: '', lineage: {}, segment: { runId: 'r', state: 'failed', summary: long } },
    'p',
    'fleet',
  )
  assert.equal(failed.tone, 'error')
  assert.equal(failed.title, '子代理 失败')
  assert.equal(failed.body.length, 120)
  assert.equal(failed.sessionFile, undefined, '没有会话路径时不要塞空串')

  const stopped = buildInboxItem({ key: 'k2', sessionFile: '', lineage: { agent: 'w' }, segment: { runId: 'r2', state: 'stopped' } }, 'p', 'fleet')
  assert.equal(stopped.tone, 'warn')
  assert.equal(stopped.body, undefined)
})

test('selectNewCompletions: lost（进程已死、被判中断）也要通知', () => {
  const files = [fileOf([seg('dead', 'lost', NOW)])]
  const out = selectNewCompletions(files, {}, TERMINAL_STATES)
  assert.deepEqual(
    out.map((entry) => entry.segment.runId),
    ['dead'],
    '终态集合只有一份，少了 lost 就等于「子代理丢了却不告诉用户」',
  )
})

test('pruneLedgerAgainst: 只删 live 里已经不存在的段，与通知时间无关', () => {
  const ledger = {
    [ledgerKey('sess-a', 'kept')]: NOW - 400 * 24 * 60 * 60 * 1000,
    [ledgerKey('sess-a', 'gone')]: NOW - 1_000,
    'sess-a|bad-stamp': NaN,
  }
  const removed = pruneLedgerAgainst(ledger, new Set([ledgerKey('sess-a', 'kept')]))
  assert.equal(removed, 2)
  assert.deepEqual(Object.keys(ledger), [ledgerKey('sess-a', 'kept')], '段还在就必须留着，否则会重复通知')
})
