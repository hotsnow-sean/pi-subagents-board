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

const {
  archiveSessions,
  latestForSession,
  livenessOf,
  listSessionKeys,
  partitionStamp,
  pruneLiveFiles,
  readIndex,
  readLiveFiles,
  writeIndex,
  liveDirOf,
} = await imp('live-store')
const { normalizeSessionPath, sessionKeyOf } = await imp('session-key')
const {
  listLineages,
  activeCount,
  isActiveState,
  healFromSnapshots,
  healDeadProcesses,
  clearTerminalPending,
  adoptRevivedFromSnapshots,
  mergeLiveStates,
  pickVisible,
  lastRunIdOf,
  groupStartedAt,
  relinkOrphans,
} = await imp('lineage')
const { describeDegrade } = await imp('degrade')
const { buildInboxItem, pruneLedger, seedLedger, selectNewCompletions } = await imp('inbox-watch')
const { INBOX_DIR, NOTE_TTL_MS, RECEIPT_DIR, buildNote, pruneMail } = await imp('note-queue')
const { readRunSnapshot, isProcessAlive, steeringEntry, describeSteerFailure } = await imp('run-snapshot')

/** 面板 id：与 manifest `panels[].id` 一致，信箱条目的落点 */
const PANEL_ID = 'fleet'
/** 巡检间隔：信箱不是实时通道，5s 足够，也不至于把盘读热 */
const INBOX_SWEEP_MS = 5_000
/** 归档巡检间隔：应用可能连开好几天，不能只在启动时装订一次 */
const ARCHIVE_EVERY_MS = 10 * 60 * 1000
/** 台账文件名（dataDir 下）：已通知过的 `<sessionKey>|<runId>` */
const LEDGER_FILE = 'notified.json'

/** @type {{ ctx: any } | null} */
let rt = null
/** @type {any} */
let sweepTimer = null
/** 上一次装订归档的时刻（巡检里每 10 分钟最多一次） */
let lastArchiveAt = 0
/**
 * 最近一次「自愈」发生的时刻（`healFromSnapshots` 收到 > 0 时置位）。
 *
 * 为什么要模块级：自愈改的是**内存里的段**，live 文件一个字节都没动，`liveStamp` 的
 * 版本戳因此不变——长轮询会把「卡已经收敛成终态」当成「什么都没发生」，照样挂满 6 秒
 * 才回。缀进 rev 之后，自愈本身就是一次可见的变化，挂着的请求立刻带着新状态返回。
 */
let lastHealAt = 0

/**
 * 上一次接链自愈「搬动过哪些段」（`<sessionKey>|<runId,…>`）。
 *
 * `relinkOrphans` 改的是**内存态**，live 文件里的孤链永远还在，所以每轮读都会再搬一次
 * ——这是必要的（不搬的话那一帧就会多出一张卡），但**不能每轮都当成「数据变了」**：
 * `lastHealAt` 一变 `rev` 就变，长轮询立刻返回，下一轮又搬一次，面板会陷进 0 延迟的
 * 死循环（实测一次启动刷出两百多行 relink 日志、getState 连成一片）。只有**新出现的**
 * 孤段才算变化，其余静默。
 */
let relinkSig = ''

/**
 * 上一次判成「进程已消失」的段集合（同 `relinkSig` 的理由）。
 *
 * 判死也是**每轮重算**（live 文件里那段永远是 running），同样不能每轮都推版本戳。
 */
let deadSig = ''

/* ---------- 长轮询：数据一变就返回，没变就挂住（见 handleInvoke 的 getState） ---------- */

/** 桥的调用超时是 10s，留足余量；再长就等于把「面板卡住」做成默认体验 */
const MAX_WAIT_MS = 6_000

/** @type {import('node:fs').FSWatcher | null} */
let liveWatcher = null
/** @type {any} */
let liveWatchDebounce = null
/** 挂起中的请求：resolve 一下就把它们全部唤醒（它们各自会重新算一遍） */
/** @type {Set<() => void>} */
const waiters = new Set()

/**
 * 某个会话的版本戳：文件数 + 最大 mtime + 总大小，**只算这个会话目录**（含归档、不含索引）。
 *
 * 0.11.0 起 live 按会话分目录，不必再对根目录做前缀过滤；索引被排除在戳之外，
 * 否则「写完索引 → 戳变了 → 长轮询醒来 → 又写索引」会自激。归档算进戳：
 * 「几份旧分区装订成一份」对面板是一次真实变化。
 *
 * 前缀里的 key 必须用**数据归属的会话**（子会话预览时是父会话）：预览页拿到的是父会话
 * 的链，按子会话算会恒等于 0 个文件，永远等不到变化。
 */
