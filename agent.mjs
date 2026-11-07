// @ts-check
/**
 * subagents-board — 会话进程（worker）内的 RPC 客户端。
 *
 * 职责是两件事：把 pi-subagents 的运行状态变成一份**可读的落盘快照**给面板；把面板的
 * 留言变成一次 **steer RPC**（投给指定子代理 run）。不渲染、不决策。
 *
 * 为什么不做宿主 IPC：插件 main 与 worker 之间没有可用通道（宿主 IPC 是宿主自己的）。
 * 读方向用文件（本文件写 live/、main 读）；写方向用留言邮箱（main 写 inbox/、本文件写
 * receipts/）。两边各写各的目录，零锁、无死线。
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

import { applyComplete, applyStarted, createState, isActiveState, mergeStatus } from './lib/lineage.mjs'
import { INBOX_DIR, RECEIPT_DIR, isFresh, parseNoteFileName } from './lib/note-queue.mjs'
import { ensureLiveDir, liveFileOf, writeJsonAtomic } from './lib/live-store.mjs'
import { describeSteerFailure, isReviveNoise, readRunSnapshot, resolveRunTitle } from './lib/run-snapshot.mjs'
import { childSessionFile, sessionKeyOf } from './lib/session-key.mjs'

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
/** 留言扫描间隔：面板不再等回执，500ms 只是「点完就投」的手感 */
const NOTE_POLL_MS = 500
/** stop 的 RPC 超时：扩展要中断子进程并收敛状态 */
const STOP_TIMEOUT_MS = 10_000
/**
 * steer 的 RPC 超时：扩展内部会等 3s ack 才返回，再加余量。
 * 超时只说明「没等到 RPC 回答」，不代表没投出去——回执照实说「未确认」，不编。
 */
