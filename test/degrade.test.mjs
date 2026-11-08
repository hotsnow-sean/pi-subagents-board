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
  // 空态标记：没派过子代理是正常状态，面板该画虚线占位而不是警示横幅
  assert.equal(result.asEmpty, true)
  assert.match(result.detail, /派过子代理/)
  // 诊断提示单独一行（断行用），不挤进主说明
  assert.match(result.hint, /worker/)
  assert.doesNotMatch(result.detail, /worker/)
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

test('只剩归档（livePartitions: 0）→ archived：不报警，也不占一行横幅', () => {
  // 归档里没有 source（装订时不会伪造实例的运行时能力），心跳也是装订时刻而不是真的心跳。
  // 拿它判「连没连上 pi-subagents」会得到一句假警报——用户只是打开旧会话看历史。
  const archivedState = { lineages: [{ segments: [{ runId: 'run-1', state: 'stopped' }] }] }
  const result = describeDegrade(archivedState, { alive: false, ageMs: 3_600_000 }, NOW, { livePartitions: 0 })
  assert.equal(result.kind, 'archived')
  assert.equal(result.title, '', '渲染层按「有没有标题」决定画不画横幅')
})

test('有活跃分区但没有 source → 仍是 rpc-unavailable（这条不能一起被放过）', () => {
  const result = describeDegrade({ lineages: [] }, ALIVE, NOW, { livePartitions: 1 })
  assert.equal(result.kind, 'rpc-unavailable')
  // 不传 livePartitions 的老调用方行为不变
  assert.equal(describeDegrade({ lineages: [] }, ALIVE, NOW).kind, 'rpc-unavailable')
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
