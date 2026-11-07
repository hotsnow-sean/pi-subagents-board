import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { applyComplete, applyStarted, createState } from '../lib/lineage.mjs'
import { ensureLiveDir, liveFileOf, writeJsonAtomic } from '../lib/live-store.mjs'
import { sessionKeyOf } from '../lib/session-key.mjs'

/**
 * main.mjs 是插件入口，正常由宿主 import。测试里直接 import 一次即可——
 * 它只依赖 lib/ 与 node 内置模块，没有宿主运行时。每次 activate 前用不同的
 * dataDir，互不干扰。
 */
const entry = pathToFileURL(path.join(import.meta.dirname, '..', 'main.mjs')).href

async function loadMain() {
  const mod = await import(entry)
  return mod
}

function fakeCtx(dataDir) {
  const logs = []
  return { pluginId: 'subagents-board', dataDir, log: (...args) => logs.push(args.join(' ')), logs }
}

function seedLive(dataDir, sessionFile) {
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 999, startedAt })
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w', asyncDir: 'C:/tmp/a' }, startedAt + 100)
  state.source.rpc = true
  state.source.mode = 'push'
  state.source.capabilities = ['steer', 'stop']
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 999, startedAt }), state)
  return { sessionKey, startedAt }
}

test('getState: 没有会话时给出可渲染的 no-session，而不是空对象', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const state = await api.invoke('getState', { sessionFile: '' })
  assert.equal(state.ok, true)
  assert.equal(state.degrade.kind, 'no-session')
  assert.deepEqual(state.lineages, [])
})

test('getState: 读到 live 文件并组装出链、活跃数与降级判定', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'a.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const state = await api.invoke('getState', { sessionFile })

  assert.equal(state.sessionKey, sessionKey)
  assert.equal(state.lineages.length, 1)
  assert.equal(state.lineages[0].segments[0].runId, 'run-1')
  assert.equal(state.activeCount, 1)
  assert.equal(state.degrade.kind, 'ok')
  assert.equal(state.source.mode, 'push')
  assert.ok(state.dataFile.endsWith('.json'))
})

test('getState: 心跳过期时 degrade 变 stale，数据照常返回', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'b.jsonl')
  seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  // 把 updatedAt 改到 2 分钟前，模拟 worker 已退出
  const live = path.join(dataDir, 'live')
  for (const name of fs.readdirSync(live)) {
    const file = path.join(live, name)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.updatedAt = Date.now() - 120_000
    fs.writeFileSync(file, JSON.stringify(parsed))
  }
  const state = await api.invoke('getState', { sessionFile })
  assert.equal(state.degrade.kind, 'stale')
  assert.equal(state.liveness.alive, false)
  assert.equal(state.lineages.length, 1, '陈旧也要把最后一次快照给出去')
})

test('getDiagnostics: 给出数据文件与原始状态', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'c.jsonl')
  seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const diag = await api.invoke('getDiagnostics', { sessionFile })
  assert.equal(diag.ok, true)
  assert.ok(diag.dataFile.endsWith('.json'))
  assert.equal(diag.state.sessionKey, sessionKeyOf(sessionFile))
  assert.equal((await api.invoke('getDiagnostics', {})).ok, false)
})

test('activate: 启动时清理过期 live 文件', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const live = ensureLiveDir(dataDir)
  const old = path.join(live, 'k-1-1.json')
  writeJsonAtomic(old, { sessionKey: 'k', startedAt: 1 })
  const stale = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
  fs.utimesSync(old, stale, stale)
  const mod = await loadMain()
  await mod.activate(fakeCtx(dataDir))
  assert.equal(fs.existsSync(old), false)
})

test('未知方法抛错（不是静默 undefined）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  await assert.rejects(() => api.invoke('nope', {}), /unknown method/)
})
