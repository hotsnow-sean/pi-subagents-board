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
    /**
     * 这一步自己的 run id。**容器与子代理的父子关系唯一可靠的依据**：
     * 那个 run 在面板里是独立的一张卡，`steps[].runId` 就是它的 runId。
     * 不靠 agent 名猜（父 run 的 agent 也是 `workflow`，子步骤可能是任意角色）。
     */
    runId: typeof step?.runId === 'string' ? step.runId.trim() : '',
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
    /**
     * 「它现在到底在干什么」——**唯一能区分「跑着」和「卡在等你回答」的字段**
     * （报告 P10）。实测取值：`needs_attention`（调了 contact_supervisor，等人回）、
     * `active_long_running`（正常跑）。`status` / `state` 这两种情况都报 `running`，
     * 光看它们分不出来——所以面板必须读这一项。
     */
    activityState: typeof step?.activityState === 'string' ? step.activityState.trim() : '',
    /** 正在跑的工具名：`needs_attention` 时等于 `contact_supervisor` 就说明它在等人回答 */
    currentTool: typeof step?.currentTool === 'string' ? step.currentTool.trim() : '',
    /** 最后一次真实活动时刻。算「已 N 分无活动」只能用它，不能用我们自己的时钟 */
    lastActivityAt: num(step?.lastActivityAt) || null,
    steering: normalizeSteering(step?.steering),
  }))

  const snapshot = {
    runId: String(raw?.runId ?? ''),
    state: String(raw?.state ?? ''),
    /**
     * `workflow` / `delegate` / `worker` …：容器与否看这个。
     * 不能只看 `steps.length > 1`——单步 workflow 也是容器（实测 `8a08d1b2`）。
     */
    mode: typeof raw?.mode === 'string' ? raw.mode.trim() : '',
    endedAt: num(raw?.endedAt) || null,
    /** resume 出来的一次续跑：指向原 run。有了它就等于拿到「这张卡原来叫什么」的钥匙 */
    revivedFrom: typeof raw?.revivedFrom === 'string' && raw.revivedFrom.trim() ? raw.revivedFrom.trim() : null,
    /** 扩展将来若把 `options.name` 落地（报告 P1′），就在这里；现在恒为空 */
    name: typeof raw?.name === 'string' ? raw.name.trim() : '',
    /** 顶层一般没有这个字段（实测只在 `steps[]` 里），有就带上，UI 侧统一优先取 step 的 */
    activityState: typeof raw?.activityState === 'string' ? raw.activityState.trim() : '',
    /**
     * 最后一次**真实**活动时刻（顶层，回退 `steps[0]`）。
     *
     * 「已 3 分无活动」必须是磁盘上的事实：用我们自己的时钟（`attentionSince`）算，
     * 插件重启就归零、心跳有误差，而且分不清「它没动」和「我们没读到」。
     */
    lastActivityAt: num(raw?.lastActivityAt) || num(steps[0]?.lastActivityAt) || null,
    /**
     * 有没有超时保护。**续跑出来的 run 实测全都没有**（报告 P18：3 个续跑 run 无
     * `deadlineAt`/`timeoutMs`，6 个新鲜 run 全有），所以它们挂死就是无限期——卡面
     * 需要知道这一条，才知道「等下去」是不是白等。
     */
    hasDeadline: raw?.deadlineAt != null || raw?.timeoutMs != null,
    /**
     * runner 子进程的 pid 与最后一次写盘时刻。
     *
     * 应用重启（或子进程被系统回收）之后，`status.json` 会永远停在 `running`——
     * 没有任何人再去改它了。pid 是判断「这条 run 还有没有人在跑」的唯一硬证据：
     * 卡片上的「运行中 + 停止按钮」全靠它才不会被一个死进程骗住。
     */
    pid: num(raw?.pid) || null,
    lastUpdate: num(raw?.lastUpdate) || null,
    /** 顶层没写就取第一步的（实测顶层一般没有） */
    currentTool: String(raw?.currentTool || steps[0]?.currentTool || '').trim(),
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
 * run 的 runner 进程还在不在。
 *
 * 用 `process.kill(pid, 0)`：不发信号，只让内核回一句「这个 pid 存在吗」。
 * 三种结果要分清——
 *   · 成功 → 在；
 *   · `ESRCH` → 不存在（进程已经退出，或者应用重启把它带走了）；
 *   · `EPERM` → 存在，只是不归当前用户管（跨用户/受保护进程），**不能当死**。
 *
 * 拿不到 pid 时返回 `true`：宁可把一张死卡当成在跑（现状），也不能把活着的 run 判死
 * ——后者会让用户去重启一个其实好好的任务。
 * @param {unknown} pid
 */
export function isProcessAlive(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return true
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    // 只有 `ESRCH`（no such process）能说明「它没了」。`EPERM` 是「在，但你没权限碰」；
    // 参数非法之类的意外也一律当「在」——判活的代价只是多等，判死会劝用户重启好端端的 run。
    return (/** @type {any} */ (error))?.code !== 'ESRCH'
  }
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

/* ---------- launch 描述符：resume 的「预约单」，比 status.json 早一步 ---------- */

/**
 * `async-started` 的载荷里**没有** `revivedFrom`，也没有 `sessionName`（上游 emit 的
 * 字段清单为证）。之前唯一的替代是等 runner 把 `status.json` 写出来再读——可那个文件
 * 要等子进程冷启动完才落盘（实测 run.started 到 agent_start 隔了 1.5 秒，而 spawn 到
 * run.started 还有一段 Node 启动时间）。于是「首帧」永远抢在数据之前，卡片先以
 * `角色 · abc12345` 的孤链出现，几百毫秒后才并回旧链——用户看到的就是「又冒出一张新卡」。
 *
 * 真正早的线索在这里：`<runsRoot>/async-subagent-launches/<runId>/recovery-descriptor.json`。
 * 它由**父进程在 spawn 时就写好**（实测 `bc779a16` 的描述符 mtime 15:35:03.9，而它自己的
 * run.started 是 15:35:06.8——早了近 3 秒），`sessionFile` 字段直接写着这次要写/续写的
 * 子会话文件：
 *
 *   · 普通 run → `<…>/<自己的 runId>/run-0/session.jsonl`
 *   · resume  → `<…>/<来源 run 的 runId>/run-0/session.jsonl`
 *
 * 也就是说「我续的是谁」这件事，在事件到达的同一刻就是可读的，代价只有一次 stat。
 */
const LAUNCH_MAX_BYTES = 128 * 1024
const MAX_LAUNCH_CACHE = 64

/** @type {Map<string, { mtimeMs: number, size: number, value: any }>} */
const launchCache = new Map()

/**
 * `asyncDir`（`<runsRoot>/async-subagent-runs/<runId>`）→ 同级的 launches 目录。
 * @param {unknown} asyncDir
 */
export function launchDescriptorPath(asyncDir) {
  const dir = String(asyncDir ?? '').trim()
  if (!dir) return ''
  const runId = path.basename(dir)
  if (!runId) return ''
  return path.join(path.dirname(path.dirname(dir)), 'async-subagent-launches', runId, 'recovery-descriptor.json')
}

/**
 * 读 launch 描述符。缺文件 / 坏 JSON / 路径形状变了 → null（调用方退回旧行为）。
 * @param {unknown} asyncDir
 */
export function readLaunchDescriptor(asyncDir) {
  const file = launchDescriptorPath(asyncDir)
  if (!file) return null

  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > LAUNCH_MAX_BYTES) return null

  const hit = launchCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value

  /** @type {any} */
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const value = {
    runId: typeof raw?.sourceRunId === 'string' ? raw.sourceRunId.trim() : '',
    sessionFile: typeof raw?.sessionFile === 'string' ? raw.sessionFile.trim() : '',
    /** 父会话的会话文件（所有 run 都指同一个，用它区分「哪个会话派出来的」） */
    parentSessionFile: typeof raw?.sessionId === 'string' ? raw.sessionId.trim() : '',
    agent: typeof raw?.agent === 'string' ? raw.agent.trim() : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
  }
  if (launchCache.size >= MAX_LAUNCH_CACHE) {
    const oldest = launchCache.keys().next().value
    if (oldest !== undefined) launchCache.delete(oldest)
  }
  launchCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

/** 测试用：清掉描述符缓存（同一个 tmp 目录被复写时 mtime 可能不变） */
export function clearLaunchCache() {
  launchCache.clear()
}

/**
 * 从子会话路径里取 runId：`<…>/<runId>/run-<i>/session.jsonl`。
 * @param {unknown} file
 */
export function runIdFromSessionFile(file) {
  const match = /[\\/]([0-9a-zA-Z][0-9a-zA-Z-]{5,})[\\/]run-\d+[\\/]session\.jsonl$/i.exec(String(file ?? '').trim())
  return match ? match[1] : ''
}

/**
 * 这次 run 是不是「续跑」，以及它复用了哪份子会话文件。
 *
 * 判据只有一条：描述符的 `sessionFile` **不是本 run 自己的路径**。普通 run 一定是
 * `<…>/<自己的 runId>/run-0/session.jsonl`，续跑复用的是来源 run 的那份。
 *
 * 没用到 `deadlineAt`（续跑 run 实测都没有超时保护，报告 P18）——那个特征是对的，但
 * 它属于「上游的 bug」；等哪天补上了，判据就静默失效。文件路径是结构事实，不受影响。
 *
 * @param {unknown} asyncDir
 * @param {unknown} runId
 * @returns {{ sessionFile: string, sourceRunId: string } | null}
 */
export function resumeSourceOf(asyncDir, runId) {
  const desc = readLaunchDescriptor(asyncDir)
  if (!desc?.sessionFile) return null
  const id = String(runId ?? '').trim()
  if (id && desc.sessionFile.toLowerCase().includes(id.toLowerCase())) return null
  return { sessionFile: desc.sessionFile, sourceRunId: runIdFromSessionFile(desc.sessionFile) }
}

/**
 * 这次 run 的「预约」性质。和 `resumeSourceOf` 的差别是**不把两种「不是续跑」混成
 * 一个 null**：调用方要据此决定能不能立刻上屏——普通 run 敢（标题有「启动中」兜底），
 * 未知的不敢（可能是续跑，先上屏就是一张孤卡）。
 *
 * @param {unknown} asyncDir @param {unknown} runId
 * @returns {'plain' | 'resume' | 'unknown'}
 */
export function launchKindOf(asyncDir, runId) {
  const desc = readLaunchDescriptor(asyncDir)
  if (!desc?.sessionFile) return 'unknown'
  const id = String(runId ?? '').trim()
  if (id && desc.sessionFile.toLowerCase().includes(id.toLowerCase())) return 'plain'
  return 'resume'
}

/* ---------- 任务原文：比 status.json 早二十秒的那份 ---------- */

const TASK_MAX_BYTES = 256 * 1024
const MAX_TASK_CACHE = 64

/** @type {Map<string, { mtimeMs: number, size: number, value: string }>} */
const taskCache = new Map()

/**
 * 从 run 的 `events.jsonl` 头部取任务原文（第一条 user 消息的首行）。
 *
 * 为什么不读 `status.json`：那个文件要等子进程就绪才落盘——实测普通 run **23 秒**、
 * 续跑 8 秒。而事件流在 run 开始后 1~2 秒就把第一条 user 消息写进去了（`Task: …`），
 * 卡片要在几百毫秒内出现、又不能顶着 `delegate · abc12345` 这种假名字，就靠它。
 *
 * 只读头部：任务消息一定在最前面；长 run 的事件流可能几 MB，读全量不值。
 * @param {unknown} asyncDir
 */
export function readRunTaskText(asyncDir) {
  const dir = String(asyncDir ?? '').trim()
  if (!dir) return ''
  const file = path.join(dir, 'events.jsonl')

  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return ''
  }
  if (!stat.isFile()) return ''

  const hit = taskCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value

  let text = ''
  try {
    const length = Math.min(stat.size, TASK_MAX_BYTES)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, 0)
    } finally {
      fs.closeSync(fd)
    }
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      /** @type {any} */
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'message_start') continue
      const message = event.message
      if (!message || message.role !== 'user') continue
      const raw = Array.isArray(message.content)
        ? message.content.map((/** @type {any} */ part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : typeof message.content === 'string'
          ? message.content
          : ''
      text = firstTaskLine(raw)
      break
    }
  } catch {
    text = ''
  }

  if (taskCache.size >= MAX_TASK_CACHE) {
    const oldest = taskCache.keys().next().value
    if (oldest !== undefined) taskCache.delete(oldest)
  }
  taskCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value: text })
  return text
}

