import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { applyComplete, applyStarted, createState } from '../lib/lineage.mjs'
import {
  ARCHIVE_IDLE_MS,
  archiveFileOf,
  archiveSessions,
  ensureLiveDir,
  liveFileOf,
  readIndex,
  readLiveFiles,
  writeJsonAtomic,
} from '../lib/live-store.mjs'
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

/**
 * live 下所有状态文件（分区 + 归档，**不含索引**）。
 * 0.11.0 起按会话分目录，测试里要改 updatedAt / mtime 的用例得递归找。
 * @param {string} dataDir
 */
function liveFilesOf(dataDir) {
  /** @type {string[]} */
  const out = []
  const walk = (/** @type {string} */ dir) => {
    /** @type {fs.Dirent[]} */
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json') && entry.name !== 'index.json') out.push(full)
    }
  }
  walk(path.join(dataDir, 'live'))
  return out
}

test('getState: 没有会话时给出可渲染的 no-session，而不是空对象', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const state = await api.invoke('getState', { sessionFile: '' })
  assert.equal(state.ok, true)
  assert.equal(state.degrade.kind, 'no-session')
  // 空态而非警示：渲染层据此画虚线框，而不是左侧带色条的横幅
  assert.equal(state.degrade.asEmpty, true)
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
  for (const file of liveFilesOf(dataDir)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.updatedAt = Date.now() - 120_000
    fs.writeFileSync(file, JSON.stringify(parsed))
  }
  const state = await api.invoke('getState', { sessionFile })
  assert.equal(state.degrade.kind, 'stale')
  assert.equal(state.liveness.alive, false)
  assert.equal(state.lineages.length, 1, '陈旧也要把最后一次快照给出去')
})

test('getState: 打开目标按候选顺序取第一个真实存在的，全不在则置灰（P8）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'open.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 7, startedAt })
  const a = applyStarted(state, { id: 'run-a', agent: 'worker', cwd: 'C:/w' }, startedAt + 100)
  const b = applyStarted(state, { id: 'run-b', agent: 'worker', cwd: 'C:/w' }, startedAt + 200)
  const c = applyStarted(state, { id: 'run-c', agent: 'worker', cwd: 'C:/w' }, startedAt + 300)
  // 旧落盘文件（0.7.0 及以前）没有 openCandidates，只有 childSessionFile
  const d = applyStarted(state, { id: 'run-d', agent: 'worker', cwd: 'C:/w' }, startedAt + 400)

  const realA = path.join(dataDir, 'child-a.jsonl')
  const realD = path.join(dataDir, 'child-d.jsonl')
  fs.writeFileSync(realA, '{}')
  fs.writeFileSync(realD, '{}')
  // 实测形状：childSessionFile 悬空，真实路径排在候选后面
  a.segment.openCandidates = [path.join(dataDir, 'gone.jsonl'), realA]
  b.segment.openCandidates = [path.join(dataDir, 'gone.jsonl')]
  c.segment.openCandidates = []
  d.segment.childSessionFile = realD

  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 7, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile })
  const byId = Object.fromEntries(got.lineages.flatMap((lineage) => lineage.segments).map((seg) => [seg.runId, seg]))

  assert.equal(byId['run-a'].openTarget, realA, '第一个悬空就往下找，不能短路')
  assert.equal(byId['run-a'].openState, 'ok')
  assert.equal(byId['run-b'].openTarget, '')
  assert.equal(byId['run-b'].openState, 'missing', '有候选但都不在 = 会话被清理，按钮置灰')
  assert.equal(byId['run-c'].openState, 'none', '本来就没有会话 = 不出按钮')
  assert.equal(byId['run-d'].openTarget, realD, '旧落盘文件没有 openCandidates，也要能打开')
  assert.equal(byId['run-d'].openState, 'ok')
})

