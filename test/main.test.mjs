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

/** 轮询等一个条件（命令是跨目录的异步投递，固定 sleep 会 flaky） */
async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

function fakeCtx(dataDir, opts = {}) {
  const logs = []
  /** @type {any[]} */
  const inbox = []
  const reveal = opts.reveal ?? (async () => true)
  const activate = opts.activate
  return {
    pluginId: 'subagents-board',
    dataDir,
    log: (...args) => logs.push(args.join(' ')),
    logs,
    inbox,
    ui: { inbox: (/** @type {any} */ item) => inbox.push(item) },
    sessions: {
      reveal: (/** @type {string} */ file) => reveal(file),
      ...(activate ? { activate: (/** @type {string} */ file) => activate(file) } : {}),
    },
  }
}

function seedLive(dataDir, sessionFile) {
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 999, startedAt })
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w', asyncDir: 'C:/tmp/a' }, startedAt + 100)
  state.source.rpc = true
  state.source.mode = 'push'
  state.source.capabilities = ['steer', 'stop']
  state.source.supports = { steer: true, stop: true }
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

test('openSession: 走宿主 sessions.reveal，路径非法/不存在时回 ok:false 而不是抛错', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const mod = await loadMain()

  /** @type {string[]} */
  const calls = []
  const api = await mod.activate(fakeCtx(dataDir, { reveal: async (file) => (calls.push(file), true) }))
  const ok = await api.invoke('openSession', { sessionFile: 'C:/sessions/child/session.jsonl' })
  assert.equal(ok.ok, true)
  assert.deepEqual(calls, ['C:/sessions/child/session.jsonl'])

  // 宿主说「路径不可用」（文件被清理）：透传成 ok:false，不抛错
  const mod2 = await loadMain()
  const api2 = await mod2.activate(fakeCtx(dataDir, { reveal: async () => false }))
  const gone = await api2.invoke('openSession', { sessionFile: 'C:/sessions/gone/session.jsonl' })
  assert.equal(gone.ok, false)

  // 空路径直接拒绝，不该白调宿主
  const empty = await api2.invoke('openSession', {})
  assert.equal(empty.ok, false)
  assert.match(empty.error, /sessionFile/)
})

test('openSession: 优先走 activate（主会话可写激活），没有 activate 才回落 reveal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const mod = await loadMain()

  /** @type {string[]} */
  const activated = []
  const api = await mod.activate(fakeCtx(dataDir, { activate: async (file) => (activated.push(file), true) }))
  const ok = await api.invoke('openSession', { sessionFile: 'C:/sessions/parent.jsonl' })
  assert.equal(ok.ok, true)
  assert.deepEqual(activated, ['C:/sessions/parent.jsonl'], '有 activate 必须用它（「返回主会话」要拿到可写对话）')

  // 旧宿主没有 activate：回落 reveal
  const mod2 = await loadMain()
  const ctx2 = fakeCtx(dataDir)
  const api2 = await mod2.activate(ctx2)
  const fallback = await api2.invoke('openSession', { sessionFile: 'C:/sessions/child/session.jsonl' })
  assert.equal(fallback.ok, true)
})

test('getState: 预览子会话时反查出父会话链与 parentSessionFile（「返回主会话」的落点）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const parentFile = path.join(dataDir, 'sessions', 'parent.jsonl')
  const sessionKey = sessionKeyOf(parentFile)
  const childFile = path.join(dataDir, 'sessions', 'parent', 'run-1', 'run-0', 'session.jsonl')
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile: parentFile, pid: 31, startedAt })
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w' }, startedAt + 100)
  applyComplete(
    state,
    { id: 'run-1', state: 'complete', success: true, timestamp: startedAt + 2_000, sessionFile: childFile, summary: 'done' },
    startedAt + 2_000,
  )
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 31, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  // 用子会话路径查询（等价于用户正在预览它）：拿到的应当是父会话的链
  const view = await api.invoke('getState', { sessionFile: childFile })
  assert.equal(view.parentSessionFile, parentFile)
  assert.equal(view.lineages.length, 1)
  assert.equal(view.lineages[0].segments[0].runId, 'run-1')
  // 主会话本身没有 parentSessionFile
  const own = await api.invoke('getState', { sessionFile: parentFile })
  assert.equal(own.parentSessionFile, '')
  assert.equal(own.lineages.length, 1)
})

