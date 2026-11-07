import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { readLiveFiles } from '../lib/live-store.mjs'
import { sessionKeyOf } from '../lib/session-key.mjs'

const entry = pathToFileURL(path.join(import.meta.dirname, '..', 'agent.mjs')).href

/** 最小 eventBus + hook 注册器的假 pi（只实现 agent.mjs 用到的那几个面） */
function fakePi() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Map<string, Function>} */
  const hooks = new Map()
  const pi = {
    events: {
      on(name, cb) {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(cb)
      },
      emit(name, payload) {
        for (const cb of listeners.get(name) ?? []) cb(payload)
      },
    },
    on(name, cb) {
      hooks.set(name, cb)
    },
  }
  return {
    pi,
    hook(name) {
      return hooks.get(name)
    },
    emit(name, payload) {
      for (const cb of listeners.get(name) ?? []) cb(payload)
    },
    /** 统计某方法的请求次数 */
    countRequests() {
      return listeners.size
    },
  }
}

/**
 * 假的 pi-subagents 服务端：收到 request 就回 reply。
 * @param {{ events?: Record<string, string>, status?: any, onRequest?: (method: string, index: number) => any }} options
 */
function fakeServer(harness, options = {}) {
  const events = options.events ?? {
    asyncStarted: 'subagent:async-started',
    asyncComplete: 'subagent:async-complete',
    jobsChanged: 'subagent:jobs-changed',
  }
  let pingCount = 0
  let statusCount = 0
  /** @type {any[]} */
  const commands = []
  harness.pi.events.on('subagents:rpc:v1:request', (request) => {
    const replyName = `subagents:rpc:v1:reply:${request.requestId}`
    if (request.method === 'ping') {
      pingCount += 1
      harness.emit(replyName, { success: true, data: { capabilities: { steer: true, stop: true, events } } })
      return
    }
    if (request.method === 'status') {
      statusCount += 1
      harness.emit(replyName, { success: true, data: options.status ?? { runs: [] } })
      return
    }
    if (request.method === 'steer') {
      commands.push({ method: 'steer', params: request.params })
      // 真实形状：dataFromToolResult 给 { text, details: { steering } }
      const steeringState = options.steerState ?? 'queued'
      harness.emit(replyName, {
        success: true,
        data: {
          text: 'Steering queued',
          details: { mode: 'management', results: [], steering: { state: steeringState, deliveryStatus: steeringState, targets: [{ index: 0, state: steeringState }] } },
        },
      })
      return
    }
    if (request.method === 'stop') {
      commands.push({ method: 'stop', params: request.params })
      harness.emit(replyName, { success: true, data: { state: 'stopping' } })
      return
    }
    harness.emit(replyName, { success: false, error: { code: 'unknown_method', message: request.method } })
  })
  return {
    get pings() {
      return pingCount
    },
    get statuses() {
      return statusCount
    },
    get commands() {
      return commands
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等一个条件成立（文件出现这类跨进程事件，用固定 sleep 会 flaky） */
async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(50)
  }
  return false
}

async function boot(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-agent-'))
  const harness = fakePi()
  const server = fakeServer(harness, options)
  const { default: factory } = await import(entry)
  const logs = []
  factory(harness.pi, { pluginId: 'subagents-board', pluginDir: dataDir, dataDir, log: (...args) => logs.push(args.join(' ')) })
  // 触发 session_start：真实宿主会在会话初始化时调它
  const hook = harness.hook('session_start')
  if (hook) hook({}, { sessionManager: { getSessionFile: () => 'C:/sessions/parent.jsonl' }, cwd: 'C:/w' })
  return { dataDir, harness, server, logs }
}

function readState(dataDir) {
  const files = readLiveFiles(dataDir)
  return files.length ? files.sort((a, b) => (b.state.startedAt ?? 0) - (a.state.startedAt ?? 0))[0].state : null
}

test('agent: 握手成功后把事件聚合成 live 状态并落盘', async () => {
  const { dataDir, harness, server } = await boot()
  await sleep(500)
  assert.ok(server.pings >= 1, '启动就该 ping 一次')

  harness.emit('subagent:async-started', {
    id: 'run-1',
    agent: 'worker',
    cwd: 'C:/w',
    asyncDir: 'C:/tmp/async-1',
    sessionId: 'C:/sessions/parent.jsonl',
  })
  harness.emit('subagent:async-complete', {
    id: 'run-1',
    agent: 'worker',
    state: 'complete',
    success: true,
    summary: 'done',
    durationMs: 4_000,
    timestamp: Date.now(),
    sessionFile: 'C:/sessions/parent/run-1/run-0/session.jsonl',
    results: [{ agent: 'worker', model: 'm', status: 'complete', sessionFile: 'C:/sessions/parent/run-1/run-0/session.jsonl' }],
  })
  await sleep(600)

  const state = readState(dataDir)
  assert.ok(state, '应当写出 live 文件')
  assert.equal(state.source.rpc, true)
  assert.equal(state.source.mode, 'push')
  assert.equal(state.sessionFile, 'C:/sessions/parent.jsonl')
  assert.deepEqual(state.source.supports, { steer: true, stop: true }, '能力值要看 boolean，不能只留键名')
  assert.equal(state.lineages.length, 1)
  assert.equal(state.lineages[0].segments[0].runId, 'run-1')
  assert.equal(state.lineages[0].segments[0].state, 'complete')
  assert.equal(state.lineages[0].segments[0].summary, 'done')
  assert.equal(state.lineages[0].segments[0].childSessionFile, 'C:/sessions/parent/run-1/run-0/session.jsonl')
  assert.ok(state.updatedAt > 0, 'updatedAt 是 main 侧判活的依据')
})

test('agent: started 阶段就推导子会话路径，complete 前对话流可点（实测反馈）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(500)
  harness.emit('subagent:async-started', {
    id: 'run-r',
    agent: 'worker',
    cwd: 'C:/w',
    asyncDir: 'C:/tmp/async-r',
    sessionId: 'C:/sessions/parent.jsonl',
  })
  await sleep(600)
  const state = readState(dataDir)
  const segment = state.lineages[0].segments[0]
  assert.equal(segment.state, 'running')
  // 形状：<父目录>/<父 stem>/<runId>/run-0/session.jsonl（pi-subagents 0.86.0 固定结构）
  assert.equal(segment.childSessionFile.toLowerCase(), 'c:\\sessions\\parent\\run-r\\run-0\\session.jsonl')
})