test('getState: workflow 容器不抢占子步骤的会话（openState=shared）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'wf.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 9, startedAt })
  const step = applyStarted(state, { id: 'run-step', agent: 'worker', cwd: 'C:/w' }, startedAt + 100)
  const container = applyStarted(state, { id: 'run-wf', agent: 'workflow', cwd: 'C:/w' }, startedAt + 200)

  // 实测形状（8a08d1b2 / 370599a9）：容器的 childSessionFile 是猜出来的
  // `run-0/session.jsonl`，那个路径不存在；候选链落到 steps[0].sessionFile，
  // 而它正是那一步自己的会话，那一步另有一张卡。
  const stepSession = path.join(dataDir, 'step-session.jsonl')
  fs.writeFileSync(stepSession, '{}')
  step.segment.childSessionFile = stepSession
  const dangling = path.join(dataDir, 'wf', 'run-0', 'session.jsonl')
  container.segment.childSessionFile = dangling
  container.segment.openCandidates = [dangling, stepSession]

  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 9, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile })
  const byId = Object.fromEntries(got.lineages.flatMap((lineage) => lineage.segments).map((seg) => [seg.runId, seg]))

  assert.equal(byId['run-step'].openState, 'ok', '会话是那一步自己的，入口归它')
  assert.equal(byId['run-wf'].openState, 'shared', '容器没有自己的会话，别给第二个通向同一处的入口')
  assert.equal(byId['run-wf'].openOwnerRunId, 'run-step')
})

test('getState: 预览子会话时，你正看的那张卡标成 viewing 并给出返回落点', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'parent.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 11, startedAt })
  const a = applyStarted(state, { id: 'run-a', agent: 'worker', cwd: 'C:/w' }, startedAt + 100)
  const b = applyStarted(state, { id: 'run-b', agent: 'worker', cwd: 'C:/w' }, startedAt + 200)

  const child = path.join(dataDir, 'sessions', 'child.jsonl')
  const other = path.join(dataDir, 'sessions', 'other.jsonl')
  fs.mkdirSync(path.dirname(child), { recursive: true })
  fs.writeFileSync(child, '{}')
  fs.writeFileSync(other, '{}')
  a.segment.childSessionFile = child
  b.segment.childSessionFile = other

  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 11, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile: child })
  const byId = Object.fromEntries(got.lineages.flatMap((lineage) => lineage.segments).map((seg) => [seg.runId, seg]))

  assert.equal(got.parentSessionFile, sessionFile, '预览子会话时链属于父会话')
  assert.equal(byId['run-a'].viewing, true, '你眼前就是它的会话')
  assert.equal(byId['run-a'].viewBackTo, sessionFile, '「返回」回父会话')
  assert.equal(byId['run-b'].viewing, false, '别人的卡不受影响')

  // 回到主会话后不该再有任何卡自称被看
  const back = await api.invoke('getState', { sessionFile })
  const backById = Object.fromEntries(back.lineages.flatMap((lineage) => lineage.segments).map((seg) => [seg.runId, seg]))
  assert.equal(backById['run-a'].viewing, false)
  assert.equal(backById['run-a'].viewBackTo, '')
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
  for (const file of liveFilesOf(dataDir)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.lineages[0].segments[0].state = 'complete'
    fs.writeFileSync(file, JSON.stringify(parsed))
  }
  const done = await api.invoke('getState', { sessionFile })
  assert.equal(done.lineages[0].segments[0].canSteer, false)
  assert.equal(done.lineages[0].segments[0].canStop, false)

  // 老版本扩展没有 steer / stop 能力：整体置灰
  for (const file of liveFilesOf(dataDir)) {
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

test('getState: 排队回执会被事后核对——扩展说失败了就必须显示失败（P2′ 的「静默丢失」）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'rec.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-run-'))
  const startedAt = Date.now() - 5_000

  // run 自己的 status.json：steering 说「受理了但没投出去」
  fs.writeFileSync(
    path.join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'run-1',
      state: 'complete',
      steering: {
        requested: 2,
        delivered: 1,
        failed: 1,
        recent: [
          { id: 'req-ok', targets: [{ index: 0, state: 'delivered', deliveredAt: startedAt + 1_000 }] },
          { id: 'req-dead', targets: [{ index: 0, state: 'failed', reason: 'run became complete before steering request was consumed' }] },
        ],
      },
      steps: [{ agent: 'worker', sessionName: 'worker: 【核对】工作目录: C:/w', status: 'complete' }],
    }),
  )

  const state = createState({ sessionKey, sessionFile, pid: 55, startedAt })
  applyStarted(state, { id: 'run-1', agent: 'worker', cwd: 'C:/w', asyncDir }, startedAt + 100)
  state.source.rpc = true
  state.source.mode = 'push'
  state.source.supports = { steer: true, stop: true }
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 55, startedAt }), state)

  // agent 写下的回执只有「受理时」的状态（queued），requestId 是核对的钥匙
  const receipts = path.join(dataDir, 'receipts')
  fs.mkdirSync(receipts, { recursive: true })
  const writeReceipt = (id, body) => fs.writeFileSync(path.join(receipts, `${id}.json`), JSON.stringify({ id, ...body }))
  writeReceipt('dead', { at: 3_000, sessionKey, kind: 'note', runId: 'run-1', state: 'queued', ok: true, requestId: 'req-dead' })
  writeReceipt('ok', { at: 2_000, sessionKey, kind: 'note', runId: 'run-1', state: 'queued', ok: true, requestId: 'req-ok' })
  writeReceipt('keyless', { at: 1_000, sessionKey, kind: 'note', runId: 'run-1', state: 'queued', ok: true })

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const mail = (await api.invoke('getState', { sessionFile })).mail
  const byId = Object.fromEntries(mail.map((item) => [item.id, item]))

  assert.equal(byId.dead.state, 'failed', '事后核对发现失败，就不能继续挂着「已排队」')
  assert.equal(byId.dead.ok, false)
  assert.match(byId.dead.error, /刚好在这一刻结束了/, '失败原因要说人话')

  assert.equal(byId.ok.state, 'delivered', '核对到送达就升级成 delivered')

  assert.equal(byId.keyless.state, 'queued', '没有 requestId 就无从核对，保持原样（不猜）')
})