/** 测试用：清掉任务原文缓存（同一个 tmp 目录被复写时 mtime 可能不变） */
export function clearTaskTextCache() {
  taskCache.clear()
}

/**
 * 任务原文 → 一行标题候选。
 * - 去掉 `Task:` 前缀（上游给子代理的消息都以它开头）
 * - 只留第一行：后面是「步骤：1. …」，属于正文
 * - 复活提示语不是任务 → 空串（和 sessionName 那边同一套判据）
 * @param {unknown} raw
 */
function firstTaskLine(raw) {
  const text = String(raw ?? '').trim()
  if (!text || isReviveNoise(text)) return ''
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? ''
  const trimmed = line.replace(/^task\s*[:：]\s*/i, '').trim()
  if (!trimmed || isReviveNoise(trimmed)) return ''
  // 上游哪天把事件流里的 prompt 也 redact 了，别把占位符当标题显示出去
  if (/^prompt_redacted$/i.test(trimmed)) return ''
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/** 一次 resume 最多往回追几跳：正常只有一跳，连环 resume 也就两跳 */
const MAX_HOPS = 4

/** 步骤自己的终态。这些不该再当「排队中」画占位——它跑完了、失败了、或者被停掉了 */
const STEP_TERMINAL = new Set([
  'complete',
  'completed',
  'success',
  'succeeded',
  'failed',
  'error',
  'stopped',
  'stopping',
  'rejected',
  'cancelled',
  'canceled',
  'skipped',
])

/**
 * 「排队中、还没有卡」的步骤（报告 P12）。
 *
 * 判据是 `steps[]` 里**没有 runId**：没有 runId 就建不出卡（`steps[].runId` 是父子关系
 * 唯一可靠的依据），容器写着「3 步」下面却只有 1 张，用户只能猜剩下的是没跑还是丢了。
 *
 * **但只有容器 run 才有「还没建的步骤」**。`mode: 'single'`（普通代理）的 `steps[0]`
 * 就是它自己：没有 runId、没有独立会话、状态跟着 run 走（实测 57 个 single run 全部如此，
 * status 取值是 `complete` / `failed` / `stopped`）。把它当占位会在卡片底下凭空长出一张
 * 「第 1 步 · 待启动」的子卡片，还让卡面写「0/1 完成」——普通代理明明已经跑完了，
 * 看起来却像卡在启动前。
 *
 * @param {any} snap readRunSnapshot 的结果
 * @returns {Array<{ index: number, label: string, agent: string }>}
 */
export function pendingStepsOf(snap) {
  const mode = String(snap?.mode ?? '').trim().toLowerCase()
  const steps = Array.isArray(snap?.steps) ? snap.steps : []
  // 老数据可能没有 mode：单步的一律按 single 处理（多步的必然是编排）
  const container = mode ? mode !== 'single' : steps.length > 1
  if (!container) return []
  return steps
    .filter((/** @type {any} */ step) => {
      if (String(step?.runId ?? '').trim()) return false
      return !STEP_TERMINAL.has(String(step?.status ?? '').trim().toLowerCase())
    })
    .map((/** @type {any} */ step, /** @type {number} */ at) => ({
      index: Number.isFinite(step?.index) ? Number(step.index) : at,
      label: String(step?.label || step?.workflowKey || '')
        .trim()
        .slice(0, 120),
      agent: String(step?.agent || '').trim(),
    }))
}

/**
 * workflow 步骤名里「有意义」的那个：等于 `workflowKey` 的是占位符
 * （实测单个 step 的 workflow 会退化成 `task-1`），跳过。
 * @param {any} snap
 */
/**
 * workflow 的步骤名。**容器自己不用它**——`steps[].label` 是它第一步的名字，
 * 拿来当父卡标题就和下面那张子卡重名了（有了父子结构之后并排一看就乱）。
 * @param {any} snap
 */
export function stepLabel(snap) {
  if (snap?.mode === 'workflow') return ''
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
  // 容器没有自己的名字：它的 label 属于第一步，sessionName 是子代理的任务首句。
  // 都拿不来当父卡标题，交给 UI 兜底成 `workflow · <runId8>`。
  if (snap?.mode === 'workflow') return ''
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

/* ---------- run 的事件流尾部：控制信号 + 提问原文（报告 P19 / P20） ---------- */

/**
 * 尾部读多少。
 *
 * 一条 `subagent.control` 实测 3–5KB（`noticeText` 里塞了完整的使用提示），
 * `contact_supervisor` 那条还带问题原文。64KB 足够盖住「最后一条控制事件 + 它前面
 * 那条提问」，被截断就再翻四倍读一次（最多 256KB）。**不按文件大小设上限**：
 * events.jsonl 会长到几 MB 的恰恰是长跑 run，而尾部读的代价与文件大小无关。
 */
const EVENTS_TAIL_BYTES = 64 * 1024
const EVENTS_TAIL_MAX_BYTES = 256 * 1024
/** 缓存条数：和 status.json 一样，长会话里 run 目录会越攒越多 */
const MAX_EVENTS_CACHE = 32

/** @type {Map<string, { mtimeMs: number, size: number, value: any }>} */
const eventsCache = new Map()

/**
 * 读文件最后 `bytes` 字节。文件不在 / 读不了 → 空串（调用方当「没有数据」）。
 * @param {string} file
 * @param {number} bytes
 * @returns {{ text: string, truncated: boolean }}
 */
function readTail(file, bytes) {
  /** @type {number} */
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return { text: '', truncated: false }
  }
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(bytes, size)
    if (!length) return { text: '', truncated: false }
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    let text = buffer.toString('utf8')
    const truncated = size > length
    if (truncated) {
      // 从中间读出来的第一行是半行：整行丢掉。解析侧因此可以假设「每行都是完整的」。
      const cut = text.indexOf('\n')
      text = cut >= 0 ? text.slice(cut + 1) : ''
    }
    return { text, truncated }
  } catch {
    return { text: '', truncated: false }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 关不掉也没什么可做的 */
    }
  }
}

