// @ts-check
/**
 * 会话标识与子会话路径推导（纯函数，无 IO）。
 *
 * 两份数据都要靠它对齐：
 *   - agent.mjs 按父会话路径算出 sessionKey，决定写哪个 live 文件；
 *   - main.mjs 从面板上下文拿到同一段会话的路径，算同一个 key 去读。
 * 哈希必须稳定且跨平台大小写无关——Windows 上同一文件可能以 `C:\` 和 `c:\` 两种写法出现。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

/** 路径归一：统一分隔符 + 盘符/整体小写（Windows 大小写不敏感） */
export function normalizeSessionPath(file) {
  const value = String(file ?? '').trim()
  if (!value) return ''
  const slashed = value.replace(/\\/g, '/')
  // 只对 Windows 风格盘符做小写：POSIX 路径大小写敏感，不能动
  return /^[a-zA-Z]:\//.test(slashed) ? slashed.toLowerCase() : slashed
}

/** 父会话 → 短 key（12 位十六进制）。同一段会话在 main / worker 两侧必须算出同一个值 */
export function sessionKeyOf(sessionFile) {
  const normalized = normalizeSessionPath(sessionFile)
  if (!normalized) return 'unknown'
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

/**
 * 子会话文件路径：`<父目录>/<父 stem>/<runId>/run-<index>/session.jsonl`。
 *
 * 这个形状是 pi-subagents 0.86.0 实测出来的固定结构（与 adapter 里
 * `childSession.pattern` 一致）。只在拿不到事件里的 `sessionFile` 时兜底用——
 * `async-complete` 的载荷其实直接带子会话路径，能不用推导就不用。
 */
export function childSessionFile(parentSessionFile, runId, index = 0) {
  const parent = String(parentSessionFile ?? '')
  const id = String(runId ?? '')
  if (!parent || !id) return ''
  const dir = path.dirname(parent)
  const stem = path.basename(parent).replace(/\.jsonl$/i, '')
  const child = Number.isFinite(index) && index >= 0 ? Math.trunc(index) : 0
  return path.join(dir, stem, id, `run-${child}`, 'session.jsonl')
}