test('getState: workflow 容器认领各步骤的 run，并把子卡排在父卡后面', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'tree.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const containerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-wf-'))
  const stepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-step-'))

  // 容器的 status.json：`steps[].runId` 就是每一步那个 run——父子关系的事实来源
  fs.writeFileSync(
    path.join(containerDir, 'status.json'),
    JSON.stringify({
      runId: 'run-p',
      mode: 'workflow',
      state: 'complete',
      steps: [
        { runId: 'run-a', agent: 'delegate', label: '第一步-取数', status: 'complete' },
        { runId: 'run-b', agent: 'delegate', label: '第二步-乘法', status: 'running' },
      ],
    }),
  )
  // 步骤自己的快照：它是普通 delegate，label 属于它自己
  fs.writeFileSync(
    path.join(stepDir, 'status.json'),
    JSON.stringify({
      runId: 'run-a',
      mode: 'delegate',
      state: 'complete',
      steps: [{ agent: 'delegate', label: '第一步-取数', sessionName: 'delegate: 用 bash 执行 echo 7', status: 'complete' }],
    }),
  )

  const state = createState({ sessionKey, sessionFile, pid: 77, startedAt })
  // 故意让子卡先开始、父卡最后才开始：排序不该被事件到达顺序带偏
  applyStarted(state, { id: 'run-a', agent: 'delegate', cwd: 'C:/w', asyncDir: stepDir }, startedAt + 300)
  applyComplete(
    state,
    { id: 'run-a', state: 'complete', success: true, timestamp: startedAt + 900, durationMs: 600 },
    startedAt + 900,
  )
  applyStarted(state, { id: 'run-b', agent: 'delegate', cwd: 'C:/w' }, startedAt + 400)
  applyStarted(state, { id: 'run-p', agent: 'workflow', cwd: 'C:/w', asyncDir: containerDir }, startedAt + 100)
  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 77, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile })
  const order = got.lineages.map((lineage) => lineage.segments[lineage.segments.length - 1].runId)
  assert.deepEqual(order, ['run-p', 'run-a', 'run-b'], '父卡在前，两条子卡紧跟')

  const parent = got.lineages[0].segments[0]
  assert.deepEqual(parent.containerOf, ['run-a', 'run-b'])
  assert.equal(parent.containerDone, 1, '一步完成、一步还在跑')
  assert.equal(got.lineages[1].segments[0].stepOf, 'run-p')
  assert.equal(got.lineages[2].segments[0].stepOf, 'run-p')
})