function liveStamp(sessionKey) {
  if (!sessionKey) return '#0-0-0'
  return `${sessionKey}#${partitionStamp(rt.ctx.dataDir, sessionKey)}`
}

/**
 * 起一个目录监听（单例）。原子写会连发 rename/change，所以防抖 60ms 再统一唤醒——
 * 不然一次落盘能叫醒所有挂起的请求，白算好几遍。
 */
function ensureLiveWatcher() {
  if (liveWatcher) return
  const dir = liveDirOf(rt.ctx.dataDir)
  const onEvent = () => {
    if (liveWatchDebounce) return
    liveWatchDebounce = setTimeout(() => {
      liveWatchDebounce = null
      wakeWaiters()
    }, 60)
    if (typeof liveWatchDebounce.unref === 'function') liveWatchDebounce.unref()
  }
  // 0.11.0 起 live 按下会话分目录，非递归的 watch 看不见子目录里的写入——必须 recursive。
  // 个别平台/文件系统不支持 recursive，那就退回根目录监听（至少「新会话出现」还能触发），
  // 再不行就靠 waitMs 到点，功能不坏，只是不即时。
  try {
    liveWatcher = fs.watch(dir, { persistent: false, recursive: true }, onEvent)
    liveWatcher.on('error', () => closeLiveWatcher())
    return
  } catch {
    /* 换非递归再试一次 */
  }
  try {
    liveWatcher = fs.watch(dir, { persistent: false }, onEvent)
    liveWatcher.on('error', () => closeLiveWatcher())
  } catch {
    liveWatcher = null
  }
}

function closeLiveWatcher() {
  if (liveWatchDebounce) {
    clearTimeout(liveWatchDebounce)
    liveWatchDebounce = null
  }
  if (liveWatcher) {
    try {
      liveWatcher.close()
    } catch {
      // 已经关掉了
    }
    liveWatcher = null
  }
}

function wakeWaiters() {
  for (const wake of [...waiters]) {
    waiters.delete(wake)
    wake()
  }
}

/** 挂起，直到被唤醒或到点；本身不判断「变没变」——醒来后调用方重新算一遍 */
function waitForTick(ms) {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      waiters.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, Math.max(0, ms))
    if (typeof timer.unref === 'function') timer.unref()
    waiters.add(wake)
  })
}

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
    /** 空状态不带版本：没有会话就没有可等的变化，客户端会立刻再问 */
    rev: '',
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
 * `openState` 的四种值决定卡片怎么说：
 *   ok      能打开
 *   missing 有候选但都不在磁盘上了（临时目录被清理）→ 按钮置灰，说清原因
 *   none    这条 run 本来就没有自己的会话（前台 run / 启动失败）→ 不出按钮
 *   shared  候选命中的是**别人的**会话（workflow 容器 run 自己没有会话，
 *           唯一能用的是它那一步的会话）→ 不出按钮，交回那张卡，见下
 *
 * 为什么要多这一种（实测：`8a08d1b2` 与 `370599a9` 打开的是同一个文件）：
 * workflow 的父 run 是个容器，`childSessionFile` 猜出来的 `run-0/session.jsonl`
 * 并不存在，于是候选链落到 `steps[0].sessionFile`——而那正是那一步自己的 run
 * （`370599a9`）的会话，它在列表里另有一张卡。两张卡两个「打开」通向同一份文件，
 * 用户只会觉得「点错了」。谁自己的会话就由谁来提供入口。
 * @param {any[]} lineages
 */
