// @ts-check
/// <reference path="../../pi-app/plugins/plugin-sdk.d.ts" />
/**
 * subagents-board — main 侧服务（入口）。
 *
 * P2-a 阶段只做**数据打通**：把 agent.mjs 落盘的 live 状态读出来，附带一份
 * 「这份数据能不能信」的判定，交给面板。不做 steer/stop（P2-c），不发信箱。
 *
 * 契约：
 *   invoke('getState', { sessionFile }) →
 *     { ok, sessionFile, sessionKey, ownerSessionKey, liveness, degrade, source, lineages, activeCount, now }
 *   invoke('getDiagnostics', { sessionFile }) → 原始 live 状态（面板的「诊断」折叠区用）
 *   invoke('openSession', { sessionFile }) → { ok }（宿主 activate：主会话可写、子会话预览）
 *   invoke('steer', { sessionKey, runId, index?, message, mode? }) → { ok, receipt, error }
 *   invoke('stop', { sessionKey, runId, index? }) → { ok, receipt, error }
 *     （steer/stop 走文件命令队列：写 cmd/ → worker 里的 agent 认领执行 → 写 cmd-result/，
 *       main 等 5s。详见 lib/cmd-queue.mjs）
 *
 * ── 多文件结构与热重载 ─────────────────────────────────────────────────────
 *
 * lib/ 的模块引用一律走 imp() 动态加载并透传 `?v=`：宿主热重载把版本号编进入口
 * URL（按插件目录最大 mtime），静态 import 会丢掉 query、命中旧模块缓存。
 * ⚠️ lib/ 里禁止出现指向插件内文件的静态 import。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, 'lib', `${name}.mjs`)).href + Q)

const { latestForSession, livenessOf, pruneLiveFiles, readLiveFiles, liveDirOf } = await imp('live-store')
const { normalizeSessionPath, sessionKeyOf } = await imp('session-key')
const { listLineages, activeCount } = await imp('lineage')
const { describeDegrade } = await imp('degrade')
const { buildInboxItem, pruneLedger, seedLedger, selectNewCompletions } = await imp('inbox-watch')
const { CMD_DIR, CLAIM_DIR, RESULT_DIR, REPLY_WAIT_MS, buildCommand, commandFileName } = await imp('cmd-queue')

/** 面板 id：与 manifest `panels[].id` 一致，信箱条目的落点 */
const PANEL_ID = 'fleet'
/** 巡检间隔：信箱不是实时通道，5s 足够，也不至于把盘读热 */
const INBOX_SWEEP_MS = 5_000
/** 台账文件名（dataDir 下）：已通知过的 `<sessionKey>|<runId>` */
const LEDGER_FILE = 'notified.json'

/** @type {{ ctx: any } | null} */
let rt = null
/** @type {any} */
let sweepTimer = null

/**
 * 会话上下文里拿不到 sessionFile 时也返回一份可渲染的结果：
 * 面板空白是最糟的默认值，用户会以为是插件坏了。
 * @param {any} degrade
 */
function emptyState(degrade) {
  return {
    ok: true,
    sessionFile: '',
    sessionKey: '',
    ownerSessionKey: '',
    liveness: { alive: false, ageMs: null, updatedAt: 0 },
    degrade,
    source: null,
    lineages: [],
    activeCount: 0,
    now: Date.now(),
  }
}

/** @param {string} sessionFile */
function stateFor(sessionFile) {
  const file = String(sessionFile ?? '').trim()
  if (!file) {
    return emptyState({
      kind: 'no-session',
      tone: 'info',
      title: '没有打开会话',
      detail: '子代理记录跟着会话走。先在左侧打开一个会话，这里会显示它的子代理。',
    })
  }
  const sessionKey = sessionKeyOf(file)
  let latest = latestForSession(rt.ctx.dataDir, sessionKey)
  let state = latest?.state ?? null
  // 反查：当前是一段子会话的**只读预览**（面板上下文跟着预览会话走），
  // 而 live 数据按父会话存——扫一遍找到「谁的 child 是它」，显示父会话的链。
  // 这样预览子会话时右栏还能看到那条链，也给「返回主会话」按钮提供落点。
  let parentSessionFile = ''
  if (!state || !(state.lineages ?? []).length) {
    const owner = findOwnerOf(rt.ctx.dataDir, file)
    if (owner) {
      latest = owner
      state = owner.state
      parentSessionFile = state.sessionFile ?? ''
    }
  }
  const liveness = livenessOf(state)
  const degrade = describeDegrade(state, liveness)
  const lineages = state ? listLineages(state) : []
  return {
    ok: true,
    sessionFile: file,
    sessionKey,
    /**
     * 数据所属的会话 key（≠ sessionKey 时说明当前是子会话预览，链是父会话的）。
     * 命令队列按它投递：插话要发给「跑着这条链的那个会话进程」，不是被预览的子会话。
     */
    ownerSessionKey: state?.sessionKey ?? sessionKey,
    /** 非空 = 当前视图是子会话预览；UI 据此显示「返回主会话」 */
    parentSessionFile,
    liveness,
    degrade,
    source: state?.source ?? null,
    lineages,
    activeCount: state ? activeCount(state) : 0,
    now: Date.now(),
    /** 数据文件路径：诊断折叠区显示，用户排查「为什么没数据」时最有用 */
    dataFile: latest?.file ?? '',
  }
}