/** `**Reply from supervisor:**\nA（用 waiting-report.md）` → `A（用 waiting-report.md）` */
function stripReplyPrefix(/** @type {unknown} */ text) {
  return String(text ?? '')
    .replace(/^\*\*Reply from supervisor:\*\*\s*/i, '')
    .trim()
}

/** 从一份 `message.content[]` 里挑出 contact_supervisor 的 toolCall */
function supervisorCallOf(/** @type {any} */ message) {
  const content = Array.isArray(message?.content) ? message.content : []
  for (const part of content) {
    if (part?.type !== 'toolCall') continue
    if (String(part.name ?? '') !== 'contact_supervisor') continue
    return { id: String(part.id ?? ''), args: part.arguments ?? {} }
  }
  return null
}

/**
 * 解析事件流尾部。**纯函数**，测试直接喂文本。
 *
 * 取两样东西：
 *   1. 最后一条 `subagent.control`——它的 `reason` 才是「等人回答 / 无响应 / 长时间运行」
 *      的唯一判据（`activityState` 三者都是 `needs_attention` 或 `active_long_running`）；
 *   2. 最后一对 `contact_supervisor` 的调用与结果——**提问原文与回答都在这里**。
 *      它们不会进会话流（报告 P20），这是唯一能拿到的来源；按 `toolCallId` 配对，
 *      回答里带 `durationMs`，所以「等了多久才答」也是真值。
 *
 * @param {string} text 事件流尾部文本（每行都是完整的一行；半行由读取侧丢掉）
 */