test('getState: resume 段与源段共用同一份会话时，链尾照样有「打开」（openState=ok）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'resume.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 11, startedAt })
  const shared = path.join(dataDir, 'child', 'run-0', 'session.jsonl')
  fs.mkdirSync(path.dirname(shared), { recursive: true })
  fs.writeFileSync(shared, '{}')

  const first = applyStarted(state, { id: 'run-1', agent: 'delegate' }, startedAt + 100)
  first.segment.childSessionFile = shared
  applyComplete(
    state,
    { id: 'run-1', sessionFile: shared, state: 'complete', success: true, timestamp: startedAt + 1_000, durationMs: 900 },
    startedAt + 1_000,
  )
  // resume：新 runId，复用同一份子会话文件；complete 靠 sessionFile 接回原链
  applyStarted(state, { id: 'run-2', agent: 'delegate' }, startedAt + 2_000)
  applyComplete(
    state,
    { id: 'run-2', sessionFile: shared, state: 'complete', success: true, timestamp: startedAt + 3_000, durationMs: 1_000 },
    startedAt + 3_000,
  )
  assert.equal(state.lineages.length, 1, '先确认这两段已经在同一条链上')

  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 11, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile })
  const byId = Object.fromEntries(got.lineages.flatMap((lineage) => lineage.segments).map((seg) => [seg.runId, seg]))

  assert.equal(got.lineages.length, 1, 'resume 之后仍然只有一张卡')
  assert.equal(byId['run-2'].openState, 'ok', '同一条链共用的会话不是「别人的」，必须给入口')
  assert.equal(byId['run-2'].openShared, true, 'UI 要靠它说明「这几次共用一份会话」')
  assert.equal(byId['run-2'].openTarget, shared)
  assert.equal(byId['run-2'].revivedFrom, 'run-1')
})

test('getState: live 文件里的历史孤链会在读侧认回来源链（relinked）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'orphan.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 13, startedAt })
  applyStarted(state, { id: 'run-1', agent: 'worker' }, startedAt + 100)
  // 手工造出「resume 中途重启」留下的形状：段记着 revivedFrom，却自成一链
  const orphan = applyStarted(state, { id: 'run-2', agent: 'worker' }, startedAt + 200)
  const own = state.lineages.find((lineage) => lineage.lineageRoot === 'run-2')
  state.lineages = state.lineages.filter((lineage) => lineage !== own)
  const lonely = {
    lineageRoot: 'run-2',
    agent: 'worker',
    lastActivityAt: startedAt + 200,
    state: 'running',
    segments: [orphan.segment],
  }
  orphan.segment.revivedFrom = 'run-1'
  state.lineages.push(lonely)

  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 13, startedAt }), state)
  // 第二代也写一份（同样的孤链形状）：这样每轮 getState 都要跨代合并、重算一次接链，
  // 才能复现「搬完不落盘、下一轮再搬」的真实路径（单代会被读缓存挡住，看不出问题）。
  const state2 = createState({ sessionKey, sessionFile, pid: 16, startedAt: startedAt + 50 })
  applyStarted(state2, { id: 'run-1', agent: 'worker' }, startedAt + 100)
  const orphan2 = applyStarted(state2, { id: 'run-2', agent: 'worker' }, startedAt + 200)
  state2.lineages = state2.lineages.filter((lineage) => lineage.lineageRoot !== 'run-2')
  orphan2.segment.revivedFrom = 'run-1'
  state2.lineages.push({
    lineageRoot: 'run-2',
    agent: 'worker',
    lastActivityAt: startedAt + 200,
    state: 'running',
    segments: [orphan2.segment],
  })
  state2.source.rpc = true
  state2.source.mode = 'push'
  state2.updatedAt = Date.now()
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 16, startedAt: startedAt + 50 }), state2)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile })

  assert.equal(got.relinked, 1, '孤链应被并回来源链，只剩一张卡')
  assert.deepEqual(got.lineages[0].segments.map((segment) => segment.runId), ['run-1', 'run-2'])

  // 第二次读同一份数据：搬的还是同样那一段（live 文件没被改写），但**不能算新变化**。
  // 否则 `rev` 每轮都变 → 长轮询立刻返回 → 下一轮又搬 → 0 延迟死循环（实测刷爆日志）。
  const again = await api.invoke('getState', { sessionFile })
  assert.equal(again.lineages.length, 1)
  assert.equal(again.relinked, 1, '每轮都得搬（不搬这一帧就会多出一张卡）')
  assert.equal(again.rev, got.rev, '重复自愈不该推动版本戳')
})