function decorateOpen(lineages) {
  /** @type {any[]} */
  const segments = []
  /** runId → 所在链的根 @type {Map<string, string>} */
  const chainOf = new Map()
  for (const lineage of lineages) {
    for (const segment of lineage.segments ?? []) {
      segments.push(segment)
      chainOf.set(String(segment.runId ?? ''), String(lineage.lineageRoot ?? ''))
    }
  }

  /** 谁的 `childSessionFile` 是真实存在的会话文件：`归一化路径 → runId` @type {Map<string, string>} */
  const owners = new Map()
  for (const segment of segments) {
    const own = String(segment.childSessionFile ?? '').trim()
    if (!own) continue
    const key = normalizeSessionPath(own)
    if (!key || owners.has(key) || !existsCached(own)) continue
    owners.set(key, String(segment.runId ?? ''))
  }

  for (const segment of segments) {
    // 旧落盘文件没有 openCandidates（0.7.1 才补）：按老办法就地拼一份，
    // 否则升级后所有历史卡的「打开」都会消失——比修之前更糟。
    const candidates = Array.isArray(segment.openCandidates)
      ? segment.openCandidates
      : [segment.childSessionFile, ...(segment.children ?? []).map((/** @type {any} */ child) => child?.sessionFile)].filter(
          Boolean,
        )
    const target = String(candidates.find((file) => file && existsCached(String(file))) || '')
    const self = String(segment.runId ?? '')
    const owner = target ? owners.get(normalizeSessionPath(target)) : ''
    segment.openTarget = target
    if (target && owner && owner !== self) {
      // 同一条链里的另一段：resume 复用的是这份 session.jsonl，它不是「别人的会话」，
      // 而是**这条链自己的**。判成 shared 会让卡上没有「打开」，用户只能展开折叠列表
      // 去点一行历史——那正是 0.9.9 要修掉的体验（同链共用 ≠ 借用）。
      const chain = chainOf.get(self) ?? ''
      if (chain && chain === chainOf.get(owner)) {
        segment.openState = 'ok'
        segment.openOwnerRunId = ''
        segment.openShared = true
        continue
      }
      segment.openState = 'shared'
      segment.openOwnerRunId = owner
      continue
    }
    segment.openOwnerRunId = ''
    segment.openShared = false
    segment.openState = target ? 'ok' : candidates.length ? 'missing' : 'none'
  }
}

/**
 * 链上任意一段所属的父容器 run。
 *
 * resume 出来的新段自己没有 `stepOf`（父容器的 `steps[]` 里只有原 run 的 id），
 * 但同一条链属于同一个父——所以沿整条链找，不是只看最后一段。
 * @param {any} lineage
 * @param {Map<string, string>} parentOf
 */
function ownerOf(lineage, parentOf) {
  for (const segment of lineage.segments ?? []) {
    const owner = parentOf.get(String(segment.runId ?? ''))
    if (owner) return owner
  }
  return ''
}

/**
 * 把 workflow 容器和它各步骤的 run 认成父子，并把子卡排到父卡后面。
 *
 * 依据是磁盘上的事实：容器的 `status.json` 里 `steps[].runId` 就是那一步的 run id，
 * 而那个 run 在列表里是独立一张卡（扩展对每一步都单独发 started / completed）。
 * 不按 agent 名推断（父与子可能同名），也不靠「容器借了谁的会话」——fanout 多步时
 * 那样只能认出一个。
 *
 * 打标：
 *   父段 `containerOf = [子 runId…]`、`containerDone = 已结束的步数`
 *   子段 `stepOf = 父 runId`、`stepLabel = 那一步的名字`
 *
 * 排序：子卡紧跟父卡。用户读的是「这个 workflow 干了什么」，子卡散在时间序里
 * 就得靠 sessionName 猜它们是一伙的。
 *
 * 父卡不在列表里（跨代际 live 文件、只收到子 run 的事件）时子卡保持顶层，
 * 只是没有缩进——降级好过凭空造一个空壳父卡。
 * @param {any[]} lineages
 */
