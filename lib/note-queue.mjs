// @ts-check
/**
 * 留言邮箱（下行：面板 → 子代理 run）。
 *
 * 一条「留言」= 对该 run 的一次 steer。真正的投递由 pi-subagents 完成：
 * RPC `steer` → 它自己的 steering 状态机（`status.steering.targets[].state`：
 * scheduled / pending / queued / delivered，3s ack），同步返回结果。
 *
 * 那为什么还要这层文件？**因为插件 main（面板）与 worker（agent）之间没有 IPC 通道**——
 * 宿主的 IPC 是宿主自己的。于是最小方案是：main 写一个不可变文件，agent 读它、调 RPC、
 * 把结果写成一份回执。除此之外什么都不做：
 *
 *   - 不做 rename 认领：按会话分目录，一个 agent 只读自己那一格，没有共享目录可抢
 *   - 不做双端死线：投递是同步 RPC，结果由回执如实带回；面板不等，只轮询
 *   - 不复刻 steering 状态机：回执里的 `state` 直接来自 pi-subagents，不自己发明
 *   - 只做单端过期：steer 是即时动作，隔了几分钟的留言投过去也没意义（run 多半已终态）
 *
 * 性质：零锁（main 只写 inbox，agent 只写 receipts）、幂等（note 不可变 + 有回执即视为处理过）、
 * 可追溯（回执带 runId / sessionKey，面板按 runId 匹配卡片）。
 */

/** 留言根目录（dataDir 下）：`inbox/<sessionKey>/<id>.json` */
export const INBOX_DIR = 'inbox'
/** 回执目录（dataDir 下）：`receipts/<id>.json` */
export const RECEIPT_DIR = 'receipts'
/** 留言正文上限：面板是「说一句」，不是写文档 */
export const MAX_MESSAGE = 4_000
/**
 * 留言有效期：超过就不投，只记一条过期回执。
 *
 * 2 分钟而不是 10 分钟——steer 是瞬时动作，只在「run 还活着、父会话进程也在」时有意义。
 * 一条隔了几分钟的留言投过去，多半撞上「run 已终态不能 steer」，报错比投递更没用。
 */
export const NOTE_TTL_MS = 2 * 60 * 1000
/** 回执/留言的清理期：留一天足够用户回看，之后连目录一起清 */
export const KEEP_MS = 24 * 60 * 60 * 1000
/** steer 的投递方式，取值与 pi-subagents 一致 */
export const STEER_MODES = ['steer', 'follow_up', 'auto']

/** @typedef {{ kind: 'note' | 'stop' }} NoteKind */
/** @typedef {{ ok: true, note: any } | { ok: false, error: string }} BuildResult */

/**
 * 构造一条消息。所有来自 UI 的字段都当作不可信输入。
 *
 * `runId` 是**投递地址**：steer 必须有明确目标（pi-subagents 的 `id` / `runId` / `dir` 三选一，
 * 我们用 id）。`index` 只在一条 run 有多个 child 时用来指定是哪一个。
 *
 * @param {{ kind?: unknown, sessionKey?: unknown, runId?: unknown, index?: unknown, agent?: unknown,
 *   mode?: unknown, message?: unknown }} input
 * @param {number} now
 * @returns {BuildResult}
 */
export function buildNote(input, now) {
  const kind = input?.kind === 'stop' ? 'stop' : input?.kind === 'note' ? 'note' : null
  if (!kind) return { ok: false, error: 'kind 必须是 note 或 stop' }

  const sessionKey = String(input?.sessionKey ?? '').trim()
  if (!sessionKey) return { ok: false, error: '拿不到会话标识（先切回主会话）' }

  /** @type {Record<string, unknown>} */
  const note = {
    id: noteId(now),
    kind,
    sessionKey,
    createdAt: now,
  }

  const runId = String(input?.runId ?? '').trim()
  if (runId) note.runId = runId
  const agent = String(input?.agent ?? '').trim()
  if (agent) note.agent = agent

  // 没有 runId 无从投递：note 没目标就没法 steer，stop 更没得停。早拒，别让 worker 报一次错
  if (!runId) return { ok: false, error: '缺少 runId（这条留言没有目标）' }

  if (kind === 'stop') return { ok: true, note }

  const message = String(input?.message ?? '').trim()
  if (!message) return { ok: false, error: '说点什么再发' }
  if (message.length > MAX_MESSAGE) return { ok: false, error: `太长了（上限 ${MAX_MESSAGE} 字）` }
  note.message = message

  const mode = String(input?.mode ?? '').trim()
  if (mode && !STEER_MODES.includes(mode)) return { ok: false, error: `mode 只能是 ${STEER_MODES.join(' / ')}` }
  // 默认 steer：打断它当前这一轮。follow_up 是「等这一轮做完再说」，由 UI 按需传
  note.mode = mode || 'steer'

  const index = Number(input?.index)
  if (Number.isInteger(index) && index >= 0) note.index = index

  return { ok: true, note }
}

/** @param {number} now */
export function noteId(now) {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** `inbox/<sessionKey>/<id>.json` —— 按会话分目录，agent 只读自己那一格，天然不用前缀过滤 */
export function noteFileOf(root, sessionKey, id) {
  return `${root}/${INBOX_DIR}/${sessionKey}/${id}.json`
}

/** @param {string} root @param {string} id */
export function receiptFileOf(root, id) {
  return `${root}/${RECEIPT_DIR}/${id}.json`
}

/**
 * 解析 note 文件名。只认 `<id>.json`，其余（tmp、别的东西）一律忽略。
 *
 * id 不校验格式：它只用来关联回执，校验严格了反而会让手写/迁移的数据被静默跳过。
 * 真正的一致性靠「回执是否存在」保证。
 * @param {string} name
 */
export function parseNoteFileName(name) {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/.exec(String(name ?? ''))
  return match ? match[1] : null
}

/**
 * 这条还该不该投。**只在 agent 侧用**，不做双端对齐——
 * 双端对齐是「面板说没送达、其实投了」的根源，现在面板根本不等回执。
 * @param {{ createdAt?: unknown }} note
 * @param {number} now
 * @param {number} [ttlMs]
 */
export function isFresh(note, now, ttlMs = NOTE_TTL_MS) {
  const created = Number(note?.createdAt)
  if (!Number.isFinite(created) || created <= 0) return false
  return now - created <= ttlMs
}

/**
 * 清理：留言与回执各自过 KEEP_MS 就删。
 * @param {string} root
 * @param {number} now
 * @param {(dir: string) => string[]} readdir
 * @param {(file: string) => number} statMtime
 * @param {(file: string) => void} remove
 */
export function pruneMail(root, now, readdir, statMtime, remove) {
  let removed = 0
  /** @param {string} dir */
  const sweep = (dir) => {
    let names = []
    try {
      names = readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = `${dir}/${name}`
      try {
        if (now - statMtime(full) > KEEP_MS) {
          remove(full)
          removed += 1
        }
      } catch {
        /* 正在被别的进程动：下一轮再说 */
      }
    }
  }
  let keys = []
  try {
    keys = readdir(`${root}/${INBOX_DIR}`)
  } catch {
    /* 还没有 inbox */
  }
  for (const key of keys) sweep(`${root}/${INBOX_DIR}/${key}`)
  sweep(`${root}/${RECEIPT_DIR}`)
  return removed
}
