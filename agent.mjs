// @ts-check
/**
 * subagents-board — 会话进程（worker）内的 RPC 客户端。
 *
 * 职责就一件事：把 pi-subagents 的运行状态变成一份**可读的落盘快照**，给 main 侧
 * 的面板读。不渲染、不决策，UI 的一切都从 `live/<sessionKey>-<pid>-<startedAt>.json` 来。
 *
 * 为什么不做宿主 IPC：插件 main 与 worker 之间没有可用通道（宿主 IPC 是宿主自己的）。
 * 读方向用文件（本文件写、main 读），写方向（steer/stop）在 P2-c 用命令队列，同一条思路。
 *
 * 三条实测教训（P0 得来，别重犯）：
 *   1. 扩展实例会随会话切换换代：`pi` 立刻作废，再碰就抛 stale。**每个实例必须能识别
 *      自己已死并停掉定时器**，否则每 5s 一次的轮询会刷满日志。
 *   2. 事件名公告在 `ready` 事件的 `payload.events` 里，不在 `ping.capabilities` 里
 *      （两处都读，取并集）。
 *   3. `jobs-changed` 2.7~14 次/秒。**绝不能每条都发一次 status**：事件只置脏标记，
 *      1s 定时器合并成一次请求。
 *
 * 这里对 lib/ 用**静态 import**：宿主的热重载只作用于 main 侧入口（靠 `?v=` 传染
 * 模块缓存），agent 入口在 worker 里、随会话创建加载一次，改代码要新会话才生效——
 * 静态 import 不会造成「新旧两代模块并存」，反而更简单。
 */

import fs from 'node:fs'
import path from 'node:path'

import { applyComplete, applyStarted, createState, mergeStatus } from './lib/lineage.mjs'
import { ensureLiveDir, liveFileOf, writeJsonAtomic } from './lib/live-store.mjs'
import { sessionKeyOf } from './lib/session-key.mjs'

const RPC_VERSION = 1
/** 事件合并窗口：jobs-changed 一秒能来十几次 */
const DIRTY_MERGE_MS = 1000
/** 推送模式下的心跳：没有事件也要刷新 updatedAt，否则 main 会判陈旧 */
const HEARTBEAT_PUSH_MS = 5_000
/** 轮询模式下的间隔（握手一直失败时还能看见东西） */
const HEARTBEAT_POLL_MS = 2_000
/** 握手重试间隔表：先密后疏，封顶 20s。pi-subagents 没装时会一直重试 */
const RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000]
const MAX_STATUS_FAILURES = 3

/**
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{ pluginId: string, pluginDir: string, dataDir: string, log: (...a: unknown[]) => void }} ctx
 */