function linkContainers(lineages) {
  /** @type {Map<string, any>} */
  const byRun = new Map()
  for (const lineage of lineages) {
    for (const segment of lineage.segments ?? []) {
      if (segment.runId) byRun.set(String(segment.runId), segment)
    }
  }

  /** 子 runId → 父 runId @type {Map<string, string>} */
  const parentOf = new Map()
  for (const [runId, segment] of byRun) {
    if (!segment.asyncDir) continue
    const snap = readRunSnapshot(segment.asyncDir)
    if (!snap || snap.mode !== 'workflow') continue
    /** @type {string[]} */
    const kids = []
    for (const step of snap.steps ?? []) {
      const id = String(step.runId ?? '').trim()
      if (id && id !== runId && byRun.has(id) && !kids.includes(id)) kids.push(id)
    }
    if (!kids.length) continue
    segment.containerOf = kids
    segment.containerDone = kids.filter((id) => !isActiveState(byRun.get(id)?.state)).length
    for (const [index, id] of kids.entries()) {
      const kid = byRun.get(id)
      kid.stepOf = runId
      // 步骤序号：子卡按它排，不按「谁最后说话」——workflow 的读法是先做了什么
      kid.stepIndex = index
      parentOf.set(id, runId)
    }
  }

  /** 子链在父的 steps[] 里的位置（resume 出来的新段自己没有，沿链找） */
  const stepOrderOf = (/** @type {any} */ lineage) => {
    for (const segment of lineage.segments ?? []) {
      if (Number.isFinite(segment.stepIndex)) return Number(segment.stepIndex)
    }
    return Number.MAX_SAFE_INTEGER
  }

  /** 父 runId → 子链 @type {Map<string, any[]>} */
  const childrenOf = new Map()
  for (const lineage of lineages) {
    const owner = ownerOf(lineage, parentOf)
    if (!owner) continue
    const list = childrenOf.get(owner) ?? []
    list.push(lineage)
    childrenOf.set(owner, list)
  }
  for (const list of childrenOf.values()) list.sort((a, b) => stepOrderOf(a) - stepOrderOf(b))

  /** @type {any[]} */
  const ordered = []
  const emitted = new Set()
  /** 递归展开：workflow 里再开 workflow 时，孙卡要跟着自己的父走，不能掉到末尾 */
  const emit = (/** @type {any} */ lineage) => {
    if (emitted.has(lineage)) return
    ordered.push(lineage)
    emitted.add(lineage)
    for (const child of childrenOf.get(lastRunIdOf(lineage)) ?? []) emit(child)
  }
  /**
   * 组的排序：**按组内最晚启动的那一段**，倒序。
   *
   * 0.9.9 起不再用「最近活动」，因为那让并行运行的几张卡随谁刚调完一个工具互相插队，
   * 读起来一直在跳。改用启动时间后，位置只在「它被启动」时移动一次；0.8.8 撤掉
   * 「运行中置顶」想解决的「完成那刻跳位」也从根上消失了（键没有翻转的余地）。
   *
   * workflow 取组内最大值：子步骤十分钟后启动，确实意味着「这里又起了个新 run」，
   * 整组往前挪一格才对——否则推进中的工作流会一直卡在很下面，像停了。
   *
   * 不在跑的卡靠 `pickVisible` 的保底保证不被裁掉，靠后可以滚动找到，消失不行。
   */
  const roots = lineages.filter((lineage) => !ownerOf(lineage, parentOf))
  roots.sort((a, b) => groupStartedAt(b, childrenOf) - groupStartedAt(a, childrenOf))
  for (const lineage of roots) emit(lineage)
  // 父卡不可见的子卡：保持原时间序追加，不能因为认不出父就藏起来
  for (const lineage of lineages) if (!emitted.has(lineage)) ordered.push(lineage)
  lineages.splice(0, lineages.length, ...ordered)
}

/**
 * 标出「用户此刻正在看的那张卡」。
 *
 * 打开子会话后面板进入只读预览（`parentSessionFile` 非空），列表里那一段正是
 * 眼前这份内容。给它按「返回」而不是「打开」，用户不用靠路径或标题猜自己在看谁；
 * 也顺手避免「点打开 → 打开的还是自己」这种无反馈的操作。
 *
 * 只标**链尾段**：一条链的各段共用同一份 session.jsonl（resume 复用），从第 1 段到
 * 最后一段的 `openTarget` 都指向同一份文件。全标的话，历史段也会各挂一个「返回」，
 * 而卡片上只渲染链尾——多出来的标记没有去处，只会让数据变得难以解释。
 * @param {any[]} lineages
 * @param {string} currentFile 面板当前的会话文件（预览时 = 子会话）
 * @param {string} parentSessionFile 非空才有「返回」可去
 */
function markViewing(lineages, currentFile, parentSessionFile) {
  const current = normalizeSessionPath(currentFile)
  for (const lineage of lineages) {
    const segments = lineage.segments ?? []
    const tail = segments[segments.length - 1]
    for (const segment of segments) {
      const viewing =
        Boolean(parentSessionFile) &&
        Boolean(current) &&
        segment === tail &&
        segment.openState === 'ok' &&
        normalizeSessionPath(segment.openTarget) === current
      segment.viewing = viewing
      segment.viewBackTo = viewing ? parentSessionFile : ''
    }
  }
}

/**
 * 同一会话的**全部代**合并成一份（而不是「取最新那一份」）。
 *
 * live 文件按实例分文件（`<sessionKey>-<pid>-<startedAt>.json`）：每换一次会话/重开
 * 软件就多一份，新实例的 state 是空的。只读最新那份的话，刚开软件会**丢掉上一代
 * 写下的历史**（status 只报还在跑的，补不回来），看起来就是「一开始没刷新」；
 * 上一代记下的终态也会跟着一起丢。
 *
 * 合并规则见 `mergeLiveStates`：同 runId 以更新的那一代为准，只有老一代才有的段保留；
 * 顶层字段（判活、能力、数据源）仍取最新一代。
 *
 * @param {string} dataDir
 * @param {string} sessionKey
 */
