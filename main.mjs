// @ts-check
/// <reference path="../../pi-app/plugins/plugin-sdk.d.ts" />
/**
 * subagents-board — main 侧服务（入口）。
 *
 * 两件事：把 agent.mjs 落盘的 live 状态读出来，附带一份「这份数据能不能信」的判定，
 * 交给面板；以及把面板的留言投给**指定的子代理 run**（worker 侧发一次 steer RPC）。
 *
 * 契约：
 *   invoke('getState', { sessionFile }) →
 *     { ok, sessionFile, sessionKey, ownerSessionKey, liveness, degrade, source, lineages,
 *       activeCount, mail, now }
 *   invoke('getDiagnostics', { sessionFile }) → 原始 live 状态（面板的「诊断」折叠区用）
 *   invoke('openSession', { sessionFile }) → { ok }（宿主 activate：主会话可写、子会话预览）
 *   invoke('note', { sessionKey, runId, index?, agent?, mode?, message }) → { ok, id, expiresAt }
 *   invoke('stop', { sessionKey, runId }) → { ok, id, expiresAt }
 *     （两种写入都是「一消息一文件」写进 inbox/<sessionKey>/，**不等回执**；
 *       worker 里的 agent 扫到后调扩展的 steer / stop RPC，把结果写进 receipts/<id>.json，
 *       面板从 getState().mail 读。详见 lib/note-queue.mjs）
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
const { INBOX_DIR, NOTE_TTL_MS, RECEIPT_DIR, buildNote, pruneMail } = await imp('note-queue')
const { readRunSnapshot, steeringEntry, describeSteerFailure } = await imp('run-snapshot')

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
    mail: [],
    now: Date.now(),
  }
}

/**
 * 会话文件存在性探测。
 *
 * 面板每秒一次 getState，每个段最多三个候选路径——直接 statSync 就是几十次/秒。
 * 会话文件不会秒级出现又消失，5 秒的缓存足够准，也把成本压到可忽略。
 * @type {Map<string, { ok: boolean, at: number }>}
 */
const probeCache = new Map()
const PROBE_TTL_MS = 5_000

/** @param {string} file */
function existsCached(file) {
  const now = Date.now()
  const hit = probeCache.get(file)
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.ok
  let ok = false
  try {
    ok = fs.statSync(file).isFile()
  } catch {
    ok = false
  }
  if (probeCache.size > 512) probeCache.clear()
  probeCache.set(file, { ok, at: now })
  return ok
}

/**
 * 给每个段标出「打开」按钮该指向哪份会话、能不能点（报告 P8）。
 *
 * 候选由 agent 侧按优先级排好（childSessionFile → children[].sessionFile →
 * status.json 的 steps[].sessionFile），这里只做存在性判定。放在 main 而不是 UI：
 * UI 不该自己猜路径，也拿不到 fs。
 *
 * `openState` 的三种值决定卡片怎么说：
 *   ok      能打开
 *   missing 有候选但都不在磁盘上了（临时目录被清理）→ 按钮置灰，说清原因
 *   none    这条 run 本来就没有自己的会话（前台 run / 启动失败）→ 不出按钮
 * @param {any[]} lineages
 */