test('getState: 自愈搬动的段集合变化时才推版本戳（新孤段要立刻可见）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'orphan2.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const state = createState({ sessionKey, sessionFile, pid: 14, startedAt })
  applyStarted(state, { id: 'run-1', agent: 'worker' }, startedAt + 100)
  const orphan = applyStarted(state, { id: 'run-2', agent: 'worker' }, startedAt + 200)
  state.lineages = state.lineages.filter((lineage) => lineage.lineageRoot !== 'run-2')
  orphan.segment.revivedFrom = 'run-1'
  state.lineages.push({
    lineageRoot: 'run-2',
    agent: 'worker',
    lastActivityAt: startedAt + 200,
    state: 'running',
    segments: [orphan.segment],
  })
  state.source.rpc = true
  state.source.mode = 'push'
  state.updatedAt = Date.now()
  ensureLiveDir(dataDir)
  const livePath = liveFileOf(dataDir, { sessionKey, pid: 14, startedAt })
  writeJsonAtomic(livePath, state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const first = await api.invoke('getState', { sessionFile })

  // 再来一段孤链（模拟又一次 resume 中途重启）：集合变了，版本戳必须前进
  const snapshot = JSON.parse(fs.readFileSync(livePath, 'utf8'))
  const state2 = createState({ sessionKey, sessionFile, pid: 14, startedAt })
  state2.lineages = snapshot.lineages
  const third = applyStarted(state2, { id: 'run-3', agent: 'worker' }, startedAt + 300)
  state2.lineages = state2.lineages.filter((lineage) => lineage.lineageRoot !== 'run-3')
  third.segment.revivedFrom = 'run-1'
  state2.lineages.push({
    lineageRoot: 'run-3',
    agent: 'worker',
    lastActivityAt: startedAt + 300,
    state: 'running',
    segments: [third.segment],
  })
  state2.source.rpc = true
  state2.source.mode = 'push'
  state2.updatedAt = Date.now()
  writeJsonAtomic(livePath, state2)

  const second = await api.invoke('getState', { sessionFile })
  assert.equal(second.lineages.length, 1)
  assert.equal(second.relinked, 2)
  assert.notEqual(second.rev, first.rev, '新孤段进来时版本戳要变，长轮询才能立刻醒')
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

test('getState: 应用重启带走了 runner 进程，卡片判成「已中断」且不再给停止按钮', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'dead.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-run-'))
  // 真起一个子进程再让它退出：拿到的 pid 确定已经死了（瞎猜数字会被系统复用打脸）
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const now = Date.now()
  fs.writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      runId: 'run-dead',
      state: 'running',
      pid: child.pid,
      startedAt: now - 60_000,
      lastUpdate: now - 1_000,
      mode: 'single',
      steps: [{ agent: 'worker' }],
    }),
  )

  const state = createState({ sessionKey, sessionFile, pid: 77, startedAt: now - 5_000 })
  applyStarted(state, { id: 'run-dead', agent: 'worker', asyncDir: runDir }, now - 4_000)
  state.source.rpc = true
  state.source.mode = 'push'
  state.source.capabilities = ['steer', 'stop']
  state.source.supports = { steer: true, stop: true }
  state.updatedAt = now
  ensureLiveDir(dataDir)
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 77, startedAt: now - 5_000 }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const got = await api.invoke('getState', { sessionFile })
  const segment = got.lineages[0].segments[0]

  assert.equal(segment.state, 'lost', '进程没了还要显示运行中，用户会一直等一张永远不会动的卡')
  assert.equal(segment.lostPid, child.pid)
  assert.equal(segment.endedAt, now - 1_000, '结束时间取 status 的最后一次写盘')
  assert.equal(segment.canStop, false, '停止按钮必须消失：点了也没有进程接')
  assert.equal(segment.canSteer, false)
  assert.equal(got.activeCount, 0)
})