const STEER_TIMEOUT_MS = 12_000

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
    stopNotes()
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
      // 不 unref 的话：握手失败正在重试的会话会让进程一直「有事可做」——
      // 会话已经关了、扩展也没装，进程却退不出去（测试里表现为整套跑完不退出）。
      if (typeof timer.unref === 'function') timer.unref()

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
      const started = applyStarted(state, payload, at)
      // running 阶段就把子会话路径推导出来——事件载荷到 complete 才带 sessionFile，
      // 不推导的话「子代理运行过程中」面板上没法点进对话流（实测反馈）。
      // 形状是 pi-subagents 0.86.0 实测的固定结构；多 child / workflow 的例外
      // 由 complete 的真实路径覆盖，点击时宿主还会校验文件存在，推错也只是点不开。
      const runId = String(payload?.id ?? payload?.runId ?? '')
      if (started?.segment && !started.segment.childSessionFile && sessionFile && runId) {
        started.segment.childSessionFile = childSessionFile(sessionFile, runId, 0)
      }
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

  /**
   * 用 run 自己的 status.json 补齐 RPC 不给的两样东西：**会话名（卡片标题）**与
   * **steering 计数**（P1″ / P2′，见 lib/run-snapshot.mjs 的头注释）。
   *
   * 只在活跃段上做：终态段的数据不会再变，读它只是白花 IO；而「刚结束那一刻插话
   * 失败」的回执核对在 main 侧做（那边也能读同一个文件，且不受 worker 换代影响）。
   *
   * 值没变就不写回——`lastHtml` 比对靠字段稳定，每轮都赋一个新对象会让面板重绘。
   */
  function enrichFromRunDirs() {
    let changed = false
    for (const lineage of state.lineages ?? []) {
      for (const segment of lineage.segments ?? []) {
        if (!segment.asyncDir) continue
        const active = isActiveState(segment.state) || segment.state === 'stopping'
        // 终态段的数据不会再变，但「名字缺失 / 名字是 resume 的模板废话」得补一次——
        // 补完 sessionName 就有值了，之后每次心跳都跳过，不会长期占 IO。
        if (!active && segment.sessionName && !isReviveNoise(segment.sessionName)) continue
        const snap = readRunSnapshot(segment.asyncDir)
        if (!snap) continue

        // 标题：resume 段的 sessionName 是运行时的模板首句，顺着 revivedFrom 读原 run 才拿得到真名字
        const resolved = resolveRunTitle(segment.asyncDir, snap)
        if (resolved.revivedFrom && segment.revivedFrom !== resolved.revivedFrom) {
          segment.revivedFrom = resolved.revivedFrom
          changed = true
        }
        if (resolved.title && resolved.title !== segment.sessionName) {
          segment.sessionName = resolved.title
          changed = true
        }

        // 模型 / 思考档位：卡片上不需要点开明细就能看见（报告 P3 的可视化那一半）
        const first = snap.steps?.[0]
        if (first?.model && first.model !== segment.model) {
          segment.model = first.model
          changed = true
        }
        if (first?.thinking && first.thinking !== segment.thinking) {
          segment.thinking = first.thinking
          changed = true
        }
        if (!active) continue

        if (snap.steering && JSON.stringify(snap.steering) !== JSON.stringify(segment.steering)) {
          segment.steering = snap.steering
          changed = true
        }
        // 多 child（workflow / 并行）：status 的 children 不带 sessionName，按 index 从 steps 补
        for (const child of segment.children ?? []) {
          const step = snap.steps?.find((/** @type {any} */ item) => item.index === (Number(child.index) || 0))
          if (!step) continue
          if (step.sessionName && !child.sessionName && !isReviveNoise(step.sessionName)) {
            child.sessionName = step.sessionName
            changed = true
          }
          if (step.steering) child.steering = step.steering
        }
      }
    }
    if (changed) flush()
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
      enrichFromRunDirs()
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
      // capabilities 只存了键名，值丢了；而「能不能插话」要看值（老版本扩展没有 steer）
      state.source.supports = capabilities && typeof capabilities === 'object'
        ? { steer: capabilities.steer === true, stop: capabilities.stop === true }
        : null
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

  // ---------- 留言邮箱（面板 → 子代理 run） ----------

  /**
   * 一条留言 = 对该 run 的一次 steer。这里只做三件事：校验目标、发 RPC、把扩展的回答写成回执。
   *
   * 不再自己实现状态机：`steering.state` 直接来自 pi-subagents
   * （scheduled / pending / queued / delivered），我们只把它压成面板要的两种事实——
   * 「已经进了它这一轮」和「排在它这一轮之后」。不猜、不重试、不做死线。
   */

  const inboxRoot = path.join(ctx.dataDir, INBOX_DIR)
  const receiptRoot = path.join(ctx.dataDir, RECEIPT_DIR)
  let noteWatcher = /** @type {any} */ (null)
  let notePoll = /** @type {any} */ (null)
  let scanning = false
  /** 已处理过的 note id。receipt 落盘前的一瞬靠它防重（重启后靠 receipt 文件本身判断） */
  const handled = new Set()

  function stopNotes() {
    if (noteWatcher) {
      try {
        noteWatcher.close()
      } catch {
        /* 已经关了 */
      }
      noteWatcher = null
    }
    if (notePoll) {
      clearInterval(notePoll)
      notePoll = null
    }
  }

  function startNotes() {
    try {
      fs.mkdirSync(inboxRoot, { recursive: true })
      fs.mkdirSync(receiptRoot, { recursive: true })
    } catch (error) {
      ctx.log('mail dirs unavailable:', error instanceof Error ? error.message : error)
      return
    }
    try {
      // fs.watch 只为「点完就投」的手感；Windows 上会丢事件，所以轮询是主路
      noteWatcher = fs.watch(inboxRoot, () => void scanNotes())
      if (typeof noteWatcher.unref === 'function') noteWatcher.unref()
    } catch (error) {
      ctx.log('mail watch failed, polling only:', error instanceof Error ? error.message : error)
    }
    notePoll = setInterval(() => void scanNotes(), NOTE_POLL_MS)
    if (typeof notePoll.unref === 'function') notePoll.unref()
    void scanNotes()
  }

  /**
   * 扫自己那一格 `inbox/<sessionKey>/`。
   *
   * 按会话分目录的好处：多个会话的 agent 各自读各自的目录，不需要「文件名带前缀」那种过滤，
   * 也就不需要 rename 认领（认领是为了在共享目录里抢命令，这里根本没有共享）。
   */
  async function scanNotes() {
    if (scanning || stale || disposed) return
    const key = state.sessionKey
    if (!key || key === 'unknown') return
    scanning = true
    try {
      const dir = path.join(inboxRoot, key)
      let names = []
      try {
        names = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const id = parseNoteFileName(name)
        if (!id || handled.has(id)) continue
        // 有回执 = 这一代或上一代实例已经处理过。note 不可变、id 唯一，因此幂等
        if (fs.existsSync(path.join(receiptRoot, `${id}.json`))) {
          handled.add(id)
          continue
        }
        /** @type {any} */
        let note = null
        try {
          note = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        } catch {
          continue // 正在写（半份 JSON）：下一轮再看。过期判断由 isFresh 兜底
        }
        handled.add(id)
        await runNote(note, id)
      }
    } finally {
      scanning = false
    }
  }

  /** @param {any} note @param {string} id */
  async function runNote(note, id) {
    if (!isFresh(note, Date.now())) {
      // 只有 agent 侧判过期（单端）：steer 是瞬时动作，几分钟前的留言投过去也只会撞上终态
      writeReceipt(id, note, {
        ok: false,
        state: 'expired',
        error: { code: 'expired', message: '这条已经过期，没有投递（当时父会话进程没在跑）' },
      })
      return
    }
    if (note.kind === 'stop') {
      await runStop(note, id)
      return
    }

    const runId = String(note.runId ?? '').trim()
    if (!runId) {
      writeReceipt(id, note, { ok: false, state: 'failed', error: { code: 'bad_request', message: '缺少 runId' } })
      return
    }
    /** @type {Record<string, unknown>} */
    const params = { id: runId, message: String(note.message ?? ''), mode: String(note.mode || 'steer') }
    if (Number.isInteger(note.index)) params.index = note.index

    const reply = await request('steer', params, STEER_TIMEOUT_MS)
    if (reply.ok) {
      // 扩展的 steering 收据：delivered = 已经进了它在跑的这一轮；其余都算排队。
      // 两种形状都认（RPC 回的是 { text, details:{ steering } }，老版本可能直给收据本体）
      const steering = reply.data?.details?.steering ?? reply.data ?? null
      const upstream = String(steering?.state || 'queued')
      writeReceipt(id, note, {
        ok: true,
        state: upstream === 'delivered' ? 'delivered' : 'queued',
        upstream,
        // 受理时多半只是 queued：真正的送达/失败要等扩展写进 status.json 的 steering.recent。
        // 把 requestId 落进回执，main 每次 getState 都会拿它去核对（P2′ 的「静默丢失」）。
        requestId: String(steering?.requestId ?? ''),
      })
      // status 里也记了 steering，立刻读一次让卡片上的转向提示跟上，不等心跳
      void readStatus('after-steer')
    } else {
      writeReceipt(id, note, {
        ok: false,
        state: 'failed',
        error: {
          code: reply.error?.code ?? 'failed',
          message: reply.timedOut ? '没等到扩展的确认，这条可能没进去' : describeSteerFailure(reply.error?.message),
        },
      })
    }
    ctx.log(`steer ${runId}: ${reply.ok ? 'accepted' : 'failed'}`)
  }

  /** @param {any} note @param {string} id */
  async function runStop(note, id) {
    const runId = String(note.runId ?? '').trim()
    if (!runId) {
      writeReceipt(id, note, { ok: false, state: 'failed', error: { code: 'bad_request', message: '缺少 runId' } })
      return
    }
    const reply = await request('stop', { id: runId }, STOP_TIMEOUT_MS)
    writeReceipt(
      id,
      note,
      reply.ok
        ? { ok: true, state: 'stopping' }
        : { ok: false, state: 'failed', error: reply.error ?? { code: 'failed', message: '扩展拒绝了停止请求' } },
    )
    // stop 的回执只是「受理」，真实终态要靠 status 收敛——立刻读一次，别等心跳
    if (reply.ok) void readStatus('after-stop')
    ctx.log(`stop ${runId}: ${reply.ok ? 'accepted' : 'failed'}`)
  }

  /**
   * 回执由 agent 独占写（main 只读），所以两边没有写冲突，也不需要锁。
   * 元数据（sessionKey / kind / runId）从 note 抄一份——main 读回执时靠 sessionKey 分会话、
   * 靠 runId 匹配卡片，不必再回头读 note 文件。
   * @param {string} id
   * @param {any} note
   * @param {Record<string, unknown>} payload
   */
  function writeReceipt(id, note, payload) {
    try {
      fs.mkdirSync(receiptRoot, { recursive: true })
      const file = path.join(receiptRoot, `${id}.json`)
      const tmp = `${file}.tmp`
      const receipt = {
        id,
        at: Date.now(),
        sessionKey: String(note?.sessionKey ?? ''),
        kind: note?.kind === 'stop' ? 'stop' : 'note',
        runId: String(note?.runId ?? ''),
        ...payload,
      }
      fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2))
      fs.renameSync(tmp, file)
    } catch (error) {
      ctx.log('receipt write failed:', error instanceof Error ? error.message : error)
    }
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
  startNotes()
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
