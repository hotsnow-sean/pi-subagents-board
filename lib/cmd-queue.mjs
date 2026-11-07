// @ts-check
/**
 * main ↔ agent 的命令队列（纯逻辑，无 IO）。
 *
 * 方向：`UI → main.invoke → 写 cmd/ 文件 → worker 里的 agent.mjs 认领并调 RPC → 写 cmd-result/ → main 读回`。
 * 为什么用文件：插件 main 与 worker 之间没有可用 IPC（宿主的 IPC 是宿主自己的），
 * live/*.json 是两边唯一的公共面，命令走同一个思路。
 *
 * 三个必须守住的点（计划 §5.5）：
 *   1. **认领靠 rename**（原子）。`readFile` 之后 `unlink` 会让两个实例都读到同一条命令。
 *   2. **文件名带 sessionKey 前缀**：每个 worker 只认领自己会话的命令。否则多个会话的
 *      agent 会抢同一条命令，谁先抢到谁执行——那是把 A 会话的插话发到 B 会话的子代理上。
 *   3. **命令带 createdAt**：超过 30s 未认领就清理，避免下次启动时把陈旧命令执行一遍。
 */

export const CMD_DIR = 'cmd'
export const CLAIM_DIR = 'cmd-processing'
export const RESULT_DIR = 'cmd-result'

/** 超过这个时间还没被认领的命令作废（会话可能已经关了） */
export const CMD_TTL_MS = 30_000
/** 结果文件保留时间：main 读走后就没用了，留着只为排查 */
export const RESULT_TTL_MS = 120_000
/** UI 等待回执的上限：超过就当「那个会话已经不活跃」 */
export const REPLY_WAIT_MS = 5_000

/** @typedef {'steer' | 'stop'} CmdAction */

/** steer 的 mode：steer=立刻插话，follow_up=本轮结束后再说，auto=由扩展判断 */
const MODES = new Set(['steer', 'follow_up', 'auto'])
const MAX_MESSAGE = 8_000

/**
 * 校验并规范化一条命令。**校验在 main 侧做**——UI 可以编造任意参数，
 * 最终落到 RPC 之前必须收窄成已知形状（计划 §11「schema 只是建议」）。
 * @param {any} input
 * @param {number} now
 * @returns {{ ok: true, command: any } | { ok: false, error: string }}
 */
export function buildCommand(input, now) {
  const action = String(input?.action ?? '')
  if (action !== 'steer' && action !== 'stop') return { ok: false, error: `未知动作：${action || '(空)'}` }

  const runId = String(input?.runId ?? '').trim()
  if (!runId) return { ok: false, error: '缺少 runId' }

  const sessionKey = String(input?.sessionKey ?? '').trim()
  if (!sessionKey) return { ok: false, error: '缺少 sessionKey（不知道这条命令该发给哪个会话）' }

  /** @type {any} */
  const command = {
    action,
    runId,
    sessionKey,
    createdAt: now,
    id: String(input?.id ?? ''),
  }

  if (Number.isFinite(input?.index)) {
    const index = Number(input.index)
    if (index < 0) return { ok: false, error: 'index 不能为负' }
    command.index = index
  }

  if (action === 'steer') {
    const message = String(input?.message ?? '').trim()
    if (!message) return { ok: false, error: '说点什么再发' }
    if (message.length > MAX_MESSAGE) return { ok: false, error: `太长（上限 ${MAX_MESSAGE} 字）` }
    const mode = String(input?.mode ?? 'steer')
    if (!MODES.has(mode)) return { ok: false, error: `未知的 mode：${mode}` }
    command.message = message
    command.mode = mode
  }

  return { ok: true, command }
}

/**
 * 命令文件名：`<sessionKey>--<id>.json`。
 * sessionKey 是会话路径的哈希（十六进制），可以直接进文件名；`--` 分隔不会与它冲突。
 * @param {string} sessionKey
 * @param {string} id
 */
export function commandFileName(sessionKey, id) {
  return `${sessionKey}--${id}.json`
}

/**
 * @param {string} name
 * @returns {{ sessionKey: string, id: string } | null}
 */
export function parseCommandFileName(name) {
  const match = /^([0-9a-z]+)--([^/\\]+)\.json$/i.exec(String(name ?? ''))
  if (!match) return null
  return { sessionKey: match[1], id: match[2] }
}

/**
 * 把 RPC 回执规范化成 UI 能直接用的形状。
 *
 * **`queued` 与 `delivered` 绝不能合并成「已发送」**：前者只说明排上了队，
 * 子代理这一轮结束才会看到（计划 §5.7）。
 * @param {CmdAction} action
 * @param {any} data
 */
export function normalizeReceipt(action, data) {
  const raw = data && typeof data === 'object' ? data : {}
  if (action === 'steer') {
    return {
      deliveryStatus: typeof raw.deliveryStatus === 'string' ? raw.deliveryStatus : '',
      state: raw.state ?? null,
      targets: Array.isArray(raw.targets)
        ? raw.targets.map((/** @type {any} */ target) => ({ index: target?.index ?? null, state: target?.state ?? null }))
        : [],
    }
  }
  // stop：成功只代表**受理**（state: stopping），终止要等 status 收敛
  return { state: raw.state ?? null }
}

/**
 * 组装结果文件内容（agent 写、main 读）。
 * @param {any} command
 * @param {{ ok: boolean, data?: any, error?: any, timedOut?: boolean }} reply
 * @param {number} at
 */
export function buildResult(command, reply, at) {
  return {
    id: command.id,
    action: command.action,
    runId: command.runId,
    ok: reply.ok === true,
    receipt: reply.ok ? normalizeReceipt(command.action, reply.data) : null,
    error: reply.ok ? null : (reply.error ?? { code: 'rpc_failed', message: '未收到错误详情' }),
    timedOut: reply.timedOut === true,
    at,
  }
}

/**
 * 判断一条命令是否过期（未被认领时由 main / agent 各自清理）。
 * @param {any} command
 * @param {number} now
 * @param {number} [ttlMs]
 */
export function isExpired(command, now, ttlMs = CMD_TTL_MS) {
  const created = Number(command?.createdAt) || 0
  return !created || now - created > ttlMs
}