test('agent: jobs-changed 高频触发时 status 被合并节流（不是一条事件一次请求）', async () => {
  const { harness, server } = await boot()
  await sleep(400)
  const before = server.statuses
  for (let i = 0; i < 20; i += 1) harness.emit('subagent:jobs-changed', { version: 1 })
  await sleep(1_300)
  const after = server.statuses
  // 20 条事件最多合并成 1~2 次 status（1s 合并窗口 + 心跳），绝不能是 20
  assert.ok(after - before <= 3, `20 条事件触发了 ${after - before} 次 status，说明没节流`)
})

test('agent: 没有 pi-subagents 回包时记为未连接并持续重试', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-agent-'))
  const harness = fakePi() // 不挂 server：所有请求都会超时
  const { default: factory } = await import(entry)
  factory(harness.pi, { pluginId: 'subagents-board', pluginDir: dataDir, dataDir, log: () => {} })
  harness.hook('session_start')?.({}, { sessionManager: { getSessionFile: () => 'C:/sessions/parent.jsonl' } })
  // ping 超时是 4s，等它落一次「失败」状态
  await sleep(4_500)
  const state = readState(dataDir)
  assert.ok(state, '失败也要落盘，否则面板只能显示空白')
  assert.equal(state.source.rpc, false)
  assert.equal(state.source.mode, 'none')
  assert.ok(state.source.handshake.attempts >= 1)
  assert.ok(state.source.handshake.lastError)
})

/** 写一条留言到本会话的收件箱（模拟 main 侧的投递） */
function postNoteFile(dataDir, body) {
  const key = sessionKeyOf('C:/sessions/parent.jsonl')
  const dir = path.join(dataDir, 'inbox', key)
  fs.mkdirSync(dir, { recursive: true })
  const note = { sessionKey: key, createdAt: Date.now(), ...body }
  const file = path.join(dir, `${note.id}.json`)
  fs.writeFileSync(file, JSON.stringify(note))
  return { key, file }
}