function mergedForSession(dataDir, sessionKey) {
  const items = readLiveFiles(dataDir, sessionKey)
  if (!items.length) return null
  items.sort((a, b) => (Number(a.state.startedAt) || 0) - (Number(b.state.startedAt) || 0))
  const newest = items[items.length - 1]
  // 还在写的那几份。0 = 只剩归档（实例都退出了），降级判定要据此走「历史」而不是
  // 「没连上 pi-subagents」——归档没有 source，那不是故障（见 lib/degrade.mjs）。
  const livePartitions = items.filter((item) => item.kind === 'partition').length
  if (items.length === 1) return { ...newest, generations: 1, livePartitions }
  return {
    ...newest,
    state: mergeLiveStates(items.map((item) => item.state)),
    generations: items.length,
    livePartitions,
  }
}

/**
 * 每会话上次写索引时的指纹：会话 key → `<分区戳>|<updatedAt>|<代数>`。
 * 指纹没变就不重写——否则「读一次就写一次」，读路径变写路径。
 * @type {Map<string, string>}
 */
const indexStamps = new Map()

/**
 * 写索引。**派生数据**：坏了、没有都能从分区重建，`getState` 不读它。
 *
 * 只服务两件事：反查「这段子会话属于谁」（`findOwnerOf`）与诊断。以前反查要把所有
 * 会话的所有代读出来逐段比路径，现在读每个会话一份小索引就够。
 * @param {string} sessionKey @param {any} state @param {number} generations
 */
function refreshIndex(sessionKey, state, generations) {
  if (!state || !sessionKey || !rt) return
  const dir = rt.ctx.dataDir
  const stamp = `${partitionStamp(dir, sessionKey)}|${Number(state.updatedAt) || 0}|${generations}`
  if (indexStamps.get(sessionKey) === stamp) return
  indexStamps.set(sessionKey, stamp)
  /** @type {any[]} */
  const segments = []
  for (const lineage of state.lineages ?? []) {
    for (const segment of lineage.segments ?? []) segments.push(indexSegment(segment))
  }
  try {
    writeIndex(dir, sessionKey, {
      version: 2,
      sessionKey,
      sessionFile: state.sessionFile ?? '',
      startedAt: Number(state.startedAt) || 0,
      updatedAt: Date.now(),
      generations: Number(generations) || 1,
      segments,
    })
  } catch (error) {
    // 索引写不进去不影响面板，下次指纹变了会重试
    try {
      rt?.ctx?.log?.('index write failed:', error instanceof Error ? error.message : error)
    } catch {
      // 日志失败就算了
    }
  }
}

/** 索引里的一段：够反查、够诊断，不带摘要正文 */
function indexSegment(/** @type {any} */ segment) {
  return {
    runId: segment?.runId ?? '',
    agent: segment?.agent ?? '',
    state: segment?.state ?? '',
    startedAt: Number(segment?.startedAt) || 0,
    endedAt: Number(segment?.endedAt) || 0,
    durationMs: Number(segment?.durationMs) || 0,
    sessionName: segment?.sessionName ?? '',
    label: segment?.label ?? '',
    childSessionFile: segment?.childSessionFile ?? '',
    revivedFrom: segment?.revivedFrom ?? '',
    reviveRoot: segment?.reviveRoot ?? '',
    reviveHops: Number(segment?.reviveHops) || 0,
    children: (segment?.children ?? []).map((/** @type {any} */ child) => ({
      index: child?.index ?? null,
      agent: child?.agent ?? '',
      sessionName: child?.sessionName ?? '',
      sessionFile: child?.sessionFile ?? '',
    })),
  }
}

/**
 * 面板最多铺多少张卡：合并跨代之后条数会变多，右栏是「最近在干什么」不是档案库。
 *
 * 这是**软上限**——只约束「已经结束、而且结束得够久」的历史卡。运行中的、以及刚结束
 * 不到 `RECENT_ENDED_MS` 的卡无条件保留（见 `pickVisible`）：一刀切时间线会把长跑但
 * 静默的卡切掉，用户就「看不到还在跑的子代理」。
 */
const MAX_CARDS = 20

/**
 * 这一帧「会被接链自愈搬走」的段（runId 升序）。
 *
 * 判据与 `relinkOrphans` 一致：段上有 `revivedFrom`，而来源 run 在**另一条链**里。
 * 只用来做去重签名——搬动本身还是交给 `relinkOrphans`，免得两处判定各写一遍逻辑走偏。
 * @param {any} state
 */
function orphanCandidates(state) {
  /** @type {Map<string, string>} runId → 它所在链的 lineageRoot */
  const rootOf = new Map()
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments ?? []) {
      rootOf.set(String(segment?.runId ?? ''), String(lineage?.lineageRoot ?? ''))
    }
  }
  /** @type {string[]} */
  const out = []
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments ?? []) {
      const from = String(segment?.revivedFrom ?? '').trim()
      if (!from) continue
      const owner = rootOf.get(from)
      if (owner && owner !== String(lineage?.lineageRoot ?? '')) out.push(String(segment?.runId ?? ''))
    }
  }
  return out.sort()
}

