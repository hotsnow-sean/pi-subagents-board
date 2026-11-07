// @ts-check
/**
 * 读一次 run 自己的 `status.json`（只读快照，带 mtime 缓存、失败一律返回 null）。
 *
 * 为什么需要它：RPC `status` 的投影（`projectRun` / `projectStep`）**只给了
 * `label`，没有 `sessionName`，也没有 `steering`**。于是两件事在面板上都缺数据：
 *
 *   1. 运行中的卡片标题（P1″）：`sessionName` 要等 run 完成才从 `async-complete`
 *      的 `results[]` 里拿到，运行中只能显示角色名；实测它其实在启动后 5–15 秒就
 *      落进了 status.json，只是没人去读。
 *   2. 插话到底进没进去（P2′）：`steering.requested/delivered/failed` 与每条请求的
 *      `targets[].state / reason` 只在 status.json 里。扩展的 steer RPC 只回「受理时」
 *      的状态，之后失败只会推给父会话——面板不二次核对就等于静默丢失。
 *
 * 取舍：读的是扩展的**私有产物**，格式可能变。所以这里全部容错——字段缺、JSON 坏、
 * 文件太大、路径消失，都返回 null 或空，让调用方退回「没有这份数据」的行为，
 * 绝不因为读不到而影响面板其它部分。
 *
 * 只取需要的字段：sessionName / steering / state，不搬 recentOutput、messagePreview
 * 那类内容（面板不需要，也不该在插件的数据目录里留一份副本）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** status.json 超过这个大小就跳过：workflow 大 run 的文件能到几 MB，读它不值当 */
const MAX_BYTES = 512 * 1024
/** 缓存条数上限：长跑会话里历史 run 的目录会越攒越多 */
const MAX_CACHE = 64

/** @type {Map<string, { mtimeMs: number, size: number, snapshot: any }>} */
const cache = new Map()

/** @param {unknown} value */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 归一 steering 汇总。
 *
 * 形状（pi-subagents 0.86.0 实测）：
 * ```json
 * { "requested": 2, "scheduled": 0, "pending": 0, "delivered": 1, "failed": 1, "recovered": 0,
 *   "recent": [{ "id": "...", "requestedAt": 1794052674959,
 *                "targets": [{ "index": 0, "state": "failed", "reason": "run became complete before ..." }] }] }
 * ```
 * `recent` 只留最后 20 条：面板要的是「最近这条怎么了」，不是审计日志。
 * @param {any} raw
 */
export function normalizeSteering(raw) {
  if (!raw || typeof raw !== 'object') return null
  const recent = Array.isArray(raw.recent) ? raw.recent.slice(-20) : []
  return {
    requested: num(raw.requested),
    scheduled: num(raw.scheduled),
    pending: num(raw.pending),
    delivered: num(raw.delivered),
    failed: num(raw.failed),
    recovered: num(raw.recovered),
    recent: recent
      .map((/** @type {any} */ entry) => ({
        id: String(entry?.id ?? ''),
        at: num(entry?.requestedAt),
        targets: (Array.isArray(entry?.targets) ? entry.targets : []).map((/** @type {any} */ target) => ({
          index: Number.isFinite(target?.index) ? Number(target.index) : 0,
          state: String(target?.state ?? ''),
          reason: typeof target?.reason === 'string' ? target.reason : '',
          deliveredAt: num(target?.deliveredAt) || null,
        })),
      }))
      .filter((/** @type {any} */ entry) => entry.id),
  }
}

/** 已知失败原因的翻译表：原文是给机器看的英文，面板要给人话 */
const REASONS = /** @type {Array<[RegExp, string]>} */ ([
  [/run became complete before/i, '它刚好在这一刻结束了，这条没进去'],
  [/is not running|cannot be steered|not active|no running child|no active/i, '它已经结束了，这条没进去'],
  [/pending supervisor ask|blocked on/i, '它在等你回答一个问题，先回复它再插话'],
  [/no live run directory|not found/i, '找不到它的运行目录（可能已经清理）'],
])

/**
 * 把扩展的失败原因翻成人话。认不出来就原样带上——猜比沉默更糟，
 * 但也不能把「没投进去」错说成别的。
 * @param {unknown} reason
 */