test('信箱: 激活时只通知「刚结束」的 run，历史终态段记进台账不重播', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'd.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 60_000
  const state = createState({ sessionKey, sessionFile, pid: 7, startedAt })
  const now = Date.now()
  applyStarted(state, { id: 'run-fresh', agent: 'worker' }, now - 20_000)
  applyComplete(
    state,
    { id: 'run-fresh', state: 'complete', success: true, timestamp: now - 5_000, durationMs: 15_000, summary: '八轮跑完', sessionFile: 'C:/sessions/child/session.jsonl' },
    now - 5_000,
  )
  applyStarted(state, { id: 'run-old', agent: 'reviewer' }, now - 50_000)
  applyComplete(state, { id: 'run-old', state: 'complete', success: true, timestamp: now - 300_000, durationMs: 1_000 }, now - 300_000)
  state.updatedAt = now
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 7, startedAt }), state)

  const mod = await loadMain()
  const ctx = fakeCtx(dataDir)
  await mod.activate(ctx)

  assert.equal(ctx.inbox.length, 1, '只有 5 秒前结束的那次该通知')
  const item = ctx.inbox[0]
  assert.equal(item.title, 'worker 已完成')
  assert.equal(item.tone, 'success')
  assert.equal(item.sessionFile, sessionFile, '点开要回到产出它的会话')
  assert.deepEqual(item.target, { pluginId: 'subagents-board', panelId: 'fleet' })
  assert.match(item.body, /耗时 0:15/)
  assert.match(item.body, /八轮跑完/)

  // 台账落盘：再激活一次（等价于重启）不会重复通知
  const ctx2 = fakeCtx(dataDir)
  await mod.activate(ctx2)
  assert.equal(ctx2.inbox.length, 0, '已通知过的 run 不许重播')
  assert.ok(fs.existsSync(path.join(dataDir, 'notified.json')))
})

test('干预能力：canSteer / canStop 跟着段状态与扩展能力走（UI 照着置灰，不是点了才报错）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'cap.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))

  const running = await api.invoke('getState', { sessionFile })
  assert.equal(running.lineages[0].segments[0].canSteer, true)
  assert.equal(running.lineages[0].segments[0].canStop, true)

  // 终态段不能干预（child-scoped stop 对已终态目标会报错，先置灰）
  const live = path.join(dataDir, 'live')
  for (const name of fs.readdirSync(live)) {
    const file = path.join(live, name)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.lineages[0].segments[0].state = 'complete'
    fs.writeFileSync(file, JSON.stringify(parsed))
  }
  const done = await api.invoke('getState', { sessionFile })
  assert.equal(done.lineages[0].segments[0].canSteer, false)
  assert.equal(done.lineages[0].segments[0].canStop, false)

  // 老版本扩展没有 steer / stop 能力：整体置灰
  for (const name of fs.readdirSync(live)) {
    const file = path.join(live, name)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.lineages[0].segments[0].state = 'running'
    parsed.source.supports = { steer: false, stop: false }
    fs.writeFileSync(file, JSON.stringify(parsed))
  }
  const unsupported = await api.invoke('getState', { sessionFile })
  assert.equal(unsupported.lineages[0].segments[0].canSteer, false)
  assert.equal(unsupported.lineages[0].segments[0].canStop, false)
  assert.equal(sessionKey, sessionKeyOf(sessionFile))
})

