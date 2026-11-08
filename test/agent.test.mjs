import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { listSessionKeys, readLiveFiles } from '../lib/live-store.mjs'
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

function readState(dataDir, sessionKey = '') {
  /** @type {any[]} */
  const files = []
  if (sessionKey) files.push(...readLiveFiles(dataDir, sessionKey))
  else {
    for (const key of listSessionKeys(dataDir)) files.push(...readLiveFiles(dataDir, key))
    // sessionFile 还没就位时 worker 写进 unknown 目录，测试里也要能看见
    files.push(...readLiveFiles(dataDir, 'unknown'))
  }
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
  await sleep(1_200) // 首帧压在探测窗口里：asyncDir 不存在要等 8 次重试放弃（≈0.96s）
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
      steps: [
        {
          agent: 'delegate',
          sessionName: 'delegate: 【实时标题探测】工作目录: C:/w',
          status: 'running',
          activityState: 'needs_attention',
        },
      ],
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
  // 报告 P10：state 还是 running，但它在等人回答——面板靠这一项才画得出「等待回答」
  assert.equal(segment.activityState, 'needs_attention')
})

test('agent: resume 段的标题回原 run 取，且带上「续」的标记（报告 P1″ 结论 2）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-runs-'))
  const originId = 'origin-1'
  const resumeId = 'resume-1'
  fs.mkdirSync(path.join(root, originId))
  fs.writeFileSync(
    path.join(root, originId, 'status.json'),
    JSON.stringify({ runId: originId, state: 'complete', steps: [{ agent: 'delegate', sessionName: 'delegate: 约 25 秒任务：写一行时间' }] }),
  )
  fs.mkdirSync(path.join(root, resumeId))
  fs.writeFileSync(
    path.join(root, resumeId, 'status.json'),
    JSON.stringify({
      runId: resumeId,
      state: 'running',
      revivedFrom: originId,
      steps: [{ agent: 'delegate', sessionName: 'delegate: You are reviving a previous subagent conversation. Origin...' }],
    }),
  )

  harness.emit('subagent:async-started', {
    id: resumeId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(root, resumeId),
    revivedFrom: originId,
    sessionId: 'C:/sessions/parent.jsonl',
  })

  const segmentOf = () => readState(dataDir)?.lineages?.at(-1)?.segments?.at(-1)
  assert.equal(await waitFor(() => segmentOf()?.sessionName === 'delegate: 约 25 秒任务：写一行时间'), true)
  assert.equal(segmentOf()?.revivedFrom, originId, '续跑来源要留在段上，卡片拿来标「续」')
})

test('agent: async-started 不带 revivedFrom 时，靠 run 目录的 status.json 当场接回原链（0.9.9）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-runs-'))
  const originId = 'origin-3'
  const resumeId = 'resume-3'
  const shared = path.join(root, 'shared-session.jsonl')
  fs.writeFileSync(shared, '{}')
  fs.mkdirSync(path.join(root, originId))
  fs.writeFileSync(
    path.join(root, originId, 'status.json'),
    JSON.stringify({ runId: originId, state: 'complete', steps: [{ agent: 'delegate', sessionFile: shared }] }),
  )
  fs.mkdirSync(path.join(root, resumeId))
  // 实测形状：run 一启动，status.json 里就有 revivedFrom 与共享的 sessionFile
  fs.writeFileSync(
    path.join(root, resumeId, 'status.json'),
    JSON.stringify({ runId: resumeId, state: 'running', revivedFrom: originId, steps: [{ agent: 'delegate', sessionFile: shared }] }),
  )

  harness.emit('subagent:async-started', {
    id: originId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(root, originId),
    sessionId: 'C:/sessions/parent.jsonl',
  })
  assert.equal(await waitFor(() => (readState(dataDir)?.lineages?.length ?? 0) === 1), true)

  // 关键：这个事件里**没有** revivedFrom（上游 emit 的字段清单里没有它）
  harness.emit('subagent:async-started', {
    id: resumeId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(root, resumeId),
    sessionId: 'C:/sessions/parent.jsonl',
  })

  const merged = () => {
    const state = readState(dataDir)
    const lineages = state?.lineages ?? []
    return lineages.length === 1 && (lineages[0].segments ?? []).length === 2
  }
  assert.equal(await waitFor(merged), true, '应在秒级内并成一条链，而不是等 async-complete')
  const state = readState(dataDir)
  const segment = state.lineages[0].segments[1]
  assert.equal(segment.revivedFrom, originId)
  assert.equal(segment.reviveHops, 1)
  assert.equal(segment.childSessionFile, shared, '真实会话文件要以 status.json 为准，不能用按新 runId 猜的那条')
})

