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

import { applyComplete, applyStarted, createState, isActiveState, linkRevived, mergeStatus } from './lib/lineage.mjs'
import { INBOX_DIR, RECEIPT_DIR, isFresh, parseNoteFileName } from './lib/note-queue.mjs'
import { ensureLiveDir, isUnknownLiveFile, liveFileOf, writeJsonAtomic } from './lib/live-store.mjs'
import {
  describeSteerFailure,
  isReviveNoise,
  launchKindOf,
  pendingStepsOf,
  readRunEvents,
  readRunSnapshot,
  readRunTaskText,
  resolveRunTitle,
  resumeSourceOf,
  stepLabel,
} from './lib/run-snapshot.mjs'
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
/**
 * 「需要关注」的那一档（报告 P10/P19）。`status` 在「跑着」和「卡在等人 / 卡住」时
 * 都是 `running`，只有这一项会变成 `needs_attention`。
 */
const WAITING_ACTIVITY = 'needs_attention'
/**
 * 首帧探测的节奏。
 *
 * `async-started` 到达时 runner 才刚 spawn，`status.json` 要等子进程冷启动完才落盘
 * （实测 run.started 到 agent_start 隔了 1.5s）。读到就补齐标题、接上链；读不到就每
 * 120ms 再试，10 次约 1.2s 后放弃——此时照常上屏（名字回落到 `角色 · id`），绝不
 * 「点了没反应」。
 *
 * 续跑**不走这条路**：launch 描述符在 spawn 时就写好了，当场就能接链（见 adoptStarted）。
 * 这个窗口只服务「普通 run 等标题」和「描述符缺失时的兜底」。
 */
const REVIVE_PROBE_MS = 120
const REVIVE_PROBE_TRIES = 10
/**
 * 普通 run 的任务名：从 `events.jsonl` 的第一条 user 消息取。
 *
 * 实测这段文字在 run 开始后 1~2 秒就可读，而 `status.json` 要 23 秒——卡片已经上屏了，
 * 名字却在二十秒后才到，中间那段只能显示「启动中」。150ms × 20 ≈ 3 秒够覆盖冷启动，
 * 拿不到就交给 status 正常补齐（不重试、不占 IO）。
 */