test('getState: 归档里的历史卡与活跃分区一起显示（装订对读透明）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'arch.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 60_000

  // 上一代已经下班：装订进 archive
  writeJsonAtomic(archiveFileOf(dataDir, sessionKey), {
    version: 2,
    sessionKey,
    startedAt: 0,
    updatedAt: Date.now(),
    lineages: [
      {
        lineageRoot: 'run-old',
        agent: 'delegate',
        segments: [
          {
            runId: 'run-old',
            agent: 'delegate',
            state: 'complete',
            startedAt,
            endedAt: startedAt + 10,
            sessionName: 'delegate: 老任务',
          },
        ],
      },
    ],
  })
  // 当前这一代：还在跑
  const state = createState({ sessionKey, sessionFile, pid: 42, startedAt: startedAt + 1_000 })
  applyStarted(state, { id: 'run-new', agent: 'delegate', cwd: 'C:/w' }, startedAt + 1_100)
  state.updatedAt = Date.now()
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 42, startedAt: startedAt + 1_000 }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const view = await api.invoke('getState', { sessionFile })

  const runIds = view.lineages.flatMap((lineage) => lineage.segments.map((segment) => segment.runId)).sort()
  assert.deepEqual(runIds, ['run-new', 'run-old'], '归档的卡和活跃的卡都要在')
  assert.equal(view.generations, 2, '一份归档 + 一份分区 = 两代')
  assert.ok(view.dataFile.endsWith('.json'), '诊断区显示的是当前分区')
})

test('getState: 状态一算出就落索引；反查子会话优先走它', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'idx.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const startedAt = Date.now() - 5_000
  const childFile = path.join(dataDir, 'sessions', 'child', 'run-1', 'run-0', 'session.jsonl')
  const state = createState({ sessionKey, sessionFile, pid: 5, startedAt })
  const started = applyStarted(state, { id: 'run-1', agent: 'delegate', cwd: 'C:/w' }, startedAt + 100)
  started.segment.childSessionFile = childFile
  state.updatedAt = Date.now()
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 5, startedAt }), state)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  await api.invoke('getState', { sessionFile })

  const index = readIndex(dataDir, sessionKey)
  assert.ok(index, 'getState 之后应当落一份索引（反查与诊断都靠它）')
  assert.equal(index.segments[0].runId, 'run-1')
  assert.equal(index.segments[0].childSessionFile, childFile)

  // 预览这段子会话：反查出父会话的链，并给出「返回主会话」的落点
  const preview = await api.invoke('getState', { sessionFile: childFile })
  assert.equal(preview.parentSessionFile, sessionFile)
  assert.equal(preview.lineages[0].segments[0].runId, 'run-1')
})