test('note: 写进 inbox/<sessionKey>/（一消息一文件），立刻返回 id，不等回执', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'e.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))

  // 不等回执是这里最重要的一条：P2-c 要轮询 5s，超时就撤回，于是出现
  // 「面板说没送达、几秒后子代理却真被插了话」。现在返回即完成。
  const startedAt = Date.now()
  const result = await api.invoke('note', {
    sessionKey,
    runId: 'run-1',
    agent: 'code-reviewer',
    message: ' 换个方向 ',
  })
  assert.ok(Date.now() - startedAt < 1_000, '投递不能被等待阻塞')
  assert.equal(result.ok, true)
  assert.ok(result.id, '要返回 id，UI 靠它在回执里找自己那条')
  assert.ok(result.expiresAt > Date.now(), '要告诉 UI 这条什么时候作废')

  const dir = path.join(dataDir, 'inbox', sessionKey)
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.equal(names.length, 1, '一消息一文件，不做追加')
  const note = JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8'))
  assert.equal(note.id, result.id)
  assert.equal(note.kind, 'note')
  assert.equal(note.message, '换个方向', '两端空白要修掉')
  assert.equal(note.runId, 'run-1')
  assert.equal(note.agent, 'code-reviewer')
  assert.equal(note.sessionKey, sessionKey, '文件名用 sessionKey 分目录，body 里也要留一份')
})

test('stop: 只给 runId 就够（停止是生命周期控制，不需要正文）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'stop.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))

  const result = await api.invoke('stop', { sessionKey, runId: 'run-2' })
  assert.equal(result.ok, true)
  const dir = path.join(dataDir, 'inbox', sessionKey)
  const note = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'))
  assert.equal(note.kind, 'stop')
  assert.equal(note.runId, 'run-2')
  assert.equal(note.message, undefined)
})

test('note / stop: 参数不合格直接拒，一个字都不落盘', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'bad.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))

  const blank = await api.invoke('note', { sessionKey, runId: 'run-1', message: '   ' })
  assert.equal(blank.ok, false)
  assert.equal(blank.error.code, 'bad_request')
  assert.match(blank.error.message, /说点什么/)

  const noKey = await api.invoke('note', { message: 'x' })
  assert.equal(noKey.ok, false)

  const tooLong = await api.invoke('note', { sessionKey, message: 'x'.repeat(4_001) })
  assert.equal(tooLong.ok, false)

  const stopNoRun = await api.invoke('stop', { sessionKey })
  assert.equal(stopNoRun.ok, false, 'stop 没有 runId 无从停起')

  const dir = path.join(dataDir, 'inbox', sessionKey)
  const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : []
  assert.deepEqual(leftovers, [], '被拒的留言不能留在盘上等某个 agent 投出去')
})

test('getState: 带回本会话最近的回执（倒序），别的会话不混进来', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'm.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  const receipts = path.join(dataDir, 'receipts')
  fs.mkdirSync(receipts, { recursive: true })
  const write = (id, body) => fs.writeFileSync(path.join(receipts, `${id}.json`), JSON.stringify({ id, ...body }))
  write('a1', { at: 1_000, sessionKey, kind: 'note', runId: 'run-1', state: 'accepted', ok: true })
  write('a2', { at: 2_000, sessionKey, kind: 'stop', runId: 'run-2', state: 'stopping', ok: true })
  write('other', { at: 3_000, sessionKey: 'someone-else', kind: 'note', runId: 'run-9', state: 'accepted', ok: true })

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const state = await api.invoke('getState', { sessionFile })
  assert.deepEqual(state.mail.map((item) => item.id), ['a2', 'a1'], '按时间倒序，且只留本会话的')
  assert.equal(state.mail[0].state, 'stopping')
})

test('activate: 清理隔夜的留言与回执（昨天留的言不该在开机时突然起一轮）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const inboxDir = path.join(dataDir, 'inbox', 'abcdef123456')
  const receipts = path.join(dataDir, 'receipts')
  fs.mkdirSync(inboxDir, { recursive: true })
  fs.mkdirSync(receipts, { recursive: true })
  const oldNote = path.join(inboxDir, 'old-1.json')
  const oldReceipt = path.join(receipts, 'old-1.json')
  fs.writeFileSync(oldNote, JSON.stringify({ id: 'old-1', kind: 'note', sessionKey: 'abcdef123456', createdAt: 1, message: 'x' }))
  fs.writeFileSync(oldReceipt, JSON.stringify({ id: 'old-1', state: 'accepted' }))
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000)
  fs.utimesSync(oldNote, past, past)
  fs.utimesSync(oldReceipt, past, past)

  const mod = await loadMain()
  await mod.activate(fakeCtx(dataDir))
  assert.equal(fs.existsSync(oldNote), false)
  assert.equal(fs.existsSync(oldReceipt), false)
})