function decorateOpen(lineages) {
  for (const lineage of lineages) {
    for (const segment of lineage.segments ?? []) {
      const candidates = Array.isArray(segment.openCandidates) ? segment.openCandidates : []
      const target = candidates.find((file) => file && existsCached(String(file))) || ''
      segment.openTarget = target
      segment.openState = target ? 'ok' : candidates.length ? 'missing' : 'none'
    }
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
  decorateOpen(lineages)
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
    /** 最近的留言回执（按 runId 供 UI 匹配）。面板不给「已读」——我们只知道投没投出去 */
    mail: readMail(rt.ctx, state?.sessionKey ?? sessionKey, state),
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

/** 面板上最多显示多少条留言回执（按时间倒序，UI 按 runId 找最新一条） */
const MAIL_LIMIT = 24

/**
 * 投一条留言。**不等回执**——投递是 worker 侧的一次 steer RPC，结果由回执如实带回。
 *
 * P2-c 的 dispatchCommand 写完命令文件还要轮询 5s 等结果，超时就把命令撤回，
 * 于是出现「面板说没送达、几秒后子代理却真被插了话」这种无法解释的行为。
 * 现在面板写完就走，UI 通过 getState 轮询 receipts：拿不到就是拿不到（说「没等到确认」），
 * 拿到就是扩展给的确定状态（已插入 / 已排队 / 失败原因）。
 * @param {any} ctx
 * @param {any} input
 */
function postNote(ctx, input) {
  const built = buildNote(input, Date.now())
  if (!built.ok) return { ok: false, error: { code: 'bad_request', message: built.error } }
  const note = built.note
  const dir = path.join(ctx.dataDir, INBOX_DIR, note.sessionKey)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${note.id}.json`)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(note, null, 2))
    fs.renameSync(tmp, file)
  } catch (error) {
    return { ok: false, error: { code: 'write_failed', message: error instanceof Error ? error.message : String(error) } }
  }
  return { ok: true, id: note.id, expiresAt: note.createdAt + NOTE_TTL_MS }
}

/**
 * runId → 运行目录（含 status.json）。回执核对要用它读 steering 的最终结果。
 * 目录来自 live 状态里 `async-started` 事件带下来的 asyncDir。
 * @param {any} state
 */
function runDirsOf(state) {
  /** @type {Map<string, string>} */
  const map = new Map()
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments ?? []) {
      if (segment.runId && segment.asyncDir) map.set(String(segment.runId), String(segment.asyncDir))
    }
  }
  return map
}

/**
 * 读最近的留言回执。
 *
 * receipts 目录是全局的（一个 agent 只有一个收件箱身份，但多个会话共用数据目录），
 * 用 sessionKey 过滤——receipt 里带了这个字段（agent 写回执时从 note 抄过来）。
 *
 * **回执会在读的时候被「事后核对」一次**（P2′）。原因：扩展的 steer RPC 只回受理时的
 * 状态（多半是 `queued`），真正的失败——典型是「run 在你发出去的 66 毫秒后结束了」——
 * 只写进 run 自己的 status.json，并且只推给父会话。面板要是原样显示那张 queued 回执，
 * 就等于**静默丢失一条插话**：用户以为进去了，其实一个字都没落地。
 * 所以这里拿回执里的 `requestId` 去 status.json 的 `steering.recent` 里对一次，
 * 拿到 delivered / failed 就改口径。读不到就维持原样（说「已排队」，不编结果）。
 *
 * @param {any} ctx
 * @param {string} sessionKey
 * @param {any} state
 */
function readMail(ctx, sessionKey, state) {
  const dir = path.join(ctx.dataDir, RECEIPT_DIR)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const runDirs = runDirsOf(state)
  const items = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (!raw || typeof raw !== 'object') continue
      if (sessionKey && String(raw.sessionKey ?? '') !== sessionKey) continue
      /** @type {any} */
      const item = {
        id: String(raw.id ?? ''),
        kind: raw.kind === 'stop' ? 'stop' : 'note',
        runId: String(raw.runId ?? ''),
        state: String(raw.state ?? ''),
        ok: raw.ok === true,
        at: Number(raw.at) || 0,
        error: raw.error?.message ? String(raw.error.message) : '',
        requestId: String(raw.requestId ?? ''),
      }
      if (item.kind === 'note' && item.ok && item.state !== 'delivered' && item.requestId) {
        const asyncDir = runDirs.get(item.runId)
        const entry = asyncDir ? steeringEntry(readRunSnapshot(asyncDir)?.steering, item.requestId) : null
        if (entry?.state === 'delivered') {
          item.state = 'delivered'
        } else if (entry?.state === 'failed') {
          item.state = 'failed'
          item.ok = false
          item.error = describeSteerFailure(entry.reason)
        }
      }
      items.push(item)
    } catch {
      /* 半份 JSON：下一轮再看 */
    }
  }
  items.sort((a, b) => b.at - a.at)
  return items.slice(0, MAIL_LIMIT)
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
    case 'note':
    case 'stop': {
      // 面板只有两种写入：对某个 run 插话（steer）、停止它。字段校验全在 buildNote 里做，
      // UI 传来的东西一律当作不可信输入。
      return postNote(rt.ctx, {
        kind: method === 'stop' ? 'stop' : 'note',
        sessionKey: params?.sessionKey,
        runId: params?.runId,
        index: params?.index,
        agent: params?.agent,
        mode: params?.mode,
        message: params?.message,
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
  // 留言/回执留一天：够用户回看「我当时说了什么、它收到了没」，再久就是垃圾
  const staleMail = pruneMail(
    pluginContext.dataDir,
    Date.now(),
    (dir) => fs.readdirSync(dir),
    (file) => fs.statSync(file).mtimeMs,
    (file) => fs.rmSync(file, { force: true }),
  )
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
      staleMail ? `, pruned ${staleMail} stale mail file(s)` : ''
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