test('agent: resume 的那段从不上屏成孤卡（首帧压到接链之后）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-runs-'))
  const originId = 'origin-4'
  const resumeId = 'resume-4'
  const shared = path.join(root, 'shared-session.jsonl')
  fs.writeFileSync(shared, '{}')
  fs.mkdirSync(path.join(root, originId))
  fs.writeFileSync(
    path.join(root, originId, 'status.json'),
    JSON.stringify({ runId: originId, mode: 'single', state: 'complete', steps: [{ agent: 'delegate', sessionFile: shared }] }),
  )
  fs.mkdirSync(path.join(root, resumeId))
  // status.json 要等子进程初始化完才落盘——**这段延迟正是孤卡窗口的成因**。
  // 预写好的话探测第一个 tick 就命中，测不出「先上屏再变标题」。
  const writeResumeStatus = () =>
    fs.writeFileSync(
      path.join(root, resumeId, 'status.json'),
      JSON.stringify({ runId: resumeId, mode: 'single', state: 'running', revivedFrom: originId, steps: [{ agent: 'delegate', sessionFile: shared }] }),
    )

  harness.emit('subagent:async-started', {
    id: originId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(root, originId),
    sessionId: 'C:/sessions/parent.jsonl',
  })
  assert.equal(await waitFor(() => (readState(dataDir)?.lineages?.length ?? 0) === 1), true)

  harness.emit('subagent:async-started', {
    id: resumeId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(root, resumeId),
    sessionId: 'C:/sessions/parent.jsonl',
  })

  // 采样整个接链窗口：任何一份落盘的 live 文件里都不该出现「只有 resume 段」的链。
  // 出现就说明它先以孤卡上屏了——标题会先变成 `delegate · resume-4` 再变回去。
  let orphanAt = null
  const startedAt = Date.now()
  let wroteStatus = false
  for (let i = 0; i < 60; i += 1) {
    if (!wroteStatus && Date.now() - startedAt > 700) {
      writeResumeStatus()
      wroteStatus = true
    }
    for (const lineage of readState(dataDir)?.lineages ?? []) {
      const segments = lineage.segments ?? []
      if (segments.some((segment) => segment.runId === resumeId) && segments.length === 1) orphanAt = i
    }
    await sleep(30)
  }
  assert.equal(orphanAt, null, `resume 段必须先接回原链再上屏（在第 ${orphanAt} 次采样看到了孤链）`)
  const segments = readState(dataDir)?.lineages?.[0]?.segments ?? []
  assert.deepEqual(
    segments.map((segment) => segment.runId),
    [originId, resumeId],
  )
})

test('agent: 普通 run 第一次上屏就带真标题（不等下一次 heartbeat）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-runs-'))
  const runId = 'plain-1'
  fs.mkdirSync(path.join(root, runId))
  fs.writeFileSync(
    path.join(root, runId, 'status.json'),
    JSON.stringify({
      runId,
      mode: 'single',
      state: 'running',
      steps: [{ agent: 'delegate', sessionName: '把测试报告整理成 markdown' }],
    }),
  )
  harness.emit('subagent:async-started', {
    id: runId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(root, runId),
    sessionId: 'C:/sessions/parent.jsonl',
  })
  // 关键：第一份写出来的 live 文件里 sessionName 就该在。以前要等下一次 status
  // 轮询（1s 心跳），中间那段时间卡片标题是 `delegate · plain-1`。
  assert.equal(
    await waitFor(() => {
      const segment = readState(dataDir)?.lineages?.[0]?.segments?.[0]
      return String(segment?.sessionName ?? '').includes('整理成 markdown')
    }),
    true,
  )
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