export function describeSteerFailure(reason) {
  const text = String(reason ?? '').trim()
  if (!text) return '这条没投进去'
  for (const [pattern, message] of REASONS) if (pattern.test(text)) return message
  return `这条没投进去：${text}`
}

/**
 * 在 steering 汇总里查一条请求的最终结果。
 *
 * 聚合规则按「对人最有用」排：任一目标失败 → 失败（并给出原因）；全部送达 → 送达；
 * 其余（pending / scheduled / queued）→ 取第一个目标的状态，表示「还在路上」。
 * @param {any} steering normalizeSteering 的结果
 * @param {unknown} requestId
 */
export function steeringEntry(steering, requestId) {
  const id = String(requestId ?? '')
  if (!steering || !id) return null
  const entry = (steering.recent ?? []).find((/** @type {any} */ item) => item.id === id)
  if (!entry) return null
  const targets = entry.targets ?? []
  const failed = targets.find((/** @type {any} */ target) => target.state === 'failed')
  if (failed) return { id, state: 'failed', reason: String(failed.reason ?? '') }
  if (targets.length && targets.every((/** @type {any} */ target) => target.state === 'delivered')) {
    return { id, state: 'delivered', reason: '' }
  }
  return { id, state: String(targets[0]?.state ?? 'pending'), reason: '' }
}

/**
 * 读并归一一份 run 快照；路径空、文件不在、JSON 坏、太大 → null。
 * @param {unknown} asyncDir `async-started` 事件里的 asyncDir（= 含 status.json 的目录）
 */
export function readRunSnapshot(asyncDir) {
  const dir = String(asyncDir ?? '').trim()
  if (!dir) return null
  const file = path.join(dir, 'status.json')

  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null

  const hit = cache.get(dir)
  // mtime + size 都没变就当没变：面板每秒一次 getState，不能每次都解析 JSON
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.snapshot

  /** @type {any} */
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }

  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map((/** @type {any} */ step, /** @type {number} */ index) => ({
    index: Number.isFinite(step?.index) ? Number(step.index) : index,
    agent: typeof step?.agent === 'string' ? step.agent : '',
    sessionName: typeof step?.sessionName === 'string' ? step.sessionName.trim() : '',
    state: String(step?.status ?? ''),
    model: typeof step?.model === 'string' ? step.model : '',
    thinking: typeof step?.thinking === 'string' ? step.thinking : '',
    /**
     * workflow 的步骤名（实测 `第一步-取数` / `标签A-回声`）。**这是编排者给这一步起的名字**，
     * 比 sessionName（子代理的任务首行）更像卡片标题。等于 `workflowKey` 时是占位符
     * （实测 `task-1`），ownTitle 会把它过滤掉（报告 P6）。
     */
    label: typeof step?.label === 'string' ? step.label.trim() : '',
    workflowKey: typeof step?.workflowKey === 'string' ? step.workflowKey.trim() : '',
    /**
     * step 自己的会话文件。顶层 run 的 `childSessionFile` 常常指向一个**不存在**的路径
     * （实测 4 个 workflow 父 run 全部如此），而这里的是真实存在的那一份（报告 P8）。
     */
    sessionFile: typeof step?.sessionFile === 'string' ? step.sessionFile.trim() : '',
    steering: normalizeSteering(step?.steering),
  }))

  const snapshot = {
    runId: String(raw?.runId ?? ''),
    state: String(raw?.state ?? ''),
    endedAt: num(raw?.endedAt) || null,
    /** resume 出来的一次续跑：指向原 run。有了它就等于拿到「这张卡原来叫什么」的钥匙 */
    revivedFrom: typeof raw?.revivedFrom === 'string' && raw.revivedFrom.trim() ? raw.revivedFrom.trim() : null,
    /** 扩展将来若把 `options.name` 落地（报告 P1′），就在这里；现在恒为空 */
    name: typeof raw?.name === 'string' ? raw.name.trim() : '',
    steps,
    steering: normalizeSteering(raw?.steering),
  }

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot })
  return snapshot
}

/** 测试用：清掉 mtime 缓存（同一个 tmp 目录被复写时 mtime 可能不变） */
export function clearRunSnapshotCache() {
  cache.clear()
}

