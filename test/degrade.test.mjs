import assert from 'node:assert/strict'
import test from 'node:test'

import { describeDegrade, formatAge } from '../lib/degrade.mjs'

const NOW = 1_700_000_000_000
const ALIVE = { alive: true, ageMs: 500, updatedAt: NOW - 500 }

function source(overrides = {}) {
  return {
    rpc: true,
    mode: 'push',
    handshake: { attempts: 1, ready: true, ping: true, at: NOW, lastError: null },
    lastReplyAt: NOW,
    lastError: null,
    ...overrides,
  }
}

test('没有状态文件 → no-data', () => {
  const result = describeDegrade(null, { alive: false, ageMs: null }, NOW)
  assert.equal(result.kind, 'no-data')
  assert.match(result.detail, /派过子代理/)
})

test('RPC 没连上 → rpc-unavailable，带上尝试次数与错误', () => {
  const state = { source: source({ rpc: false, mode: 'none', handshake: { attempts: 4, ready: false, ping: false, lastError: 'ping 无回复' } }) }
  const result = describeDegrade(state, ALIVE, NOW)
  assert.equal(result.kind, 'rpc-unavailable')
  assert.match(result.detail, /4 次/)
  assert.match(result.detail, /pi-subagents/)
  assert.match(result.detail, /ping 无回复/)
})

test('心跳过期 → stale，并说明最后一次更新在多久前', () => {
  const result = describeDegrade({ source: source() }, { alive: false, ageMs: 90_000, updatedAt: NOW - 90_000 }, NOW)
  assert.equal(result.kind, 'stale')
  assert.match(result.detail, /1 分钟/)
})

test('轮询模式 → poll，文案说明「慢一拍」', () => {
  const result = describeDegrade({ source: source({ mode: 'poll' }) }, ALIVE, NOW)
  assert.equal(result.kind, 'poll')
  assert.match(result.detail, /2 秒/)
})

test('一切正常 → ok', () => {
  const result = describeDegrade({ source: source() }, ALIVE, NOW)
  assert.equal(result.kind, 'ok')
})

test('formatAge: 秒 / 分钟 / 小时 / 天', () => {
  assert.equal(formatAge(300), '刚刚')
  assert.equal(formatAge(5_000), '5 秒')
  assert.equal(formatAge(120_000), '2 分钟')
  assert.equal(formatAge(3 * 3600_000), '3 小时')
  assert.equal(formatAge(2 * 24 * 3600_000), '2 天')
})