export function parseRunEventsTail(text) {
  const raw = String(text ?? '')
  /** @type {any} */
  let control = null
  /** @type {Map<string, any>} */
  const asks = new Map()
  if (!raw) return { control, ask: null }

  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    /** @type {any} */
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = String(event?.type ?? '')

    if (type === 'subagent.control' && event?.event) {
      const payload = event.event
      control = {
        type: String(payload.type ?? ''),
        reason: String(payload.reason ?? '').trim(),
        at: num(payload.ts) || null,
        elapsedMs: num(payload.elapsedMs) || null,
        currentTool: String(payload.currentTool ?? '').trim(),
        message: String(payload.message ?? ''),
      }
      continue
    }

    if (type === 'tool_execution_start' && String(event.toolName ?? '') === 'contact_supervisor') {
      const id = String(event.toolCallId ?? '')
      if (!id) continue
      const args = event.args ?? {}
      asks.set(id, {
        id,
        question: String(args.message ?? '').trim(),
        reason: String(args.reason ?? '').trim(),
        askedAt: num(event.observedAt) || null,
        answer: '',
        answeredAt: null,
        durationMs: null,
      })
      continue
    }

    // 只有 message_end 而没有 tool_execution_start 的情况（外部 intercom 提问）：补一份
    if (type === 'message_end' && event?.message?.role === 'assistant') {
      const call = supervisorCallOf(event.message)
      if (!call?.id || asks.has(call.id)) continue
      asks.set(call.id, {
        id: call.id,
        question: String(call.args?.message ?? '').trim(),
        reason: String(call.args?.reason ?? '').trim(),
        askedAt: num(event.message.timestamp) || null,
        answer: '',
        answeredAt: null,
        durationMs: null,
      })
      continue
    }

    if (type === 'tool_execution_end' && String(event.toolName ?? '') === 'contact_supervisor') {
      const id = String(event.toolCallId ?? '')
      const entry = asks.get(id) ?? {
        id,
        question: '',
        reason: '',
        askedAt: null,
        answer: '',
        answeredAt: null,
        durationMs: null,
      }
      const content = Array.isArray(event?.result?.content) ? event.result.content : []
      const textPart = content.find((/** @type {any} */ part) => part?.type === 'text')
      entry.answer = stripReplyPrefix(textPart?.text)
      entry.answeredAt = num(event.observedAt) || null
      entry.durationMs = num(event.durationMs) || null
      if (id) asks.set(id, entry)
    }
  }

  // Map 保持插入顺序：最后一条就是最近那次提问
  const entries = [...asks.values()]
  return { control, ask: entries.length ? entries[entries.length - 1] : null }
}