test('agent: needs_attention 的 reason 从事件流读出来——等人回答 vs 无响应（报告 P19/P20）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)

  const idleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-idle-'))
  fs.writeFileSync(
    path.join(idleDir, 'status.json'),
    JSON.stringify({
      runId: 'run-idle',
      state: 'running',
      // 续跑 run 实测没有这两个字段：挂死就不会自愈
      lastActivityAt: 1794120000000,
      steps: [{ agent: 'delegate', status: 'running', activityState: 'needs_attention', sessionName: 'delegate: 卡住的那个' }],
    }),
  )
  fs.writeFileSync(
    path.join(idleDir, 'events.jsonl'),
    `${JSON.stringify({
      type: 'subagent.control',
      event: { type: 'needs_attention', ts: 1794120055464, message: 'no observed activity for 60s', reason: 'idle', elapsedMs: 60236 },
    })}\n`,
  )

  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ask-'))
  fs.writeFileSync(
    path.join(askDir, 'status.json'),
    JSON.stringify({
      runId: 'run-ask',
      state: 'running',
      lastActivityAt: 1794120100000,
      steps: [{ agent: 'delegate', status: 'running', activityState: 'needs_attention', sessionName: 'delegate: 提问的那个' }],
    }),
  )
  fs.writeFileSync(
    path.join(askDir, 'events.jsonl'),
    [
      JSON.stringify({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'contact_supervisor',
        args: { reason: 'need_decision', message: '请选择 A 还是 B' },
        observedAt: 1794120100500,
      }),
      JSON.stringify({
        type: 'subagent.control',
        event: { type: 'needs_attention', reason: 'supervisor_request', ts: 1794120100600, currentTool: 'contact_supervisor' },
      }),
      JSON.stringify({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'contact_supervisor',
        result: { content: [{ type: 'text', text: '**Reply from supervisor:**\nA' }] },
        durationMs: 42_000,
        observedAt: 1794120142000,
      }),
    ].join('\n'),
  )

  harness.emit('subagent:async-started', {
    id: 'run-idle',
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: idleDir,
    sessionId: 'C:/sessions/parent.jsonl',
  })
  harness.emit('subagent:async-started', {
    id: 'run-ask',
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: askDir,
    sessionId: 'C:/sessions/parent.jsonl',
  })

  const segmentOf = (runId) => {
    for (const lineage of readState(dataDir)?.lineages ?? []) {
      for (const segment of lineage.segments ?? []) if (segment.runId === runId) return segment
    }
    return null
  }

  assert.equal(await waitFor(() => segmentOf('run-idle')?.attentionReason === 'idle'), true, 'idle 才是「无响应」')
  assert.equal(await waitFor(() => segmentOf('run-ask')?.attentionReason === 'supervisor_request'), true, '等人回答是另一回事')

  const idle = segmentOf('run-idle')
  assert.equal(idle.attentionSince, 1794120055464, '等待起点用控制事件的 ts，不用我们自己的时钟')
  assert.equal(idle.hasDeadline, false, '续跑 run 没有超时保护，卡面要能说出来')
  assert.equal(idle.lastActivityAt, 1794120000000, '无活动时长用磁盘上的真实时刻')
  assert.equal(idle.attentionAsk ?? null, null, 'idle 没有提问可显示')

  const ask = segmentOf('run-ask')
  assert.equal(ask.attentionAsk?.question, '请选择 A 还是 B')
  assert.equal(ask.attentionAsk?.answer, 'A')
  assert.equal(ask.attentionAsk?.durationMs, 42_000)
})

