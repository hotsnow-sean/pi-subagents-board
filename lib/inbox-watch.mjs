// @ts-check
/**
 * 信箱巡检的纯逻辑：**决定「哪些 run 值得通知」和「通知长什么样」**，
 * 不碰 IO、不碰宿主，方便单测（时间是显式参数）。
 *
 * 为什么是 main 侧巡检而不是 agent 侧直接发：`ctx.ui.inbox` 是 main 侧能力，
 * agent.mjs 在 worker 进程里拿不到。而 live/*.json 是两边唯一的公共面——
 * agent 落盘，main 读盘，自然形成「事件 → 落盘 → 巡检 → 信箱」的链路。
 *
 * 为什么必须有台账：live 文件里终态段会一直留着（可回看），没有台账的话
 * 每次巡检都会把同一批 run 重新通知一遍。台账按 `<sessionKey>|<runId>` 记，
 * 落 `<dataDir>/notified.json`。
 */

/** 与 lineage 的终态集合保持一致；这里不 import，避免 main 侧多一条模块依赖 */
const TERMINAL = new Set(['complete', 'failed', 'partial', 'stopped', 'rejected'])

const STATE_TEXT = {
  complete: '已完成',
  failed: '失败',
  partial: '部分完成',
  stopped: '已停止',
  rejected: '被拒绝',
}

/**
 * @param {string} sessionKey
 * @param {string} runId
 */
export function ledgerKey(sessionKey, runId) {
  return `${sessionKey}|${runId}`
}

/**
 * 找出还没通知过的终态段（按结束时间升序，早的先发）。
 * @param {Array<{ file: string, mtimeMs: number, state: any }>} files readLiveFiles 的结果
 * @param {Record<string, number>} ledger 已通知台账
 * @returns {Array<{ sessionKey: string, sessionFile: string, lineage: any, segment: any, key: string }>}
 */
export function selectNewCompletions(files, ledger) {
  const out = []
  for (const { state } of files) {
    const sessionKey = state?.sessionKey
    // unknown- 前缀是 session_start 之前写的临时文件，main 本来就不该用
    if (!sessionKey || sessionKey === 'unknown') continue
    for (const lineage of state.lineages ?? []) {
      for (const segment of lineage.segments ?? []) {
        if (!segment?.runId || !TERMINAL.has(segment.state)) continue
        const key = ledgerKey(sessionKey, segment.runId)
        if (ledger[key]) continue
        out.push({ sessionKey, sessionFile: state.sessionFile ?? '', lineage, segment, key })
      }
    }
  }
  return out.sort((a, b) => (Number(a.segment.endedAt) || 0) - (Number(b.segment.endedAt) || 0))
}

/**
 * 把「插件刚启动时就已经结束了」的段直接记进台账，不发通知。
 *
 * 不这么做的话，插件的每一次激活（含热重载 / 重启应用）都会把历史 run
 * 重新通知一遍。留 60s 余量：刚结束的那批还是发——热重载窗口里跑完的 run
 * 不该被吞掉，宿主信箱按 `dedupeKey` 去重，重复一次不会变成两条。
 * @param {Array<{ file: string, mtimeMs: number, state: any }>} files
 * @param {Record<string, number>} ledger 就地修改
 * @param {number} now
 * @param {number} [graceMs]
 */
export function seedLedger(files, ledger, now, graceMs = 60_000) {
  let added = 0
  for (const { state } of files) {
    const sessionKey = state?.sessionKey
    if (!sessionKey || sessionKey === 'unknown') continue
    for (const lineage of state.lineages ?? []) {
      for (const segment of lineage.segments ?? []) {
        if (!segment?.runId || !TERMINAL.has(segment.state)) continue
        const endedAt = Number(segment.endedAt) || 0
        if (!endedAt || now - endedAt < graceMs) continue
        const key = ledgerKey(sessionKey, segment.runId)
        if (ledger[key]) continue
        ledger[key] = now
        added += 1
      }
    }
  }
  return added
}

/** @param {number} ms */
function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * 生成宿主信箱条目。
 *
 * 字段克制：标题一行、正文一两句——信箱不是历史，历史在面板里（点开就回去）。
 * @param {{ sessionKey: string, sessionFile: string, lineage: any, segment: any, key: string }} entry
 * @param {string} pluginId
 * @param {string} panelId
 */
export function buildInboxItem(entry, pluginId, panelId) {
  const { lineage, segment, sessionFile, key } = entry
  const agent = String(lineage?.agent || segment?.agent || '子代理')
  const stateText = STATE_TEXT[segment.state] ?? segment.state
  const summary = typeof segment.summary === 'string' ? segment.summary.replace(/\s+/g, ' ').trim() : ''
  const parts = []
  if (segment.durationMs) parts.push(`耗时 ${fmtDuration(segment.durationMs)}`)
  if (segment.tokens?.total) parts.push(`${segment.tokens.total} tok`)
  if (!parts.length && Number.isFinite(segment.endedAt) && Number.isFinite(segment.startedAt) && segment.endedAt > segment.startedAt) {
    parts.push(`耗时 ${fmtDuration(segment.endedAt - segment.startedAt)}`)
  }
  if (summary) parts.push(summary.slice(0, 120))
  return {
    title: `${agent} ${stateText}`,
    body: parts.join(' · ') || undefined,
    tone: segment.state === 'complete' ? 'success' : segment.state === 'failed' ? 'error' : 'warn',
    sessionFile: sessionFile || undefined,
    target: { pluginId, panelId },
    dedupeKey: key,
  }
}

/**
 * 清掉台账里的老记录（保留 7 天，和 live 文件的清理阈值一致）。
 * @param {Record<string, number>} ledger 就地修改
 * @param {number} now
 * @param {number} [keepMs]
 */
export function pruneLedger(ledger, now, keepMs = 7 * 24 * 60 * 60 * 1000) {
  let removed = 0
  for (const [key, at] of Object.entries(ledger)) {
    if (!Number.isFinite(at) || now - Number(at) > keepMs) {
      delete ledger[key]
      removed += 1
    }
  }
  return removed
}