/**
 * 反查「这段会话是谁的 child」。live 文件按父会话 key 存，遍历比 childSessionFile
 * （路径归一化后比较：事件里的路径与面板上下文里的写法可能差斜杠方向与大小写）。
 * @param {string} dataDir
 * @param {string} sessionFile
 */
function findOwnerOf(dataDir, sessionFile) {
  const target = normalizeSessionPath(sessionFile)
  if (!target) return null
  let best = null
  for (const item of readLiveFiles(dataDir)) {
    for (const lineage of item.state?.lineages ?? []) {
      for (const segment of lineage.segments ?? []) {
        if (segment.childSessionFile && normalizeSessionPath(segment.childSessionFile) === target) {
          if (!best || (Number(item.state.startedAt) || 0) > (Number(best.state.startedAt) || 0)) best = item
        }
      }
    }
  }
  return best
}

/** @param {any} ctx */
function ledgerPath(ctx) {
  return path.join(ctx.dataDir, LEDGER_FILE)
}

/** 三个命令目录的绝对路径 @param {any} ctx */
function cmdDirs(ctx) {
  return {
    cmd: path.join(ctx.dataDir, CMD_DIR),
    claim: path.join(ctx.dataDir, CLAIM_DIR),
    result: path.join(ctx.dataDir, RESULT_DIR),
  }
}

/**
 * 清理命令目录：未认领的、认领后没写完的、没人读的结果。
 *
 * 不清理的话，下次启动时那条陈旧命令会被某个 agent 扫到并**执行**——
 * 用户早就不记得自己点过什么了（计划 §5.5 的 30s 规则）。
 * @param {any} ctx
 * @param {number} now
 */
function pruneCommandDirs(ctx, now) {
  const dirs = cmdDirs(ctx)
  let removed = 0
  for (const [dir, ttlMs] of /** @type {[string, number][]} */ ([
    [dirs.cmd, 30_000],
    [dirs.claim, 30_000],
    [dirs.result, 120_000],
  ])) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const full = path.join(dir, name)
        if (now - fs.statSync(full).mtimeMs > ttlMs) {
          fs.rmSync(full, { force: true })
          removed += 1
        }
      } catch {
        /* 正被别的进程动：跳过 */
      }
    }
  }
  return removed
}

let commandSeq = 0

/**
 * 投一条命令给 worker 里的 agent，等它带回收执。
 *
 * 死线是 `REPLY_WAIT_MS`（5s）：超时后**把命令撤掉**，否则会出现
 * 「面板说没送达，几秒后子代理却真的被插了话」——这种不可解释的行为比失败更糟。
 * agent 侧用同一个窗口校验（`isExpired(..., REPLY_WAIT_MS)`），两端口径一致。
 * @param {any} ctx
 * @param {any} input
 */
async function dispatchCommand(ctx, input) {
  const built = buildCommand(input, Date.now())
  if (!built.ok) return { ok: false, error: { code: 'bad_request', message: built.error } }
  const command = built.command
  commandSeq += 1
  command.id = `${Date.now().toString(36)}-${commandSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  const dirs = cmdDirs(ctx)
  const name = commandFileName(command.sessionKey, command.id)
  const resultFile = path.join(dirs.result, `${command.id}.json`)
  try {
    for (const dir of [dirs.cmd, dirs.claim, dirs.result]) fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dirs.cmd, `${name}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(command, null, 2))
    fs.renameSync(tmp, path.join(dirs.cmd, name))
  } catch (error) {
    return { ok: false, error: { code: 'queue_failed', message: error instanceof Error ? error.message : String(error) } }
  }

  const deadline = Date.now() + REPLY_WAIT_MS
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(resultFile)) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
        try {
          fs.rmSync(resultFile, { force: true })
        } catch {
          /* 留着由 TTL 清 */
        }
        return result
      }
    } catch {
      /* 还没写完（半份 JSON）：下一轮再看 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // 超时：撤掉还没被认领的那份（已被认领的撤不掉，但 agent 会用同一个窗口判过期）
  try {
    fs.rmSync(path.join(dirs.cmd, name), { force: true })
  } catch {
    /* 已被认领 */
  }
  return {
    ok: false,
    action: command.action,
    runId: command.runId,
    error: {
      code: 'timeout',
      message: '该子代理所属的会话已经不活跃，命令没能送达（切回那个会话再试一次）',
    },
  }
}