test('agent: 描述符比 status.json 早——resume 段不等子进程落盘就并回原链（0.10.4）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  // 实测形状：<root>/async-subagent-runs/<runId>，launches 是同级目录
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-launch-'))
  const runsRoot = path.join(root, 'async-subagent-runs')
  const launchesRoot = path.join(root, 'async-subagent-launches')
  const originId = '6dec8284-4058-456c-ae66-df2da5922efa'
  const resumeId = 'bc779a16-fed5-4afc-9530-526077153ec9'
  const shared = path.join(root, 'sessions', originId, 'run-0', 'session.jsonl')
  fs.mkdirSync(path.dirname(shared), { recursive: true })
  fs.writeFileSync(shared, '{}')
  fs.mkdirSync(path.join(launchesRoot, resumeId), { recursive: true })
  fs.mkdirSync(path.join(runsRoot, originId), { recursive: true })
  fs.mkdirSync(path.join(runsRoot, resumeId), { recursive: true })

  // 原 run 的 status.json 早就在了：真标题在这里
  fs.writeFileSync(
    path.join(runsRoot, originId, 'status.json'),
    JSON.stringify({
      runId: originId,
      mode: 'single',
      state: 'complete',
      steps: [{ agent: 'delegate', sessionName: 'delegate: 【单链测试】工作目录: C:/w' }],
    }),
  )
  // 续跑的描述符在 spawn 前就写好了，直接指向来源的会话文件
  fs.writeFileSync(
    path.join(launchesRoot, resumeId, 'recovery-descriptor.json'),
    JSON.stringify({ sourceRunId: resumeId, agent: 'delegate', sessionFile: shared }),
  )
  // **关键**：续跑自己的 status.json 一直不写（模拟子进程冷启动比探测窗口更久）。
  // 0.10.1~0.10.3 在这种情况下只能写出一张「角色 · id」的孤卡，几百毫秒后才接上。

  harness.emit('subagent:async-started', {
    id: originId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(runsRoot, originId),
    sessionId: 'C:/sessions/parent.jsonl',
  })
  assert.equal(await waitFor(() => (readState(dataDir)?.lineages?.length ?? 0) === 1), true)

  harness.emit('subagent:async-started', {
    id: resumeId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: path.join(runsRoot, resumeId),
    sessionId: 'C:/sessions/parent.jsonl',
  })

  // 全程采样：任何一份落盘状态里都不该出现只含 resume 段的链
  let orphanAt = null
  for (let i = 0; i < 40; i += 1) {
    for (const lineage of readState(dataDir)?.lineages ?? []) {
      const segments = lineage.segments ?? []
      if (segments.some((segment) => segment.runId === resumeId) && segments.length === 1) orphanAt = i
    }
    await sleep(30)
  }
  assert.equal(orphanAt, null, `不该先上孤卡（第 ${orphanAt} 次采样看到了）`)

  const segments = readState(dataDir)?.lineages?.[0]?.segments ?? []
  assert.deepEqual(
    segments.map((segment) => segment.runId),
    [originId, resumeId],
  )
  const resume = segments[1]
  assert.equal(resume.revivedFrom, originId)
  assert.equal(resume.reviveHops, 1)
  assert.equal(resume.childSessionFile, shared, '会话文件用描述符里那份，不是按新 runId 猜的')
  assert.match(String(resume.sessionName), /单链测试/, '标题回原 run 取，不等自己的 status.json')
})