/**
 * resume 出来的 run，`sessionName` 是运行时的模板首句，不是任务名。
 * 实测（报告 P1″）：`delegate: You are reviving a previous subagent conversation. Origin…`
 */
const REVIVE_NOISE = /reviving a previous subagent conversation/i

/** @param {unknown} text */
export function isReviveNoise(text) {
  return REVIVE_NOISE.test(String(text ?? ''))
}

/** 一次 resume 最多往回追几跳：正常只有一跳，连环 resume 也就两跳 */
const MAX_HOPS = 4

/**
 * workflow 步骤名里「有意义」的那个：等于 `workflowKey` 的是占位符
 * （实测单个 step 的 workflow 会退化成 `task-1`），跳过。
 * @param {any} snap
 */
export function stepLabel(snap) {
  for (const step of snap?.steps ?? []) {
    const label = String(step?.label ?? '').trim()
    if (label && label !== String(step?.workflowKey ?? '').trim()) return label
  }
  return ''
}

/**
 * 从一份快照里挑出「这段跑的是什么」。优先级（报告 P6）：
 *
 *   1. `name`——扩展将来落地 `options.name` 时，那才是人给的名字；
 *   2. **有意义的 `label`**——workflow 的步骤名（见 `stepLabel`）；
 *   3. 第一个不像复活提示语的 `sessionName`。
 *
 * label 排在 sessionName 前面：sessionName 是「交给子代理的那段话」的截断，
 * 而 label 是编排者给这一步起的名字——后者才该出现在卡面上。
 * @param {any} snap
 */
function ownTitle(snap) {
  const name = String(snap?.name ?? '').trim()
  if (name) return name
  const label = stepLabel(snap)
  if (label) return label
  const step = (snap?.steps ?? []).find(
    (/** @type {any} */ item) => item.sessionName && !isReviveNoise(item.sessionName),
  )
  return step ? String(step.sessionName).trim() : ''
}

/**
 * 解析「这张卡该叫什么」。resume 段的标题是模板废话，但它的 `status.json` 带
 * `revivedFrom`，顺着它去读原 run 的 status.json 就有真标题——**零后端改动**
 * （报告 P1″ 方案 1）。
 *
 * 为什么要往上游走而不是让面板沿代际链回退：链是按事件/子会话文件拼的，插件中途
 * 启动、或从别的会话 resume 时链可能缺段；而 `revivedFrom` 是文件里的硬事实。
 *
 * 同时把这条链的**形状**带出来（报告 P1″ 的徽标）：`rootRunId` 是最初那个 run，
 * `hops` 是续了几次。面板上写「续 be55dc91」没有意义——用户看不到那个 id 是从哪来的；
 * 写「第 2 次续 · 最初 bcfd4e45」才说得清这条卡的来历。
 *
 * @param {unknown} asyncDir 这段自己的 run 目录
 * @param {any} [firstSnap] 已经读过的那份快照（省一次 stat）
 * @returns {{ title: string, revivedFrom: string | null, rootRunId: string, hops: number }}
 */
export function resolveRunTitle(asyncDir, firstSnap) {
  let dir = String(asyncDir ?? '').trim()
  if (!dir) return { title: '', revivedFrom: null, rootRunId: '', hops: 0 }
  /** @type {string | null} */
  let revivedFrom = null
  let rootRunId = ''
  let hops = 0
  for (let hop = 0; hop < MAX_HOPS && dir; hop += 1) {
    const snap = hop === 0 && firstSnap ? firstSnap : readRunSnapshot(dir)
    if (!snap) break
    if (hop === 0) revivedFrom = snap.revivedFrom
    // 目录名就是 runId：文件里没写时用它兜底
    const here = String(snap.runId || path.basename(dir))
    rootRunId = here
    const title = ownTitle(snap)
    if (title) return { title, revivedFrom, rootRunId: here, hops }
    if (!snap.revivedFrom) break
    hops += 1
    // run 目录是 `<runsRoot>/<runId>`：原 run 就在同一个父目录下
    dir = path.join(path.dirname(dir), snap.revivedFrom)
  }
  return { title: '', revivedFrom, rootRunId, hops }
}