/** 读台账；坏了就重来（丢的是「已通知」标记，最坏结果是重复通知一次） @param {any} ctx */
function readLedger(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(ctx), 'utf8'))
    return raw && typeof raw === 'object' ? /** @type {Record<string, number>} */ (raw) : {}
  } catch {
    return {}
  }
}

/** @param {any} ctx @param {Record<string, number>} ledger */
function writeLedger(ctx, ledger) {
  try {
    const file = ledgerPath(ctx)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2))
    fs.renameSync(tmp, file)
  } catch (error) {
    ctx.log('ledger write failed:', error instanceof Error ? error.message : error)
  }
}

/**
 * 巡检一次：把新结束的 run 投进宿主信箱。
 *
 * 只做「值得你知道」的那一层——完整记录在面板里，条目点开回到那段会话。
 * 宿主的 `dedupeKey` 再兜一层：同一 run 重复投递也只留一条。
 * @param {any} ctx
 */
function sweepInbox(ctx) {
  const inbox = ctx.ui?.inbox
  if (typeof inbox !== 'function') return
  const files = readLiveFiles(ctx.dataDir)
  if (!files.length) return
  const ledger = readLedger(ctx)
  // 启动/热重载时把「早就结束」的段记进台账，不发通知：否则每次重启都会把历史重播一遍
  const seeded = seedLedger(files, ledger, Date.now())
  const pending = selectNewCompletions(files, ledger)
  for (const entry of pending) {
    try {
      inbox(buildInboxItem(entry, ctx.pluginId, PANEL_ID))
      ledger[entry.key] = Date.now()
    } catch (error) {
      ctx.log('inbox push failed:', error instanceof Error ? error.message : error)
    }
  }
  const pruned = pruneLedger(ledger, Date.now())
  if (pending.length || seeded || pruned) writeLedger(ctx, ledger)
}

/**
 * @param {any} method
 * @param {any} params
 */
async function handleInvoke(method, params) {
  switch (method) {
    case 'getState':
      return stateFor(params?.sessionFile)
    case 'getDiagnostics': {
      const file = String(params?.sessionFile ?? '').trim()
      if (!file) return { ok: false, error: 'no sessionFile' }
      const latest = latestForSession(rt.ctx.dataDir, sessionKeyOf(file))
      return {
        ok: true,
        liveDir: liveDirOf(rt.ctx.dataDir),
        dataFile: latest?.file ?? '',
        mtimeMs: latest?.mtimeMs ?? null,
        state: latest?.state ?? null,
      }
    }
    case 'openSession': {
      // 「回到/看一眼这段会话」→ 宿主二分：在当前工作区侧栏就**正常激活**（可写，
      // 「返回主会话」用的就是它），不在（子会话、跨工作区）才只读预览。
      // activate 是宿主 0.7.7-fork 之后的能力；旧宿主回落到 reveal（恒为预览）。
      const target = String(params?.sessionFile ?? '').trim()
      if (!target) return { ok: false, error: 'no sessionFile' }
      const sessions = rt.ctx.sessions
      const jump = typeof sessions.activate === 'function' ? sessions.activate : sessions.reveal.bind(sessions)
      const revealed = await jump(target)
      return { ok: Boolean(revealed), sessionFile: target }
    }
    case 'steer':
    case 'stop': {
      // 干预只作用于后台 async run（计划 §5.7）。字段校验全在 buildCommand 里做：
      // UI 传来的东西一律当作不可信输入。
      return dispatchCommand(rt.ctx, {
        action: method,
        sessionKey: params?.sessionKey,
        runId: params?.runId,
        index: params?.index,
        message: params?.message,
        mode: params?.mode,
      })
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

/** @param {any} pluginContext */
export async function activate(pluginContext) {
  // 热重载会再调一次 activate：旧实例的定时器必须先停，否则两个巡检并存、台账互相覆盖
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  rt = { ctx: pluginContext }
  const removed = pruneLiveFiles(pluginContext.dataDir)
  const staleCommands = pruneCommandDirs(pluginContext, Date.now())
  // 先巡检一次：把历史终态段记进台账（不发通知），之后只发新增的
  sweepInbox(pluginContext)
  sweepTimer = setInterval(() => {
    if (!rt) return
    try {
      sweepInbox(rt.ctx)
    } catch (error) {
      rt.ctx.log('inbox sweep failed:', error instanceof Error ? error.message : error)
    }
  }, INBOX_SWEEP_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  pluginContext.log(
    `subagents-board active, dataDir=${pluginContext.dataDir}${removed ? `, pruned ${removed} stale live file(s)` : ''}${
      staleCommands ? `, pruned ${staleCommands} stale command file(s)` : ''
    }`,
  )
  return { invoke: handleInvoke }
}

export async function deactivate() {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  rt = null
}