/** @param {string} sessionFile */
function stateFor(sessionFile) {
  if (!rt) {
    return emptyState({
      kind: 'inactive',
      tone: 'info',
      title: '插件正在卸载',
      detail: '稍等片刻，或重新打开这个面板。',
    })
  }
  const file = String(sessionFile ?? '').trim()
  if (!file) {
    return emptyState({
      kind: 'no-session',
      tone: 'info',
      // 同 no-data：这是「现在没东西可看」，不是出了问题，画空态框而不是警示横幅
      asEmpty: true,
      title: '没有打开会话',
      detail: '子代理记录跟着会话走。先在左侧打开一个会话，这里会显示它的子代理。',
    })
  }
  const sessionKey = sessionKeyOf(file)
  let latest = mergedForSession(rt.ctx.dataDir, sessionKey)
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
  // 自愈：扩展实例换代/退出会漏掉这一轮最后一次 async-complete（卡就永远停在运行中）。
  // run 自己的 status.json 才是地面真相，main 一直活着，每轮顺手核对一遍。
  const healed = state ? healFromSnapshots(state, readRunSnapshot) : 0
  if (healed) {
    lastHealAt = Date.now()
    // 自愈是「漏了事件」的证据：留一行日志，下次再出现「卡片停在运行中」时
    // 能直接看出是事件没到（healed>0）还是轮询/渲染那边停了（healed=0）
    try {
      rt?.ctx?.log?.(`healed ${healed} segment(s) from run snapshots`)
    } catch {
      // 日志失败不影响主流程
    }
  }
  // 「进程已经没了，status.json 却还写着 running」：应用重启把 runner 子进程带走了，
  // 没有谁再会去写终态。判据只有 pid（见 lib/lineage.mjs 的 healDeadProcesses）——
  // 不处理的话卡片会永远转圈，停止按钮点了也没人接。
  if (state) {
    const lostNow = healDeadProcesses(state, readRunSnapshot, isProcessAlive)
    if (lostNow) {
      const ids = []
      for (const lineage of state.lineages ?? []) {
        for (const segment of lineage.segments ?? []) {
          if (segment.state === 'lost' && segment.lostPid) ids.push(String(segment.runId ?? ''))
        }
      }
      const sig = `${sessionKey}|${ids.sort().join(',')}`
      if (sig !== deadSig) {
        deadSig = sig
        lastHealAt = Date.now()
        try {
          rt?.ctx?.log?.(`marked ${lostNow} run(s) as lost: runner process is gone`)
        } catch {
          // 日志失败不影响主流程
        }
      }
    } else {
      deadSig = ''
    }
  }
  // 读侧抹掉旧版本写下的「排队占位」脏数据：扩展只有新会话才换代，不清的话
  // 用户得等到下次开会话，那张幽灵子卡才会消失（见 lib/lineage.mjs 的注释）。
  if (state) clearTerminalPending(state)
  // 读侧接链自愈（0.9.9）：插件在 resume 中途重启时，那段会以孤链留在 live 文件里。
  // 每轮顺手认一次（幂等）；命中时改的是内存态，live 文件没动，所以要一并推 `lastHealAt`
  // 让长轮询醒来——否则用户得等下一轮文件变化才看得见。
  let relinked = 0
  if (state) {
    // 先补「上一代没写完的归属」：活跃段如果还没记 revivedFrom，就从它自己的 status.json
    // 里读一次。worker 只看得见本代，main 合并了所有代——首帧写得太早的那几张孤卡，
    // 在这里被认回来（0.10.4）。
    adoptRevivedFromSnapshots(state, readRunSnapshot)
    // 先记下「这次要搬哪些段」，搬完再比对：签名没变就说明只是把上一帧已经搬过的
    // 又搬了一遍（live 文件没被改写），不该再推 `lastHealAt`——否则长轮询永不休眠。
    //
    // 签名**只跟孤段集合走**，不由「本轮有没有搬」决定。接链是内存态，磁盘上那份分区
    // 还是孤的、归档更永远不会被重写，所以同一批孤段会一轮轮地搬；用「本轮没搬就清空」
    // 的写法，两个面板实例轮流调（中心视图 + 右栏）就会各推一次唤醒。
    const pendingOrphans = orphanCandidates(state)
    const relinkSigNow = pendingOrphans.length ? `${sessionKey}|${pendingOrphans.join(',')}` : ''
    relinked = relinkOrphans(state)
    if (relinkSigNow !== relinkSig) {
      relinkSig = relinkSigNow
      // 集合变空不推唤醒；真的搬动了才推（内存态修正要让挂起的请求立刻看见）
      if (relinked) {
        lastHealAt = Date.now()
        try {
          rt?.ctx?.log?.(`relinked ${relinked} orphan segment(s) into their source chain`)
        } catch {
          // 日志失败不影响主流程
        }
      }
    }
  }
  const liveness = livenessOf(state)
  // 索引在自愈/接链之后写：反查要的是修正后的形状（孤链已并回、漏掉的终态已收敛）
  refreshIndex(state?.sessionKey || sessionKey, state, latest?.generations ?? 1)
  const degrade = describeDegrade(state, liveness, Date.now(), {
    livePartitions: latest?.livePartitions ?? 1,
  })
  const all = state ? listLineages(state) : []
  // 保底 + 补位的裁剪：运行中 / 刚结束的卡不参与上限竞争，剩余名额才按时间序给历史卡。
  const picked = pickVisible(all, { limit: MAX_CARDS })
  const lineages = picked.shown
  const hiddenCards = picked.hidden
  decorateOpen(lineages)
  // 父子关系与排序放在打开判定之后：shared 判定要先按「谁自己的会话」跑一遍，
  // linkContainers 只改层级标记和顺序，不动 openTarget。
  linkContainers(lineages)
  markViewing(lineages, file, parentSessionFile)
  return {
    ok: true,
    sessionFile: file,
    sessionKey,
    /** 数据版本戳：长轮询回传给 main，相同就说明「自上次以来什么都没变」。
     *  按**数据归属的会话**算（预览子会话时 state 是父会话的），否则版本戳会恒为 0 个文件。
     *
     *  后面还要缀上**视图身份**（当前上下文会话 + 是否预览）：`viewing` / 「返回主会话」
     *  这些标记只跟「我在看哪份会话」有关，live 文件一个字节都没变。只按 live 文件算戳，
     *  打开/返回之后带回来的旧戳仍然相等 → 长轮询照样挂满 6 秒，用户看到的就是
     *  「点了打开/返回，按钮半天才变」。视图变了也是一次真变化，必须算进戳里。
     *
     * 最后缀上**自愈时刻**（`h<ts>`）：自愈只改内存里的段，live 文件不动，不缀的话
     * 「卡刚被收敛成终态」这件事在戳上等于没发生。缀上之后自愈立刻唤醒长轮询，
     * 延迟从「最多等满 6 秒」变成一到就到。 */
    rev: `${liveStamp(state?.sessionKey || sessionKey)}|${sessionKeyOf(file)}${parentSessionFile ? 'p' : ''}|h${lastHealAt}`,
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
    /** 这一份是几代实例合并出来的（>1 说明换过实例，历史靠合并保住） */
    generations: latest?.generations ?? 0,
    /** 更早的卡被上限挡掉了多少张（诊断区如实说，不做静默截断） */
    hiddenCards,
    /** 其中「保底保留」的卡数（运行中 + 刚结束），它们不占上限名额 */
    pinnedCards: picked.pinned,
    /** 本次有几张卡是按 run 的 status.json 收敛的终态（>0 = 漏过事件，已被纠正） */
    healed,
    /** 本次有几段孤链被认回来源链（>0 = 上次 resume 中途重启过，历史已收敛） */
    relinked,
  }
}