export default function subagentsBoard(pi, ctx) {
  const startedAt = Date.now()
  const state = createState({ sessionKey: 'unknown', sessionFile: '', pid: process.pid, startedAt })

  let sessionFile = ''
  let liveFile = ''
  let disposed = false
  let stale = false
  let seq = 0
  let statusFailures = 0
  let dirty = false
  /** ready 事件里的事件名公告：握手成功后用它订阅，不写进落盘状态 */
  let readyEvents = /** @type {any} */ (null)
  let handshakeTimer = /** @type {any} */ (null)
  let dirtyTimer = /** @type {any} */ (null)
  let heartbeatTimer = /** @type {any} */ (null)
  const subscribed = new Set()

  let flushTimer = /** @type {any} */ (null)

  // ---------- 落盘 ----------

  /** 原子写整份状态；`updatedAt` 在写之前刷新，main 用它判活 */
  function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (disposed) return
    state.updatedAt = Date.now()
    try {
      ensureLiveDir(ctx.dataDir)
      // sessionFile 还没就位时先写 unknown- 前缀的文件：事件比 session_start 早到时
      // 不能把数据憋在内存里白丢（main 会忽略这份，等真 key 到了再写一份真的）
      state.sessionKey = sessionFile ? sessionKeyOf(sessionFile) : 'unknown'
      const target = liveFileOf(ctx.dataDir, { sessionKey: state.sessionKey, pid: state.pid, startedAt })
      writeJsonAtomic(target, state)
      if (liveFile && liveFile !== target && path.basename(liveFile).startsWith('unknown-')) {
        // 真 key 到了，把临时那份删掉，别给 main 留垃圾
        try {
          fs.rmSync(liveFile, { force: true })
        } catch {
          /* 删不掉就让清理逻辑处理 */
        }
      }
      liveFile = target
    } catch (error) {
      ctx.log('live write failed:', error instanceof Error ? error.message : error)
    }
  }

  /** 节流：200ms 内的多次变更合成一次写 */
  function flush() {
    if (disposed) return
    if (flushTimer) return
    flushTimer = setTimeout(flushNow, 200)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  // ---------- 实例生命周期 ----------

  function stopTimers() {
    for (const timer of [handshakeTimer, dirtyTimer, heartbeatTimer, flushTimer]) {
      if (!timer) continue
      clearTimeout(timer)
      clearInterval(timer)
    }
    handshakeTimer = null
    dirtyTimer = null
    heartbeatTimer = null
    flushTimer = null
  }

  /**
   * 识别「这个扩展实例已经死了」。
   *
   * pi 在 newSession / fork / switchSession / reload 之后会把整代扩展 ctx 作废。
   * 这不是异常路径而是常态：worker 切会话 = 新的一代，工厂会被重新调用一次，
   * 旧实例的定时器却还活着。死因只记一次（轮询每 5s 触发一次，重复打印会刷满日志）。
   * @param {unknown} error
   */
  function markStale(error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/stale after session replacement/.test(message)) return false
    if (stale) return true
    stale = true
    stopTimers()
    state.source.lastError = 'instance replaced by a newer session (stale)'
    ctx.log('instance is stale (session replaced) — stopping timers')
    flushNow()
    return true
  }

  // ---------- RPC ----------

  /**
   * 发一条 RPC 请求。回执走 `subagents:rpc:v1:reply:<requestId>` 一次性监听，
   * 超时也要 resolve（返回 `timedOut`）——上层要能区分「没回」和「回了个失败」。
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   */
  function request(method, params = {}, timeoutMs = 6_000) {
    const requestId = `board-${process.pid}-${++seq}-${method}`
    return new Promise((resolve) => {
      let settled = false
      /** @param {any} result */
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, timedOut: true, error: { code: 'timeout', message: `no reply to ${method}` } }), timeoutMs)

      try {
        pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (/** @type {any} */ reply) => {
          finish(
            reply?.success === true
              ? { ok: true, data: reply.data ?? null }
              : { ok: false, data: null, error: reply?.error ?? { code: 'rpc_failed', message: 'rpc replied without error detail' } },
          )
        })
        pi.events.emit('subagents:rpc:v1:request', { version: RPC_VERSION, requestId, method, params })
      } catch (error) {
        if (markStale(error)) {
          finish({ ok: false, error: { code: 'stale', message: 'instance replaced' } })
          return
        }
        finish({ ok: false, error: { code: 'emit_failed', message: String(error) } })
      }
    })
  }

  /**
   * 订阅扩展公告的事件名。
   * 事件名在 `ready.payload.events` 与 `ping.capabilities.events` 两处，取并集；
   * 排除 RPC 通道自己的名字（ready/request/replyPrefix）。
   * @param {any} events
   */
  function subscribeEvents(events) {
    if (!events || typeof events !== 'object') return
    for (const [key, name] of Object.entries(events)) {
      if (typeof name !== 'string' || !name || subscribed.has(name)) continue
      if (key === 'ready' || key === 'request' || key === 'replyPrefix') continue
      subscribed.add(name)
      try {
        pi.events.on(name, (/** @type {any} */ payload) => onEvent(key, name, payload))
      } catch (error) {
        markStale(error)
        ctx.log(`subscribe ${name} failed:`, error instanceof Error ? error.message : error)
      }
    }
    state.source.events = [...subscribed]
    flush()
  }

  /**
   * 事件只做两件事：把已知载荷并进状态；置脏标记等合并后的 status。
   * @param {string} key ready.payload.events 里的键名
   * @param {string} _name 实际事件名（诊断用）
   * @param {any} payload
   */
  function onEvent(key, _name, payload) {
    if (stale || disposed) return
    const at = Date.now()
    if (key === 'asyncStarted') {
      applyStarted(state, payload, at)
      markDirty()
      flush()
      return
    }
    if (key === 'asyncComplete') {
      applyComplete(state, { ...payload, childParentSession: readChildParentSession(payload?.sessionFile) }, at)
      markDirty()
      flush()
      return
    }
    // jobsChanged / childStatus / processTerminal 等：只说明「变了」，具体内容靠 status
    markDirty()
  }

  function markDirty() {
    dirty = true
    if (dirtyTimer) return
    dirtyTimer = setTimeout(() => {
      dirtyTimer = null
      if (!dirty) return
      dirty = false
      void readStatus('dirty')
    }, DIRTY_MERGE_MS)
    if (typeof dirtyTimer.unref === 'function') dirtyTimer.unref()
  }

  /** 读一次 status 并并进状态；连续失败会切到轮询模式 */
  async function readStatus(/** @type {string} */ why) {
    if (stale || disposed) return null
    const reply = await request('status', {}, 8_000)
    if (reply.ok) {
      statusFailures = 0
      state.source.lastReplyAt = Date.now()
      state.source.lastError = null
      mergeStatus(state, reply.data, Date.now())
      flush()
      return reply
    }
    statusFailures += 1
    state.source.lastError = reply.error?.message ?? (reply.timedOut ? `status 无回复（${why}）` : 'status 失败')
    if (statusFailures >= MAX_STATUS_FAILURES && state.source.mode === 'push') {
      // 推送通道看起来死了：降级成轮询，能看但慢一拍
      state.source.mode = 'poll'
      restartHeartbeat(HEARTBEAT_POLL_MS)
      ctx.log('status failed repeatedly — switching to poll mode')
    }
    flush()
    return reply
  }

  function restartHeartbeat(/** @type {number} */ intervalMs) {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = setInterval(() => {
      if (stale || disposed) {
        stopTimers()
        return
      }
      void readStatus('heartbeat')
    }, intervalMs)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  }

  /**
   * 握手：ping 一次，成功则订阅事件 + 读 status；失败则排下一次重试。
   * `ready` 事件到达时也会调一次（它比我们晚的情况）。
   * @param {string} why
   */
  async function handshake(why) {
    if (stale || disposed) return
    state.source.handshake.attempts = (Number(state.source.handshake.attempts) || 0) + 1
    const reply = await request('ping', {}, 4_000)
    if (reply.ok) {
      state.source.rpc = true
      state.source.handshake.ping = true
      state.source.handshake.at = Date.now()
      state.source.handshake.lastError = null
      state.source.mode = state.source.mode === 'poll' ? 'poll' : 'push'
      const capabilities = /** @type {any} */ (reply.data)?.capabilities
      state.source.capabilities = capabilities && typeof capabilities === 'object' ? Object.keys(capabilities) : []
      subscribeEvents(capabilities?.events)
      subscribeEvents(readyEvents?.events)
      readyEvents = null
      restartHeartbeat(state.source.mode === 'poll' ? HEARTBEAT_POLL_MS : HEARTBEAT_PUSH_MS)
      ctx.log(`rpc ok (${why}), events=${[...subscribed].join(',') || 'none'}`)
      flush()
      await readStatus(`after-ping:${why}`)
      return
    }

    state.source.rpc = false
    state.source.mode = 'none'
    state.source.handshake.ping = false
    state.source.handshake.lastError = reply.error?.message ?? (reply.timedOut ? 'ping 无回复' : 'ping 失败')
    flush()
    if (stale || disposed) return
    const previous = Number(state.source.handshake.attempts) || 1
    const delay = RETRY_DELAYS[Math.min(previous - 1, RETRY_DELAYS.length - 1)]
    if (handshakeTimer) clearTimeout(handshakeTimer)
    handshakeTimer = setTimeout(() => void handshake('retry'), delay)
    if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref()
  }

  // ---------- 会话 ----------

  try {
    pi.on('session_start', (/** @type {any} */ _event, /** @type {any} */ sessionCtx) => {
      const file = sessionCtx?.sessionManager?.getSessionFile?.() ?? sessionCtx?.sessionFile ?? ''
      if (typeof file === 'string' && file) {
        sessionFile = file
        state.sessionFile = file
        state.sessionKey = sessionKeyOf(file)
      }
      flush()
    })
  } catch (error) {
    ctx.log('session_start hook failed:', error instanceof Error ? error.message : error)
  }

  if (!pi.events) {
    // 没有事件总线：面板要能说清原因，而不是空白
    state.source.lastError = 'this host build does not expose pi.events'
    flushNow()
    ctx.log('no pi.events — subagents RPC unavailable')
    return
  }

  // ready 可能在我们注入之前就发过（插件扩展排在宿主扩展之后加载），所以两条路都走：
  // 监听 + 主动 ping。错过 ready 时 ping 是唯一还活着的证据。
  try {
    pi.events.on('subagents:rpc:v1:ready', (/** @type {any} */ payload) => {
      if (stale || disposed) return
      state.source.handshake.ready = true
      state.source.handshake.at = Date.now()
      // 事件名公告在这里；先存着，handshake 成功后一起订阅
      readyEvents = payload ?? null
      if (state.source.rpc) subscribeEvents(/** @type {any} */ (payload)?.events)
      else void handshake('ready-event')
      flush()
    })
  } catch (error) {
    ctx.log('subscribe ready failed:', error instanceof Error ? error.message : error)
  }

  void handshake('boot')
  // 兜底心跳：即使一次事件都没来过，也让 main 知道「这个实例还活着」
  restartHeartbeat(HEARTBEAT_PUSH_MS)
  flushNow()

  return undefined
}

/**
 * 读子会话首行的 `parentSession`。
 *
 * resume 出来的新 child，其会话文件首行的 `parentSession` 指向前一段的子会话——
 * 这是把「同一个人的第 N 次开口」接成一条链的唯一公开线索（事件载荷里没有
 * `revivedFrom`，那是 status.json 私有文件才有的字段）。读不到就算了，链路退化
 * 成两条独立卡片，比报错好。
 * @param {unknown} file
 * @returns {string | null}
 */
function readChildParentSession(file) {
  if (typeof file !== 'string' || !file) return null
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, read).toString('utf8').split('\n')[0]
    const header = JSON.parse(firstLine)
    if (header?.type !== 'session') return null
    const parent = header.parentSession
    if (typeof parent === 'string' && parent) return parent
    if (parent && typeof parent === 'object' && typeof parent.file === 'string') return parent.file
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 关不掉不影响结果 */
      }
    }
  }
}