function readReceipt(dataDir, id) {
  const file = path.join(dataDir, 'receipts', `${id}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

test('agent: 扫到插话就发一次 steer RPC 给那个 run，回执记扩展给的状态', async () => {
  const { dataDir, server } = await boot()
  await sleep(500)
  const { key } = postNoteFile(dataDir, {
    id: 'n1',
    kind: 'note',
    runId: 'run-1',
    agent: 'code-reviewer',
    mode: 'steer',
    message: '换个方向',
  })
  assert.equal(await waitFor(() => readReceipt(dataDir, 'n1') !== null), true, '500ms 内该被扫到并投出去')

  const receipt = readReceipt(dataDir, 'n1')
  assert.equal(receipt.ok, true)
  assert.equal(receipt.state, 'queued', '扩展说排队就报排队，不自己升级成 delivered')
  assert.equal(receipt.upstream, 'queued')
  assert.equal(receipt.runId, 'run-1', '回执要带 runId，UI 靠它匹配卡片')
  assert.equal(receipt.sessionKey, key)

  const sent = server.commands.at(-1)
  assert.equal(sent.method, 'steer', '投递走扩展的 steering，不再落到主会话的 prompt')
  assert.deepEqual(sent.params, { id: 'run-1', message: '换个方向', mode: 'steer' })
})

test('agent: 扩展说 delivered 就报「已插进这一轮」，index 会原样带到 RPC', async () => {
  const { dataDir, server } = await boot({ steerState: 'delivered' })
  await sleep(500)
  postNoteFile(dataDir, { id: 'n2', kind: 'note', runId: 'run-3', index: 1, message: '看第二段' })
  assert.equal(await waitFor(() => readReceipt(dataDir, 'n2') !== null), true)
  assert.equal(readReceipt(dataDir, 'n2').state, 'delivered')
  assert.deepEqual(server.commands.at(-1).params, { id: 'run-3', message: '看第二段', mode: 'steer', index: 1 })
})

test('agent: stop 走扩展的 stop RPC，回执是 stopping，并立刻拉一次 status（不等心跳）', async () => {
  const { dataDir, server } = await boot()
  await sleep(500)
  postNoteFile(dataDir, { id: 's1', kind: 'stop', runId: 'run-2' })
  assert.equal(await waitFor(() => readReceipt(dataDir, 's1') !== null), true)
  const receipt = readReceipt(dataDir, 's1')
  assert.equal(receipt.state, 'stopping', '受理 ≠ 已终止，UI 要靠 state 收敛')
  assert.equal(server.commands.at(-1).method, 'stop')
  assert.deepEqual(server.commands.at(-1).params, { id: 'run-2' })
  assert.equal(receipt.kind, 'stop')
})

test('agent: 过期的留言不投，只记一条 expired（几分钟前的留言投过去也只会撞上终态）', async () => {
  const { dataDir, harness, server } = await boot()
  await sleep(500)
  postNoteFile(dataDir, {
    id: 'old1',
    kind: 'note',
    message: '昨天的想法',
    createdAt: Date.now() - 11 * 60 * 1000,
  })
  assert.equal(await waitFor(() => readReceipt(dataDir, 'old1') !== null), true)
  const receipt = readReceipt(dataDir, 'old1')
  assert.equal(receipt.ok, false)
  assert.equal(receipt.state, 'expired')
  assert.equal(server.commands.length, 0, '过期就一个字都不能投')
})

test('agent: 已有回执的留言不重复投（换代/重启后幂等），别的会话的目录不碰', async () => {
  const { dataDir, server } = await boot()
  await sleep(500)
  const { file } = postNoteFile(dataDir, { id: 'dup1', kind: 'note', runId: 'run-1', message: '只投一次' })
  fs.mkdirSync(path.join(dataDir, 'receipts'), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'receipts', 'dup1.json'),
    JSON.stringify({ id: 'dup1', ok: true, state: 'queued' }),
  )

  // 另一个会话的收件箱：本会话不该读，更不该执行
  const foreignDir = path.join(dataDir, 'inbox', 'ffffffffffff')
  fs.mkdirSync(foreignDir, { recursive: true })
  fs.writeFileSync(
    path.join(foreignDir, 'x1.json'),
    JSON.stringify({ id: 'x1', kind: 'stop', sessionKey: 'ffffffffffff', runId: 'run-9', createdAt: Date.now() }),
  )

  await sleep(1_200)
  assert.equal(server.commands.length, 0, '有回执就别再投；别的会话的 stop 也不能被执行')
  assert.equal(fs.existsSync(file), true, '留言不可变，投完也不删（幂等靠回执判断）')
  assert.equal(fs.existsSync(path.join(foreignDir, 'x1.json')), true)
})
test('agent: 运行中从 run 的 status.json 补标题与 steering 计数（RPC status 不带这两样）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  // run 自己的运行目录：sessionName 在启动 5–15 秒后就落进来了（实测报告 P1″）
  const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-async-'))
  fs.writeFileSync(
    path.join(asyncDir, 'status.json'),
    JSON.stringify({
      runId: 'run-t',
      state: 'running',
      steering: { requested: 1, pending: 1, delivered: 0, failed: 0, recent: [{ id: 'rq', targets: [{ index: 0, state: 'pending' }] }] },
      steps: [{ agent: 'delegate', sessionName: 'delegate: 【实时标题探测】工作目录: C:/w', status: 'running' }],
    }),
  )
  harness.emit('subagent:async-started', {
    id: 'run-t',
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir,
    sessionId: 'C:/sessions/parent.jsonl',
  })

  const segmentOf = () => readState(dataDir)?.lineages?.[0]?.segments?.[0]
  assert.equal(await waitFor(() => Boolean(segmentOf()?.sessionName)), true, '下一次 status 之后标题就该有值')
  const segment = segmentOf()
  assert.equal(segment.sessionName, 'delegate: 【实时标题探测】工作目录: C:/w')
  assert.equal(segment.steering?.requested, 1, '插话计数也要落进 live 状态，卡片才有数')
  assert.equal(segment.steering?.pending, 1)
})

test('agent: 没有 pi.events 时立刻落一份说明原因的状态', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-agent-'))
  const { default: factory } = await import(entry)
  factory(/** @type {any} */ ({ on: () => {} }), {
    pluginId: 'subagents-board',
    pluginDir: dataDir,
    dataDir,
    log: () => {},
  })
  const state = readState(dataDir)
  assert.ok(state)
  assert.equal(state.source.rpc, false)
  assert.match(state.source.lastError, /pi\.events/)
})
