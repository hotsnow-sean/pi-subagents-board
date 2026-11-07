import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CMD_TTL_MS,
  buildCommand,
  buildResult,
  commandFileName,
  isExpired,
  normalizeReceipt,
  parseCommandFileName,
} from '../lib/cmd-queue.mjs'

const NOW = 1_700_000_000_000

test('buildCommand: steer 需要 runId / sessionKey / 非空 message', () => {
  const ok = buildCommand({ action: 'steer', runId: 'run-1', sessionKey: 'abc', message: '  换个方向  ' }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.command.message, '换个方向', '两端空白要修掉')
  assert.equal(ok.command.mode, 'steer', '默认立刻插话')
  assert.equal(ok.command.createdAt, NOW)

  assert.equal(buildCommand({ action: 'steer', sessionKey: 'abc', message: 'x' }, NOW).ok, false)
  assert.equal(buildCommand({ action: 'steer', runId: 'r', message: 'x' }, NOW).ok, false)
  assert.equal(buildCommand({ action: 'steer', runId: 'r', sessionKey: 'abc', message: '   ' }, NOW).ok, false)
  assert.equal(buildCommand({ action: 'steer', runId: 'r', sessionKey: 'abc', message: 'x'.repeat(8_001) }, NOW).ok, false)
})

test('buildCommand: 只接受已知 action 与 mode（UI 的参数一律当不可信输入）', () => {
  assert.equal(buildCommand({ action: 'spawn', runId: 'r', sessionKey: 'a' }, NOW).ok, false)
  assert.equal(buildCommand({}, NOW).ok, false)
  const badMode = buildCommand({ action: 'steer', runId: 'r', sessionKey: 'a', message: 'x', mode: 'shout' }, NOW)
  assert.equal(badMode.ok, false)
  assert.match(badMode.error, /mode/)
})

test('buildCommand: stop 不需要 message；index 只接受非负有限数', () => {
  const stop = buildCommand({ action: 'stop', runId: 'run-1', sessionKey: 'abc' }, NOW)
  assert.equal(stop.ok, true)
  assert.equal('message' in stop.command, false)

  const withIndex = buildCommand({ action: 'stop', runId: 'run-1', sessionKey: 'abc', index: 2 }, NOW)
  assert.equal(withIndex.command.index, 2)
  assert.equal(buildCommand({ action: 'stop', runId: 'run-1', sessionKey: 'abc', index: -1 }, NOW).ok, false)
  // 非数字的 index 直接丢掉，而不是拼成 NaN 发到 RPC
  assert.equal('index' in buildCommand({ action: 'stop', runId: 'run-1', sessionKey: 'abc', index: 'x' }, NOW).command, false)
})

test('命令文件名：sessionKey 前缀可解析回来（多会话共用一个目录靠它分流）', () => {
  const name = commandFileName('57f246053edc', 'abc-1-def')
  assert.equal(name, '57f246053edc--abc-1-def.json')
  assert.deepEqual(parseCommandFileName(name), { sessionKey: '57f246053edc', id: 'abc-1-def' })
  assert.equal(parseCommandFileName('garbage.json'), null)
})

test('normalizeReceipt: delivered 与 queued 不合并（queued ≠ 已读到）', () => {
  const queued = normalizeReceipt('steer', { deliveryStatus: 'queued', state: 'pending', targets: [{ index: 0, state: 'pending' }] })
  assert.equal(queued.deliveryStatus, 'queued')
  assert.deepEqual(queued.targets, [{ index: 0, state: 'pending' }])

  const delivered = normalizeReceipt('steer', { deliveryStatus: 'delivered' })
  assert.equal(delivered.deliveryStatus, 'delivered')

  // 扩展没给状态时留空串，UI 才能说「别当作它已经看到」而不是假装成功
  assert.equal(normalizeReceipt('steer', null).deliveryStatus, '')
  // stop 的回执只带 state（stopping 是受理，不是终止）
  assert.equal(normalizeReceipt('stop', { state: 'stopping' }).state, 'stopping')
})

test('buildResult: 失败时保留 error，成功时 receipt 归好', () => {
  const command = { id: 'id-1', action: 'steer', runId: 'run-1' }
  const ok = buildResult(command, { ok: true, data: { deliveryStatus: 'queued' } }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.receipt.deliveryStatus, 'queued')
  assert.equal(ok.error, null)

  const failed = buildResult(command, { ok: false, error: { code: 'not_found', message: 'no such run' } }, NOW)
  assert.equal(failed.ok, false)
  assert.equal(failed.receipt, null)
  assert.equal(failed.error.code, 'not_found')

  const timedOut = buildResult(command, { ok: false, timedOut: true, error: { code: 'timeout' } }, NOW)
  assert.equal(timedOut.timedOut, true)
})

test('isExpired: 未认领的命令超时作废（陈旧命令不能被执行）', () => {
  assert.equal(isExpired({ createdAt: NOW }, NOW + 1_000), false)
  assert.equal(isExpired({ createdAt: NOW }, NOW + CMD_TTL_MS + 1), true)
  assert.equal(isExpired({ createdAt: NOW }, NOW + 5_001, 5_000), true, 'agent 侧用 UI 的同款窗口')
  assert.equal(isExpired({}, NOW), true, '没有 createdAt 的一律当过期')
})