test('agent: 普通 run 立刻上屏，任务名从 events.jsonl 补——不等 23 秒的 status.json（0.10.5）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-task-'))
  const runsRoot = path.join(root, 'async-subagent-runs')
  const launchesRoot = path.join(root, 'async-subagent-launches')
  const runId = 'cfdcee75-cefb-4a11-97a5-0f2aa4241801'
  const runDir = path.join(runsRoot, runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(launchesRoot, runId), { recursive: true })
  // 描述符指向自己的会话文件 = 普通 run。它在 spawn 前就写好了（实测比 run.started 早 3s）
  fs.writeFileSync(
    path.join(launchesRoot, runId, 'recovery-descriptor.json'),
    JSON.stringify({
      sourceRunId: runId,
      agent: 'delegate',
      sessionFile: path.join(root, 'sessions', runId, 'run-0', 'session.jsonl'),
    }),
  )
  // 关键：status.json 全程不落盘（实测它要 23 秒才出现），事件流 1~2 秒就有任务原文
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify({ type: 'subagent.run.started', runId })}\n`)

  const at = Date.now()
  harness.emit('subagent:async-started', {
    id: runId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: runDir,
    sessionId: 'C:/sessions/parent.jsonl',
  })

  // 首帧：不再压 1.2s 的探测窗口——写盘节流 200ms，最迟几百毫秒就该看见卡
  let appearedAt = 0
  for (let i = 0; i < 20; i += 1) {
    if ((readState(dataDir)?.lineages?.length ?? 0) > 0) {
      appearedAt = Date.now() - at
      break
    }
    await sleep(50)
  }
  assert.ok(appearedAt > 0, '卡片必须出现（不能「点了没反应」）')
  assert.ok(appearedAt < 900, `普通 run 不该再压首帧（实测 ${appearedAt}ms 才出现，旧逻辑要等 1.2s）`)
  assert.ok(
    !readState(dataDir)?.lineages?.[0]?.segments?.[0]?.sessionName,
    '首帧确实还没有名字——由 UI 显示「启动中」，不再摆假名字',
  )

  // 1 秒后 runner 把第一条 user 消息写进事件流
  fs.appendFileSync(
    path.join(runDir, 'events.jsonl'),
    `${JSON.stringify({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'Task: 【单链测试】工作目录: C:/w' }] },
    })}\n`,
  )
  assert.equal(
    await waitFor(() => Boolean(readState(dataDir)?.lineages?.[0]?.segments?.[0]?.sessionName)),
    true,
    '任务名该从事件流补上，不用等 status.json',
  )
  assert.equal(readState(dataDir)?.lineages?.[0]?.segments?.[0]?.sessionName, '【单链测试】工作目录: C:/w')
  assert.equal(fs.existsSync(path.join(runDir, 'status.json')), false, '整条链路都不该依赖 status.json')

  // 23 秒后 status.json 终于落盘：它给的是压缩版（首行 + 「步骤：…」压成一行）。
  // 不能把事件流那句更干净的标题顶掉——否则用户会看到标题「又变了一次」。
  fs.writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      runId,
      state: 'running',
      steps: [{ agent: 'delegate', sessionName: 'delegate: 这是一次子代理功能测试 步骤： 1. 用 bash…' }],
    }),
  )
  harness.emit('subagent:jobs-changed', {})
  await sleep(1_600)
  assert.equal(
    readState(dataDir)?.lineages?.[0]?.segments?.[0]?.sessionName,
    '【单链测试】工作目录: C:/w',
    'titleFromTask 一旦立住，status 的压缩版不该覆盖它',
  )
})

test('agent: 普通 run 的 events.jsonl 里拿不到任务名时，卡片照旧出现（只是标题留在「启动中」）', async () => {
  const { dataDir, harness } = await boot()
  await sleep(400)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-task-'))
  const runsRoot = path.join(root, 'async-subagent-runs')
  const launchesRoot = path.join(root, 'async-subagent-launches')
  const runId = '70163ad0-c082-48e6-9532-9f9134e89d9f'
  const runDir = path.join(runsRoot, runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(launchesRoot, runId), { recursive: true })
  fs.writeFileSync(
    path.join(launchesRoot, runId, 'recovery-descriptor.json'),
    JSON.stringify({ sessionFile: path.join(root, 'sessions', runId, 'run-0', 'session.jsonl') }),
  )
  // 只有 system 消息：上游哪天改了事件形状，也不该让卡片消失
  fs.writeFileSync(
    path.join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'message_start', message: { role: 'system', content: 'S' } })}\n`,
  )

  harness.emit('subagent:async-started', {
    id: runId,
    agent: 'delegate',
    cwd: 'C:/w',
    asyncDir: runDir,
    sessionId: 'C:/sessions/parent.jsonl',
  })
  assert.equal(await waitFor(() => (readState(dataDir)?.lineages?.length ?? 0) === 1), true)
  await sleep(600)
  const segment = readState(dataDir)?.lineages?.[0]?.segments?.[0]
  assert.equal(segment?.state, 'running')
  assert.ok(!segment?.sessionName, '没有名字就不写，让 UI 用「启动中」兜底')
})
