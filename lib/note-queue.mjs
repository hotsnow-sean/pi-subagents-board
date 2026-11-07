// @ts-check
/**
 * 留言邮箱（下行：面板 → 主会话）。
 *
 * 为什么不是命令队列：
 *
 *   P2-c 的 `cmd-queue` 是为了「直接 steer 一个后台子代理」造的——文件投递、rename 认领、
 *   5s 双端死线、双端过期判断。而 pi-subagents 内部本来就有完整的 steering 状态机
 *   （`status.steering.targets[].state`：scheduled / pending / delivered / failed / recovered，
 *   3s ack，`mode: steer | follow_up | auto`）。我们在外面又套一层状态机，等于两套真相，
 *   面板报的是我们这层、真实状态在它那层。
 *
 *   现在的方案放弃了「直接引导子代理」，改为**给主会话留言**，由主代理决定要不要转派。
 *   那条路径的落点是 SDK 的 `pi.sendUserMessage(text, { deliverAs: 'steer' })`，
 *   它自己就把「空闲 → 起一轮 / 正在跑 → 插进当前轮」处理掉了（见下方 sendUserMessage 注释）。
 *   于是这层只需要做一件极简的事：**一消息一文件，不可变；回执单独一份，由 agent 独占写。**
 *
 * 这套设计的性质：
 *   - 零锁：写者互不重叠（main 只写 inbox，agent 只写 receipts）
 *   - 幂等：note 不可变、文件名唯一；agent 判「有没有对应 receipt」决定是否处理，重启也安全
 *   - 无死线：不存在「面板说没送达、其实投了」的窗口——面板不再等回执，只轮询状态
 *   - 单端过期：只有 agent 侧判「这条太老了，别投」。用户昨晚留的言不该在早上开机时
 *     突然起一轮模型调用。
 */

/** 留言根目录（dataDir 下）：`inbox/<sessionKey>/<id>.json` */
export const INBOX_DIR = 'inbox'
/** 回执目录（dataDir 下）：`receipts/<id>.json` */
export const RECEIPT_DIR = 'receipts'
/** 留言正文上限：面板是「说一句」，不是写文档 */
export const MAX_MESSAGE = 4_000
/** 留言有效期：超过就不投，只记一条过期回执。10 分钟足够覆盖「切个会话再回来」 */
export const NOTE_TTL_MS = 10 * 60 * 1000
/** 回执/留言的清理期：留一天足够用户回看，之后连目录一起清 */
export const KEEP_MS = 24 * 60 * 60 * 1000

/** @typedef {{ kind: 'note' | 'stop' }} NoteKind */
/** @typedef {{ ok: true, note: any } | { ok: false, error: string }} BuildResult */

/**
 * 构造一条消息。所有来自 UI 的字段都当作不可信输入。
 *
 * `runId` 只作为**上下文**（告诉主代理「说的是哪次运行」），不参与投递寻址：
 * 目标永远是主会话，不存在「发给某个 run」这回事了。
 *
 * @param {{ kind?: unknown, sessionKey?: unknown, runId?: unknown, agent?: unknown, message?: unknown }} input
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

  if (kind === 'stop') {
    // 没有 runId 无从停起——早拒，别让 worker 那边再报一次错
    if (!runId) return { ok: false, error: '停止需要 runId' }
  }

  if (kind === 'note') {
    const message = String(input?.message ?? '').trim()
    if (!message) return { ok: false, error: '说点什么再发' }
    if (message.length > MAX_MESSAGE) return { ok: false, error: `太长了（上限 ${MAX_MESSAGE} 字）` }
    note.message = message
  }
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
 * 把留言变成主代理能看懂的一段话。
 *
 * 只写「谁在说、说的是哪次运行」，不写「请你去 steer 它」之类的指令——
 * 主代理有它自己的判断，面板不该越权指挥（这正是放弃直接 steer 的初衷）。
 * @param {{ agent?: string, runId?: string, message?: string }} note
 */
export function renderNoteText(note) {
  const who = String(note?.agent ?? '').trim() || '子代理'
  const run = String(note?.runId ?? '').trim()
  const head = run ? `（来自子代理面板 · 关于 ${who} / run ${run}）` : `（来自子代理面板 · 关于 ${who}）`
  return `${head}\n${String(note?.message ?? '').trim()}`
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
