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
 *     { ok, sessionFile, sessionKey, liveness, degrade, source, lineages, activeCount, now }
 *   invoke('getDiagnostics', { sessionFile }) → 原始 live 状态（面板的「诊断」折叠区用）
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
  pluginContext.log(`subagents-board active, dataDir=${pluginContext.dataDir}${removed ? `, pruned ${removed} stale file(s)` : ''}`)
  return { invoke: handleInvoke }
}

export async function deactivate() {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  rt = null
}