/**
 * 反查「这段会话是谁的 child」。
 *
 * 0.11.0 起不再读全量状态：每个会话目录有一份 `index.json`（段摘要 + 子会话路径），
 * 只按索引匹配就能定位到会话，命中后再走一次完整读。索引不存在（新会话还没写过）
 * 就跳过——那种会话不可能含有我们正在找的历史 child。
 * @param {string} dataDir
 * @param {string} sessionFile
 */
function findOwnerOf(dataDir, sessionFile) {
  const target = normalizeSessionPath(sessionFile)
  if (!target) return null
  let bestKey = ''
  let bestStartedAt = -1
  for (const key of listSessionKeys(dataDir)) {
    const index = readIndex(dataDir, key)
    let hit = false
    let startedAt = Number(index?.startedAt) || 0
    if (index) {
      hit = (index.segments ?? []).some((/** @type {any} */ segment) => segmentMatchesChild(segment, target))
    } else {
      // 索引还没写（迁移后第一次、或写失败了）：读这个会话的分区兜底。
      // 索引是派生数据，读路径不能因为它缺席就失去功能。
      const files = readLiveFiles(dataDir, key)
      hit = files.some((item) => stateMatchesChild(item.state, target))
      if (hit) startedAt = Math.max(...files.map((item) => Number(item.state?.startedAt) || 0), 0)
    }
    if (!hit) continue
    if (startedAt > bestStartedAt) {
      bestStartedAt = startedAt
      bestKey = key
    }
  }
  if (!bestKey) return null
  return mergedForSession(dataDir, bestKey)
}