const TASK_TEXT_MS = 150
const TASK_TEXT_TRIES = 20
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
  /**
   * 续跑接链的探测定时器：runId → { tries, timer }。
   * 只用于 resume 起点那几百毫秒，接上（或放弃）就从表里删掉。
   */
  const reviveProbes = new Map()
  /** 已经认回来源段的 runId。幂等保护，避免每轮 status 都重算一遍 */
  const linkedRuns = new Set()
  /**
   * 普通 run 的「补标题」定时器集合。每个 run 最多一个，拿到任务原文（或试满）就退场；
   * 实例换代时由 stopTimers 一次性清掉。
   */
  const taskProbes = new Set()
  /**
   * 首帧延迟上屏：**只在没法判断这是不是续跑时**使用（描述符缺失，见 adoptStarted）。
   *
   * 早先它被用来「等普通 run 的标题」——那是时序赌博：`status.json` 实测要 23 秒才落盘，
   * 而压制窗口只有 1.2 秒，窗口先到点就写出一张 `delegate · abc12345` 的卡。
   * 现在普通 run 一律立刻上屏（标题显示「启动中」），任务名另走 events.jsonl 补齐；
   * 留着这条路径只为「老版本 pi-subagents 没有描述符、又可能正在续跑」的保守兜底。
   *
   * 上限就是探测窗口本身；探测有结论立刻释放，不能无限期压着——那就成了「点了没反应」。
   */
  let holdFlushUntil = 0
  let holdTimer = /** @type {any} */ (null)

  // ---------- 落盘 ----------

  /** 原子写整份状态；`updatedAt` 在写之前刷新，main 用它判活 */
  function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (disposed) return
    // 首帧还压在探测窗口里（见 holdFlushUntil）：孤卡不能上屏。
    // 这里而不是 flush() 拦，是因为 flush 只是排定时器；定时器到点时
    // 状态可能已经变了，判断得放在真正写盘这一刻。
    if (Date.now() < holdFlushUntil) return
    state.updatedAt = Date.now()
    try {
      ensureLiveDir(ctx.dataDir)
      // sessionFile 还没就位时先写 unknown- 前缀的文件：事件比 session_start 早到时
      // 不能把数据憋在内存里白丢（main 会忽略这份，等真 key 到了再写一份真的）
      state.sessionKey = sessionFile ? sessionKeyOf(sessionFile) : 'unknown'
      const target = liveFileOf(ctx.dataDir, { sessionKey: state.sessionKey, pid: state.pid, startedAt })
      writeJsonAtomic(target, state)
      if (liveFile && liveFile !== target && isUnknownLiveFile(liveFile)) {
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

  /**
   * 压住上屏，最多 `ms` 毫秒。已有更晚的截止时间就不缩短。
   * @param {number} ms
   */
  function holdFlush(ms) {
    const until = Date.now() + ms
    if (until <= holdFlushUntil) return
    holdFlushUntil = until
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = setTimeout(() => {
      holdTimer = null
      holdFlushUntil = 0
      // 兜底：探测因为任何原因没给结论（比如 status.json 一直不落盘），
      // 卡片也必须出现——宁可名字回落到 `角色 · id`，不能「点了没反应」。
      flushNow()
    }, ms)
    if (typeof holdTimer.unref === 'function') holdTimer.unref()
  }

  /**
   * 探测有结论了：立刻把这一次完整状态写出去（数据已经补齐，不用再等 200ms 节流）。
   * @returns {boolean} 这次是否真的解除了压制
   */
  function releaseFlush() {
    if (!holdTimer && !holdFlushUntil) return false
    holdFlushUntil = 0
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    flushNow()
    return true
  }

  // ---------- 实例生命周期 ----------

  function stopTimers() {
    for (const timer of [handshakeTimer, dirtyTimer, heartbeatTimer, flushTimer, holdTimer]) {
      if (!timer) continue
      clearTimeout(timer)
      clearInterval(timer)
    }
    handshakeTimer = null
    dirtyTimer = null
    heartbeatTimer = null
    flushTimer = null
    holdTimer = null
    holdFlushUntil = 0
    for (const entry of reviveProbes.values()) {
      if (entry?.timer) clearTimeout(entry.timer)
    }
    reviveProbes.clear()
    for (const timer of taskProbes) clearTimeout(timer)
    taskProbes.clear()
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
      // 载荷里没有 revivedFrom / sessionName，但**launch 描述符**里有线索（见
      // lib/run-snapshot.mjs 的 resumeSourceOf）：resume 的那一份直接指向来源会话文件。
      // 所以这里不再「先压住、等 status.json」，而是当场判定、当场接链。
      if (runId) adoptStarted(started?.segment ?? null, runId, String(payload?.asyncDir ?? ''))
      else flush()
      return
    }
    if (key === 'asyncComplete') {
      applyComplete(state, { ...payload, childParentSession: readChildParentSession(payload?.sessionFile) }, at)
      markDirty()
      // 结束事件自带真标题与终态，不用再等探测窗口
      if (!releaseFlush()) flush()
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
   * 在 live 状态里找一段（不回内存外的东西，纯查表）。
   * @param {string} runId
   */
  function findLocalSegment(runId) {
    for (const lineage of state.lineages ?? []) {
      for (const segment of lineage.segments ?? []) {
        if (String(segment.runId) === String(runId)) return segment
      }
    }
    return null
  }

  /**
   * 用 run 自己的 `status.json` 把这一段认回它的来源段（resume 的「原地复活」）。
   *
   * 为什么不等 `async-complete`：那之前的新段是一条孤链，面板上就是「又冒出一张新卡」，
   * 跑完才并进去，体感上完全不像「它又补了一句」。而 status.json 的第一帧就写了
   * `revivedFrom`（runner 构造 payload 时就带），读一次的事。
   *
   * 只在 `revivedFrom` 存在时才动：普通 run 的 `steps[0].sessionFile` 是它自己的会话，
   * 拿它去匹配「谁用过这份文件」会把 workflow 容器误搬进第一步的链里。
   * `sessionFile` 仅作为「revivedFrom 指向的段不在本会话」时的二次线索。
   *
   * @param {any} segment
   * @param {any} snap
   * @returns {boolean} 这次是否接上了
   */
  function linkIfRevived(segment, snap) {
    if (!segment || !snap) return false
    const runId = String(segment.runId ?? '')
    if (!runId) return false
    if (linkedRuns.has(runId)) return false
    const revivedFrom = String(snap.revivedFrom ?? '').trim()
    if (!revivedFrom) return false
    const file = (snap.steps ?? [])
      .map((/** @type {any} */ step) => String(step?.sessionFile ?? '').trim())
      .find(Boolean) || ''
    const hit = linkRevived(state, runId, { revivedFrom, sessionFile: file || null })
    if (!hit) return false
    // 真会话文件以 status 为准：started 阶段按新 runId 猜的那条路径在 resume 时是错的
    if (file) hit.segment.childSessionFile = file
    linkedRuns.add(runId)
    if (hit.merged) state.source.reviveLinks = (Number(state.source.reviveLinks) || 0) + 1
    ctx.log(`revive link ${runId.slice(0, 8)} ← ${revivedFrom.slice(0, 8)}${hit.merged ? ' (merged into chain)' : ''}`)
    return true
  }

  /**
   * `async-started` 之后的第一步：这次 run 是谁派生的？
   *
   * 答案不在事件载荷里，而在 **launch 描述符**（`async-subagent-launches/<runId>/
   * recovery-descriptor.json`）：它由父进程在 spawn 时就写好，`sessionFile` 直接指向
   * 这次要写/续写的子会话文件。普通 run 指向自己的新文件，resume 指向**来源 run** 的
   * 那一份——所以「我续的是谁」在事件到达的同一刻就是可读的，代价只有一次 stat。
   *
   * 于是三条路分开走：
   *   · 续跑：当场并回原链、标题回原 run 取，再写盘。**第一次上屏就是最终形态**，
   *     不会再有「新卡出现 → 消失 → 旧卡更新」那段过程（0.10.4 修的正是这个）。
   *   · 普通 run：**立刻上屏**。标题先由 UI 显示「启动中」（不会再有假名字），任务名
   *     另走 events.jsonl 的 `message_start`（实测 1~2 秒可读，见 watchTaskText——
   *     `status.json` 要 23 秒，等它等于让「启动中」挂二十秒）。
   *   · 描述符缺失（老版本 pi-subagents / 目录被清）：没法判断是不是续跑，保守压住
   *     首帧探测一次（见 holdFlush），接不上再照常出现。
   * @param {any} segment applyStarted 建/找到的那一段
   * @param {string} runId
   * @param {string} asyncDir
   */
  function adoptStarted(segment, runId, asyncDir) {
    const hint = resumeSourceOf(asyncDir, runId)
    if (!hint) {
      if (launchKindOf(asyncDir, runId) === 'plain') {
        // 描述符在、指向自己 → 确定是普通 run。压着首帧毫无收益：名字要 23 秒才到，
        // 而 UI 已经会用「启动中」占位。立刻出卡，名字走事件流补。
        flush()
        watchTaskText(runId, asyncDir)
        return
      }
      holdFlush(REVIVE_PROBE_MS * REVIVE_PROBE_TRIES)
      probeRevive(runId, asyncDir)
      return
    }

    if (segment) {
      // 线索优先「复用了同一份子会话文件」：一条 resume 链上每一段的 childSessionFile
      // 都相同，linkRevived 取**链尾**匹配，跳数才对。revivedFrom 只作次选——描述符里的
      // 路径有时指向链根（实测 8bdba4a7 → aa3ad83d，而真正的上一代是 ad1a7a90）。
      let hit = linkRevived(state, runId, { sessionFile: hint.sessionFile })
      if (!hit && hint.sourceRunId) hit = linkRevived(state, runId, { revivedFrom: hint.sourceRunId })
      if (hit) {
        // started 阶段按新 runId 猜的路径在 resume 时是错的，换成描述符里的真文件
        hit.segment.childSessionFile = hint.sessionFile
        linkedRuns.add(runId)
        if (hit.merged) state.source.reviveLinks = (Number(state.source.reviveLinks) || 0) + 1
        ctx.log(`revive link ${runId.slice(0, 8)} ← ${hint.sourceRunId.slice(0, 8) || 'same file'}${hit.merged ? ' (merged into chain)' : ''}`)
      } else {
        // 来源段不在本实例的 state 里（插件换代后才续的）：先把事实记在段上，
        // main 侧拿到的是合并过的全量数据，它那边的 relinkOrphans 能接上。
        // 接不上也不影响展示——标题照旧回原 run 取，徽标照旧算。
        segment.childSessionFile = hint.sessionFile
        if (hint.sourceRunId && !segment.revivedFrom) segment.revivedFrom = hint.sourceRunId
        ctx.log(`revive pending ${runId.slice(0, 8)} ← ${hint.sourceRunId.slice(0, 8) || 'same file'} (source not in this instance)`)
      }
      applyOriginTitle(segment, asyncDir, hint)
    }
    enrichFromRunDirs()
    if (!releaseFlush()) flush()
  }

  /**
   * 普通 run 的标题：从 `events.jsonl` 的第一条 user 消息取。
   *
   * `async-started` 载荷里的任务字段被上游 redact 成 `PROMPT_REDACTED`，而 `status.json`
   * 实测要 **23 秒**才落盘——卡片早就上屏了，名字却在二十秒后才到，中间只能显示
   * 「启动中」。事件流倒是 1~2 秒就把第一条 user 消息写进去了（`Task: <任务首句>`），
   * 那正是 status 里 `sessionName` 的来源，用它补上，两端对齐。
   *
   * 拿到就停；3 秒还没读到就作罢（status 落盘后 enrichFromRunDirs 照常补，不会丢）。
   * @param {string} runId @param {string} asyncDir
   */
  function watchTaskText(runId, asyncDir) {
    let tries = 0
    /** @type {any} */
    let timer = null
    const tick = () => {
      if (timer) taskProbes.delete(timer)
      if (stale || disposed) return
      const segment = findLocalSegment(runId)
      if (!segment) return
      // 已经有名字（status 抢先落盘，或这条其实接上了链）就别改它
      if (segment.sessionName && !isReviveNoise(segment.sessionName)) return
      const text = readRunTaskText(asyncDir)
      if (text) {
        segment.sessionName = text
        // 标记来源：status.json 落盘后 enrichFromRunDirs 会把 sessionName 换成
        // `delegate: 首行 步骤：…` 那种压缩版——用户眼里的标题会「又变一次」。
        // 事件流给的这句更干净（就是任务首行），留着它。
        segment.titleFromTask = true
        flush()
        return
      }
      tries += 1
      if (tries > TASK_TEXT_TRIES) return
      timer = setTimeout(tick, TASK_TEXT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      taskProbes.add(timer)
    }
    timer = setTimeout(tick, TASK_TEXT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    taskProbes.add(timer)
  }

  /**
   * 续跑段的标题：**回来源 run 取**，而不是等自己的 status.json。
   *
   * 续跑 run 的 `sessionName` 是模板废话（`delegate: You are reviving a previous…`），
   * 自己的 status.json 又要等子进程冷启动才落盘。来源 run 的 status.json 早就写完了，
   * 顺着 `revivedFrom` 一路往上读，第一帧就能拿到真标题和链的形状（最初那个 run）。
   * @param {any} segment @param {string} asyncDir @param {{ sessionFile: string, sourceRunId: string }} hint
   */
  function applyOriginTitle(segment, asyncDir, hint) {
    const dir = String(asyncDir ?? '').trim()
    const sourceDir = hint.sourceRunId && dir ? path.join(path.dirname(dir), hint.sourceRunId) : ''
    const resolved = sourceDir
      ? resolveRunTitle(sourceDir)
      : { title: '', revivedFrom: null, rootRunId: '', hops: 0 }
    if (resolved.title && !segment.sessionName) segment.sessionName = resolved.title
    if (resolved.rootRunId && !segment.reviveRoot) segment.reviveRoot = resolved.rootRunId
    if (hint.sourceRunId && !segment.revivedFrom) segment.revivedFrom = hint.sourceRunId
    // 跳数：linkRevived 已经按命中的链尾算过就不动它（那是最准的），没命中才自己算
    if (!Number(segment.reviveHops)) segment.reviveHops = (Number(resolved.hops) || 0) + 1
  }

  /**
   * 短轮询：run 刚起来时 status.json 可能还没落盘，读到就接，读不到就过 120ms 再试。
   * 最多 10 次（≈1.2s）——还没读到，说明进程没起来或扩展换代了，交给 complete 兜底。
   *
   * 每一条出口都必须 `releaseFlush()`：上屏被压在探测窗口里（见 holdFlushUntil），
   * 漏一条就是「卡片永远不出现」。
   * @param {string} runId @param {string} asyncDir
   */
  function probeRevive(runId, asyncDir) {
    if (stale || disposed) return
    if (linkedRuns.has(runId)) {
      reviveProbes.delete(runId)
      releaseFlush()
      return
    }
    const dir = String(asyncDir ?? '').trim()
    if (!dir) {
      releaseFlush()
      return
    }
    const segment = findLocalSegment(runId)
    const snap = readRunSnapshot(dir)
    if (snap) {
      if (segment && linkIfRevived(segment, snap)) {
        reviveProbes.delete(runId)
        // 接链只是第一步：标题、可打开的会话候选还在 status 里。顺手补齐，
        // 卡片第一次上屏就是完整形态（否则「打开」要等下一次 heartbeat 才出现）。
        enrichFromRunDirs()
        releaseFlush()
        return
      }
      // 读到了却没有 revivedFrom：这是个普通 run，别再试了（它在首帧就有，没有就是没有）
      if (!String(snap.revivedFrom ?? '').trim()) {
        reviveProbes.delete(runId)
        // 普通 run 也要先把 title / label / openCandidates 从 status 补齐再上屏——
        // 不然首帧同样是「角色 · id」，下一轮才换成任务名，白闪一次。
        enrichFromRunDirs()
        releaseFlush()
        return
      }
    }
    const tries = (Number(reviveProbes.get(runId)?.tries) || 0) + 1
    if (tries > REVIVE_PROBE_TRIES) {
      reviveProbes.delete(runId)
      releaseFlush()
      return
    }
    const timer = setTimeout(() => probeRevive(runId, dir), REVIVE_PROBE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    reviveProbes.set(runId, { tries, timer })
  }

  /**
   * 把「需要关注」拆成能看懂的一件事（报告 P19 / P20）。
   *
   * `activityState === 'needs_attention'` 在数据里有**三种**来源，卡面必须分开：
   *
   *   | reason | 真实含义 | 卡面 |
   *   |---|---|---|
   *   | `supervisor_request` | 调了 contact_supervisor，等你回答 | 等待回答 · 问题原文 |
   *   | `idle` | 60 秒无活动（可能上游请求悬住） | 无响应 · 已 N 分无活动 |
   *   | （`active_long_running`） | 还在跑，只是慢 | 运行中，不报警 |
   *
   * 判据只在事件流里，所以这里顺手读一次 `events.jsonl` 尾部——**只在真的
   * needs_attention 时读**，正常跑着的 run 一个字节都不多读。读不到（文件正在写、
   * 行被截断、目录被清理）就保留上一次的值，绝不清空：卡面在两个状态之间来回闪
   * 比停在旧状态更糟。
   *
   * 提问原文同样来自这里：它不进会话流（P20），`contact_supervisor` 的
   * `tool_execution_start/end` 按 toolCallId 配对是唯一来源，回答还带 `durationMs`。
   *
   * @param {any} segment
   * @param {any} snap readRunSnapshot 的结果
   * @param {boolean} active 这段还在跑/在停
   * @param {string} activity 已经归一过的 activityState
   * @returns {boolean} 是否有字段变化
   */
  function applyAttention(segment, snap, active, activity) {
    let changed = false
    /** @param {string} key @param {any} next */
    const put = (key, next) => {
      if ((segment[key] ?? null) === (next ?? null)) return
      segment[key] = next
      changed = true
    }

    // 「已 N 分无活动」必须用磁盘上的真实时刻；有没有超时保护决定「再等下去有没有意义」
    put('lastActivityAt', active ? Number(snap?.lastActivityAt) || null : null)
    put('hasDeadline', active ? Boolean(snap?.hasDeadline) : null)

    if (!active || activity !== WAITING_ACTIVITY) {
      // 离开「需要关注」：三样一起清，下次再进是新一轮，不能挂着上一轮的问题和起点
      put('attentionReason', null)
      put('attentionAt', null)
      put('attentionAsk', null)
      put('attentionSince', null)
      return changed
    }

    const events = segment.asyncDir ? readRunEvents(segment.asyncDir) : null
    const reason = String(events?.control?.reason ?? '')
    const at = Number(events?.control?.at) || null
    if (reason) put('attentionReason', reason)
    if (at) put('attentionAt', at)
    const ask = events?.ask && (events.ask.question || events.ask.answer) ? events.ask : null
    if (JSON.stringify(ask) !== JSON.stringify(segment.attentionAsk ?? null)) {
      segment.attentionAsk = ask
      changed = true
    }
    // 起点优先用控制事件自己的 ts（真值），读不到才用本地时钟兜底
    put('attentionSince', at || Number(segment.attentionSince) || Date.now())
    return changed
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
        // 终态段的数据不会再变，但三样东西得补一次：标题（含 label）、续跑来源、可打开的会话候选。
        // 补完就不再读，不会长期占 IO。
        const needTitle = !segment.sessionName || isReviveNoise(segment.sessionName)
        const needLabel = !segment.label
        const needOpen = !Array.isArray(segment.openCandidates)
        // 终态段还挂着「排队占位」= 旧版本写下的脏数据（普通代理的 steps[0] 曾被当成
        // 待启动的一步）。再读一次把它清掉——只清一次，清完变空就不再进这个分支。
        const stalePending = !active && (segment.pendingSteps ?? []).length > 0
        if (!active && !needTitle && !needLabel && !needOpen && !stalePending) continue
        const snap = readRunSnapshot(segment.asyncDir)
        if (!snap) continue
        // 兜底接链（0.9.9）：probe 的定时器可能被换代清掉，或者 status.json 迟于 1.6s
        // 才落盘。这里本来每秒就在读同一份 snap，顺手判一次，代价为零。
        if (linkIfRevived(segment, snap)) changed = true

        // 标题：resume 段的 sessionName 是运行时的模板首句，顺着 revivedFrom 读原 run 才拿得到真名字
        const resolved = resolveRunTitle(segment.asyncDir, snap)
        if (resolved.revivedFrom && segment.revivedFrom !== resolved.revivedFrom) {
          segment.revivedFrom = resolved.revivedFrom
          changed = true
        }
        // 徽标要指「最初那个 run」而不是直接来源：`续 be55dc91` 这种没人看得懂（P1″）
        if (resolved.rootRunId && segment.reviveRoot !== resolved.rootRunId) {
          segment.reviveRoot = resolved.rootRunId
          changed = true
        }
        if (resolved.hops !== (Number(segment.reviveHops) || 0)) {
          segment.reviveHops = resolved.hops
          changed = true
        }
        // 标题：优先留事件流给的任务首行（titleFromTask，见 watchTaskText）——
        // status 里那份是压缩版，换上等于让标题在 23 秒后自己变一次。
        if (resolved.title && resolved.title !== segment.sessionName && !segment.titleFromTask) {
          segment.sessionName = resolved.title
          changed = true
        }

        // workflow 的步骤名：卡片标题的第一顺位（P6）。`task-1` 这类占位符由 stepLabel 过滤
        const label = stepLabel(snap)
        if (label && label !== segment.label) {
          segment.label = label
          changed = true
        }

        // 可打开的会话候选（P8）：顶层 childSessionFile 常常悬空，真实的在 steps[] 里。
        // 存在性判定放 main（那边每秒读一次，顺手 stat），这里只按优先级排候选。
        /** @type {string[]} */
        const candidates = []
        if (segment.childSessionFile) candidates.push(String(segment.childSessionFile))
        for (const child of segment.children ?? []) if (child?.sessionFile) candidates.push(String(child.sessionFile))
        for (const step of snap.steps ?? []) if (step?.sessionFile) candidates.push(step.sessionFile)
        const uniq = [...new Set(candidates)]
        if (JSON.stringify(uniq) !== JSON.stringify(segment.openCandidates ?? [])) {
          segment.openCandidates = uniq
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

        // 「跑着」还是「卡在等人 / 卡住」：activityState 只说明「需要关注」，分不出三种
        // 语义（报告 P10 → P19）。真正的判据是事件流里那条 `subagent.control` 的 reason。
        const activity = active ? String(first?.activityState || snap.activityState || '') : ''
        if ((segment.activityState || '') !== activity) {
          segment.activityState = activity
          changed = true
        }
        if (applyAttention(segment, snap, active, activity)) changed = true
        // 排队中的步骤（报告 P12）：`steps[]` 里有它，但 `runId` 还是空的——没有 runId
        // 就建不出卡，容器写着「3 步」下面却只有 1 张，用户只能猜剩下的是没跑还是丢了。
        // 判定在 lib/run-snapshot.mjs 的 pendingStepsOf 里：**只对容器 run 成立**，
        // 普通代理（mode: single）的 steps[0] 是它自己，不能当占位（否则会凭空长出
        // 一张「第 1 步 · 待启动」的子卡片）。
        // 终态段一律清空：run 都结束了，不存在「还在排队等启动」的步骤。
        const pending = active ? pendingStepsOf(snap) : []
        if (JSON.stringify(pending) !== JSON.stringify(segment.pendingSteps ?? [])) {
          segment.pendingSteps = pending
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