/**
 * 读一次 run 的事件流尾部（带 mtime + size 缓存）。
 *
 * 和 `readRunSnapshot` 一样，读的是扩展的私有产物：**任何异常都退化成「没有数据」**，
 * 绝不因为读不到而影响面板其它部分。调用方（agent）只在「活跃且 needs_attention」时
 * 才调它——正常跑着的 run 一秒一次也没多读一个字节。
 *
 * @param {unknown} asyncDir `async-started` 事件里的 asyncDir
 */
export function readRunEvents(asyncDir) {
  const dir = String(asyncDir ?? '').trim()
  if (!dir) return null
  const file = path.join(dir, 'events.jsonl')

  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const hit = eventsCache.get(dir)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value

  const first = readTail(file, EVENTS_TAIL_BYTES)
  if (!first.text) return null
  let parsed = parseRunEventsTail(first.text)
  // 首行被切断时，最后一条控制事件 / 提问可能正好压在断口上：读大一点再来一次
  if (first.truncated && (!parsed.control || !parsed.ask)) {
    const wider = readTail(file, EVENTS_TAIL_MAX_BYTES)
    if (wider.text) parsed = parseRunEventsTail(wider.text)
  }

  if (eventsCache.size >= MAX_EVENTS_CACHE) {
    const oldest = eventsCache.keys().next().value
    if (oldest !== undefined) eventsCache.delete(oldest)
  }
  eventsCache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, value: parsed })
  return parsed
}

/** 测试用：清掉 events.jsonl 的缓存（同一个 tmp 目录被复写时 mtime 可能不变） */
export function clearRunEventsCache() {
  eventsCache.clear()
}