/** 索引里的一段是否指向 target（子会话路径已归一化） */
function segmentMatchesChild(/** @type {any} */ segment, /** @type {string} */ target) {
  const own = normalizeSessionPath(segment?.childSessionFile)
  if (own && own === target) return true
  return (segment?.children ?? []).some(
    (/** @type {any} */ child) => normalizeSessionPath(child?.sessionFile) === target,
  )
}

/** 没有索引时的兜底：直接看状态里的段 */
function stateMatchesChild(/** @type {any} */ state, /** @type {string} */ target) {
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage?.segments ?? []) {
      if (segmentMatchesChild(segment, target)) return true
    }
  }
  return false
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
  // 巡检要覆盖**没打开的会话**，只能按会话目录遍历（readLiveFiles 现在只读一个会话）。
  // 文件解析有 mtime+size 缓存，这里每 5s 一次的代价仍然很小。
  /** @type {any[]} */
  const files = []
  for (const key of listSessionKeys(ctx.dataDir)) files.push(...readLiveFiles(ctx.dataDir, key))
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
    case 'getState': {
      const file = String(params?.sessionFile ?? '').trim()
      const state = stateFor(file)
      const waitMs = Math.max(0, Math.min(Number(params?.waitMs) || 0, MAX_WAIT_MS))
      // 三种情况立刻回：没要求等 / 没带版本 / 客户端手上的版本已经旧了（有变化）
      if (!waitMs || !params?.rev || params.rev !== state.rev || !file) return state
      ensureLiveWatcher()
      const deadline = Date.now() + waitMs
      // 「醒」不等于「本会话变了」：live 目录是所有会话共用的，别的会话落盘也会唤醒。
      // 所以醒来就重算一遍，版本没变继续等，直到真变了或者到点。
      while (Date.now() < deadline) {
        await waitForTick(deadline - Date.now())
        if (!rt) return state
        const next = stateFor(file)
        if (next.rev !== params.rev) return next
      }
      return rt ? stateFor(file) : state
    }
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
      // 跳转改的是「我在看哪份会话」，live 文件一个字节都没动：挂着的长轮询不会
      // 因为这次跳转自己醒过来。主动放它们重算一遍（rev 里缀了视图身份，变了就
      // 立刻返回），别让按钮等到 6 秒到点才换字。
      wakeWaiters()
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
  // 热重载会带着旧实例的目录监听和挂起请求进来：先收干净，否则两个 watcher 一起唤醒
  closeLiveWatcher()
  wakeWaiters()
  rt = { ctx: pluginContext }
  // 先装订再清理：把「已经下班、卡都结束」的分区合成一份 archive，目录常态回到 3 个文件。
  // 归档只在启动时和巡检里做（见 sweepTimer），读路径不写盘。
  // isAlive 一并传下去：安静但活着的实例不能被搬（见 lib/live-store.mjs 的 archiveSessions）。
  const archived = archiveSessions(pluginContext.dataDir, { isAlive: isProcessAlive })
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
  lastArchiveAt = Date.now()
  sweepTimer = setInterval(() => {
    if (!rt) return
    try {
      sweepInbox(rt.ctx)
    } catch (error) {
      rt.ctx.log('inbox sweep failed:', error instanceof Error ? error.message : error)
    }
    // 应用可能连着开好几天：归档不能只在启动时做，否则一个会话又攒出十来份分区。
    // 10 分钟一次，代价是 20 个目录的 stat。
    if (Date.now() - lastArchiveAt >= ARCHIVE_EVERY_MS) {
      lastArchiveAt = Date.now()
      try {
        const result = archiveSessions(rt.ctx.dataDir, { isAlive: isProcessAlive })
        if (result.files) rt.ctx.log(`archived ${result.files} idle live partition(s)`)
      } catch (error) {
        rt.ctx.log('archive failed:', error instanceof Error ? error.message : error)
      }
    }
  }, INBOX_SWEEP_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  pluginContext.log(
    `subagents-board active, dataDir=${pluginContext.dataDir}${
      archived.files ? `, archived ${archived.files} idle live partition(s)` : ''
    }${removed ? `, pruned ${removed} stale live file(s)` : ''}${
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
  // 先把挂起的请求放走，再清 rt：醒来那一侧会先看到 `!rt`，直接返回手里那份旧状态，
  // 而不是拿 null 去读盘。
  closeLiveWatcher()
  wakeWaiters()
  rt = null
}