test('getState: 只剩归档的会话不报「未连上 pi-subagents」，历史卡照常显示（0.11.1）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'archived.jsonl')
  const { sessionKey } = seedLive(dataDir, sessionFile)
  // 实例已经下班：段收敛成终态，分区闲置超时后被装订进 archive.json
  const old = new Date(Date.now() - ARCHIVE_IDLE_MS - 60_000)
  for (const file of liveFilesOf(dataDir)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    parsed.lineages[0].segments[0].state = 'complete'
    parsed.lineages[0].segments[0].endedAt = Date.now() - 60_000
    fs.writeFileSync(file, JSON.stringify(parsed))
    fs.utimesSync(file, old, old)
  }
  archiveSessions(dataDir)
  assert.equal(fs.existsSync(archiveFileOf(dataDir, sessionKey)), true, '分区应当已被装订')
  assert.equal(readLiveFiles(dataDir, sessionKey).filter((item) => item.kind === 'partition').length, 0)

  const mod = await loadMain()
  const api = await mod.activate(fakeCtx(dataDir))
  const state = await api.invoke('getState', { sessionFile })

  assert.equal(state.lineages.length, 1, '归档卡必须还在')
  assert.equal(state.degrade.kind, 'archived')
  assert.equal(state.degrade.title, '', '归档没有 source，不能拿它判「没连上」')
})

test('getState: 孤段每轮都得搬，但只在孤段集合变化时推唤醒（0.11.1）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-main-'))
  const sessionFile = path.join(dataDir, 'sessions', 'orphan.jsonl')
  const sessionKey = sessionKeyOf(sessionFile)
  const now = Date.now()

  // 来源段在归档里（实例早就下班了，这份文件永远不会被重写）
  writeJsonAtomic(archiveFileOf(dataDir, sessionKey), {
    version: 2,
    sessionKey,
    sessionFile,
    startedAt: 0,
    updatedAt: now,
    lineages: [
      {
        lineageRoot: 'run-a',
        agent: 'worker',
        segments: [{ runId: 'run-a', agent: 'worker', state: 'complete', startedAt: now - 60_000, endedAt: now - 50_000 }],
      },
    ],
  })
  // 续跑段在活跃分区里，且没接回原链（resume 中途重启的老形状）
  const state = createState({ sessionKey, sessionFile, pid: 7, startedAt: now - 10_000 })
  const started = applyStarted(state, { id: 'run-b', agent: 'worker', cwd: 'C:/w' }, now - 9_000)
  started.segment.revivedFrom = 'run-a'
  started.segment.state = 'complete'
  started.segment.endedAt = now - 8_000
  state.updatedAt = now
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 7, startedAt: state.startedAt }), state)

  const mod = await loadMain()
  const ctx = fakeCtx(dataDir)
  const api = await mod.activate(ctx)
  const relinkLogs = () => ctx.logs.filter((line) => line.includes('relinked')).length

  const first = await api.invoke('getState', { sessionFile })
  assert.deepEqual(
    first.lineages[0].segments.map((segment) => segment.runId),
    ['run-a', 'run-b'],
    '孤段要搬回原链',
  )
  const afterFirst = relinkLogs()
  await api.invoke('getState', { sessionFile })
  await api.invoke('getState', { sessionFile })
  assert.equal(relinkLogs(), afterFirst, '同一批孤段重复搬不该再推唤醒（否则长轮询 0 延迟空转）')

  // 磁盘上的分区被重写成「已接回原链」的形状：这一轮没有孤段可搬
  const linked = {
    ...state,
    lineages: [
      {
        lineageRoot: 'run-a',
        agent: 'worker',
        segments: [
          { runId: 'run-a', agent: 'worker', state: 'complete', startedAt: now - 60_000, endedAt: now - 50_000 },
          { runId: 'run-b', agent: 'worker', state: 'complete', startedAt: now - 9_000, endedAt: now - 8_000 },
        ],
      },
    ],
  }
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 7, startedAt: state.startedAt }), linked)
  await api.invoke('getState', { sessionFile })
  assert.equal(relinkLogs(), afterFirst, '没有孤段时不该有日志')

  // 又回到孤链形状（老版本的 worker 会这么写）：集合重新出现，这次必须再推一次唤醒
  writeJsonAtomic(liveFileOf(dataDir, { sessionKey, pid: 7, startedAt: state.startedAt }), state)
  const back = await api.invoke('getState', { sessionFile })
  assert.deepEqual(
    back.lineages[0].segments.map((segment) => segment.runId),
    ['run-a', 'run-b'],
  )
  assert.equal(relinkLogs(), afterFirst + 1, '签名要先归零，否则同一批孤段再出现就永远推不动了')
})
