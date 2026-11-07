// @ts-check
/**
 * 代际链聚合（纯函数，无 IO）。
 *
 * 三个数据源拼成一张看板：
 *   1. `subagent:async-started` —— run 的开头：agent / cwd / asyncDir / 父会话路径。
 *      **任务原文是 `[prompt redacted]`**，所以不显示任务文本（计划 §5.4 的「字段诚实原则」）。
 *   2. `subagent:async-complete` —— run 的结尾：终态 / summary / 耗时 / 退出码，
 *      并且**直接带子会话文件路径、tokens、成本**（实测补充，比计划里假设的更好：
 *      原先以为要另调 `cost` 方法）。
 *   3. `status {}`（1s 节流）—— 只补「现在怎么样」：state / activity / children。
 *
 * 聚合粒度是**代际链**而不是 run：resume 会从旧上下文起一个新 run，但对人来说
 * 就是「它又接着说了一句」，一条链 = 一张卡，复活时原卡原地变色。
 *
 * 链根的判定按优先级：
 *   - 事件里带 `revivedFrom`（老版本/未来版本可能有）→ 顺着它找；
 *   - 没有时用**子会话首行的 `parentSession`**（由 agent.mjs 读出后随 complete 传进来）→
 *     指向上一段子会话，就能把链接起来；
 *   - 都没有 → 自己就是链根。
 */

/** @typedef {'running' | 'queued' | 'complete' | 'failed' | 'partial' | 'stopped' | 'paused' | 'rejected' | 'unknown'} RunState */

const ACTIVE = new Set(['running', 'queued'])

/** @param {unknown} state */
export function isActiveState(state) {
  return ACTIVE.has(String(state ?? ''))
}

/**
 * 把扩展给的千奇百怪的终态归一。
 * @param {unknown} raw
 * @param {boolean} [success]
 * @param {boolean} [stopped]
 */
export function normalizeState(raw, success, stopped) {
  const value = String(raw ?? '').toLowerCase()
  const known = ['running', 'queued', 'complete', 'failed', 'partial', 'stopped', 'paused', 'rejected']
  if (known.includes(value)) return value
  if (stopped) return 'stopped'
  if (success === true) return 'complete'
  if (success === false) return 'failed'
  return 'unknown'
}

/**
 * 新建一份空白状态。字段名与计划 §5.4 一致（`schema: 1`）。
 * @param {{ sessionKey: string, sessionFile: string, pid: number, startedAt: number }} init
 */
export function createState(init) {
  return {
    schema: 1,
    sessionKey: init.sessionKey,
    sessionFile: init.sessionFile,
    pid: init.pid,
    startedAt: init.startedAt,
    updatedAt: 0,
    /** 数据源与降级状态；由 agent.mjs 维护，main 只读 */
    source: /** @type {any} */ ({
      rpc: false,
      mode: 'none', // none | push | poll
      handshake: { attempts: 0, ready: false, ping: false, at: null, lastError: null },
      lastReplyAt: null,
      lastError: null,
      capabilities: /** @type {string[]} */ ([]),
      events: /** @type {string[]} */ ([]),
    }),
    /** @type {any[]} */
    lineages: [],
  }
}

/** @param {any} state @param {string} runId */
function findSegment(state, runId) {
  for (const lineage of state.lineages) {
    for (const segment of lineage.segments) {
      if (segment.runId === runId) return { lineage, segment }
    }
  }
  return null
}

/** @param {any} state @param {string} childSessionFile */
function findSegmentByChildSession(state, childSessionFile) {
  for (const lineage of state.lineages) {
    for (const segment of lineage.segments) {
      if (segment.childSessionFile && segment.childSessionFile === childSessionFile) return { lineage, segment }
    }
  }
  return null
}

/** @param {any} state @param {string} runId */
function lineageRootOf(state, runId) {
  const found = findSegment(state, runId)
  return found ? found.lineage.lineageRoot : runId
}

/** 新建一条链（第一段的 runId 就是链根） */
function createLineage(/** @type {string} */ root, /** @type {any} */ seed) {
  return {
    lineageRoot: root,
    agent: seed.agent ?? null,
    cwd: seed.cwd ?? null,
    asyncDir: seed.asyncDir ?? null,
    lastActivityAt: seed.at ?? 0,
    state: /** @type {RunState} */ ('running'),
    /** @type {any[]} */
    segments: [],
  }
}

/**
 * 新建一段。`origin` 只是给诊断看：事件来的段信息最全，status 补出来的段没有 cwd/asyncDir。
 * @param {any} payload
 * @param {number} at
 * @param {'started' | 'complete' | 'status'} origin
 */
function createSegment(payload, at, origin) {
  return {
    runId: String(payload.runId ?? payload.id ?? ''),
    revivedFrom: payload.revivedFrom ?? null,
    /** 子会话首行的 parentSession（resume 时指向前一段的子会话），用于接链 */
    parentSession: payload.childParentSession ?? null,
    state: normalizeState(payload.state, payload.success, payload.stopped),
    origin,
    agent: payload.agent ?? null,
    cwd: payload.cwd ?? null,
    asyncDir: payload.asyncDir ?? null,
    startedAt: Number.isFinite(payload.startedAt) ? payload.startedAt : at,
    endedAt: Number.isFinite(payload.endedAt) ? payload.endedAt : null,
    summary: null,
    error: null,
    exitCode: null,
    durationMs: null,
    tokens: null,
    costUsd: null,
    /** 子代理自己的会话文件（「打开会话」用） */
    childSessionFile: payload.childSessionFile ?? null,
    activity: { lastActivityAt: at, turnCount: null, toolCount: null },
    /** @type {any[]} */
    children: [],
  }
}

/**
 * reordered: 保证 segments 按开始时间升序——事件乱序到达时不能把段插到前面。
 * @param {any} lineage
 */
function sortSegments(lineage) {
  lineage.segments.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}

/** 链的聚合态：最后一段还活着就取它，否则取最后一段的终态 */
function deriveLineageState(/** @type {any} */ lineage) {
  const segments = lineage.segments
  if (!segments.length) return 'unknown'
  const last = segments[segments.length - 1]
  return last.state ?? 'unknown'
}

/** 链的最后活动时间：段的活动时间与链自身取最大 */
function deriveLastActivity(/** @type {any} */ lineage) {
  let at = Number(lineage.lastActivityAt ?? 0)
  for (const segment of lineage.segments) {
    at = Math.max(at, segment.activity?.lastActivityAt ?? 0, segment.startedAt ?? 0, segment.endedAt ?? 0)
  }
  return at
}

/** 刷新链上的派生字段（agent/cwd 取第一段有值的，等价于「谁先派的就是谁」） */
function refreshLineage(/** @type {any} */ lineage) {
  sortSegments(lineage)
  for (const segment of lineage.segments) {
    if (!lineage.agent && segment.agent) lineage.agent = segment.agent
    if (!lineage.cwd && segment.cwd) lineage.cwd = segment.cwd
    if (!lineage.asyncDir && segment.asyncDir) lineage.asyncDir = segment.asyncDir
  }
  lineage.lastActivityAt = deriveLastActivity(lineage)
  lineage.state = deriveLineageState(lineage)
}

/**
 * 收到 `async-started`。
 *
 * 载荷键（实测）：`id / pid / sessionId / mode / toolCallId / agent / task / goal / cwd /
 * asyncDir / sessionRoot / timeoutMs / deadlineAt / nestedRoute`。`startedAt` 没有，
 * 用到达时间。任务文本被 redact，不存。
 *
 * @param {any} state
 * @param {any} payload
 * @param {number} at
 */
export function applyStarted(state, payload, at) {
  const runId = String(payload?.id ?? payload?.runId ?? '')
  if (!runId) return null

  const existing = findSegment(state, runId)
  if (existing) {
    const { segment } = existing
    segment.state = 'running'
    segment.agent = payload.agent ?? segment.agent
    segment.cwd = payload.cwd ?? segment.cwd
    segment.asyncDir = payload.asyncDir ?? segment.asyncDir
    segment.activity.lastActivityAt = at
    refreshLineage(existing.lineage)
    return existing
  }

  const root = payload.revivedFrom ? lineageRootOf(state, String(payload.revivedFrom)) : runId
  let lineage = state.lineages.find((/** @type {any} */ item) => item.lineageRoot === root)
  if (!lineage) {
    lineage = createLineage(root, { agent: payload.agent, cwd: payload.cwd, asyncDir: payload.asyncDir, at })
    state.lineages.push(lineage)
  }
  const segment = createSegment(
    { ...payload, state: 'running', startedAt: at },
    at,
    'started',
  )
  lineage.segments.push(segment)
  refreshLineage(lineage)
  return { lineage, segment }
}

/**
 * 收到 `async-complete`。
 *
 * 载荷键（实测）：`id / runId / sessionId(父会话) / sessionFile(子会话) / agent / mode /
 * success / state / summary / stopped / error / exitCode / durationMs / totalTokens /
 * totalCost / timestamp / results[] / asyncDir / cwd`。
 * `results[]` 每项：`agent / model / status / sessionFile / usage / index / output`。
 *
 * @param {any} state
 * @param {any} payload
 * @param {number} at
 */
export function applyComplete(state, payload, at) {
  const runId = String(payload?.id ?? payload?.runId ?? '')
  if (!runId) return null

  const endedAt = Number.isFinite(payload.timestamp) ? Number(payload.timestamp) : at
  const childFile = typeof payload.sessionFile === 'string' ? payload.sessionFile : null
  let found = findSegment(state, runId)

  if (!found) {
    // 没有这一段：可能是「插件中途才起来」或「resume 出来的新段」。
    // 先靠子会话首行的 parentSession 找上一段（resume 时它指向前一段的子会话），
    // 找到就把新段接在那条链尾部；找不到才自成一链。
    const parent = payload.childParentSession
      ? findSegmentByChildSession(state, String(payload.childParentSession))
      : null
    const lineage = parent
      ? parent.lineage
      : createLineage(runId, { agent: payload.agent, at })
    const segment = createSegment(
      {
        ...payload,
        runId,
        revivedFrom: parent ? parent.segment.runId : payload.revivedFrom ?? null,
        startedAt: endedAt - (Number.isFinite(payload.durationMs) ? Number(payload.durationMs) : 0),
      },
      at,
      'complete',
    )
    lineage.segments.push(segment)
    if (!parent) state.lineages.push(lineage)
    refreshLineage(lineage)
    found = { lineage, segment }
  }

  const { segment } = found
  let lineage = found.lineage

  // 复活接链：resume 的新段在 `async-started` 时无从判断归属（那时还没有子会话路径），
  // 只能到 complete 才拿到子会话首行的 parentSession。如果这段目前是「孤零零一条链」，
  // 而 parentSession 指向的段在另一条链上，就把它整体挪过去。
  if (payload.childParentSession) {
    const parent = findSegmentByChildSession(state, String(payload.childParentSession))
    if (parent && parent.lineage !== lineage && lineage.lineageRoot === segment.runId && lineage.segments.length === 1) {
      const index = state.lineages.indexOf(lineage)
      if (index >= 0) state.lineages.splice(index, 1)
      segment.revivedFrom = parent.segment.runId
      parent.lineage.segments.push(segment)
      lineage = parent.lineage
    }
  }

  segment.state = normalizeState(payload.state, payload.success, payload.stopped)
  segment.endedAt = endedAt
  segment.agent = payload.agent ?? segment.agent
  segment.cwd = payload.cwd ?? segment.cwd
  segment.asyncDir = payload.asyncDir ?? segment.asyncDir
  segment.childSessionFile = childFile ?? segment.childSessionFile
  segment.exitCode = Number.isFinite(payload.exitCode) ? payload.exitCode : segment.exitCode
  segment.durationMs = Number.isFinite(payload.durationMs) ? payload.durationMs : segment.durationMs
  segment.summary = typeof payload.summary === 'string' && payload.summary.trim() ? payload.summary.trim() : segment.summary
  segment.error = payload.stopped ? null : (payload.error ?? segment.error)
  const tokens = payload.totalTokens
  if (tokens && typeof tokens === 'object') {
    segment.tokens = {
      input: Number(tokens.input) || 0,
      output: Number(tokens.output) || 0,
      total: Number(tokens.total) || 0,
    }
  }
  const cost = payload.totalCost
  if (cost && typeof cost === 'object' && Number.isFinite(cost.costUsd)) segment.costUsd = Number(cost.costUsd)

  const results = Array.isArray(payload.results) ? payload.results : []
  if (results.length) {
    segment.children = results.map((/** @type {any} */ result, /** @type {number} */ index) => ({
      index: Number.isFinite(result?.index) ? Number(result.index) : index,
      agent: result?.agent ?? null,
      model: result?.model ?? null,
      thinking: null,
      state: normalizeState(result?.status, result?.success),
      sessionFile: result?.sessionFile ?? null,
      lastActivityAt: endedAt,
    }))
    const first = results[0]
    if (first?.sessionFile && !segment.childSessionFile) segment.childSessionFile = first.sessionFile
  }

  refreshLineage(lineage)
  return found
}

/**
 * 用 `status {}` 的当前进度覆写活跃段。
 *
 * status 的 run 只有 `id / kind / label / state / startedAt / updatedAt / endedAt /
 * activity{lastActivityAt,turnCount,toolCount} / children[]`；children 每项多
 * `agent / model / thinking`。**没有 sessionFile / cwd / cost**，所以这里只做覆盖，
 * 不新增字段。
 *
 * @param {any} state
 * @param {any} data status 的 reply.data
 * @param {number} at
 */
export function mergeStatus(state, data, at) {
  const runs = Array.isArray(data?.asyncSnapshot?.runs)
    ? data.asyncSnapshot.runs
    : Array.isArray(data?.runs)
      ? data.runs
      : []
  for (const run of runs) {
    const runId = String(run?.id ?? run?.runId ?? '')
    if (!runId) continue
    let found = findSegment(state, runId)
    if (!found) {
      // 插件在 run 中途起来：status 是唯一能看见这段的东西
      const lineage = createLineage(runId, { agent: run.label ?? null, at })
      const segment = createSegment({ runId, state: run.state, startedAt: run.startedAt, agent: run.label }, at, 'status')
      lineage.segments.push(segment)
      state.lineages.push(lineage)
      refreshLineage(lineage)
      found = { lineage, segment }
    }
    const { segment, lineage } = found
    segment.state = normalizeState(run.state)
    if (Number.isFinite(run.startedAt)) segment.startedAt = Number(run.startedAt)
    if (Number.isFinite(run.endedAt)) segment.endedAt = Number(run.endedAt)
    segment.activity = {
      lastActivityAt: Number.isFinite(run.activity?.lastActivityAt) ? Number(run.activity.lastActivityAt) : at,
      turnCount: Number.isFinite(run.activity?.turnCount) ? Number(run.activity.turnCount) : segment.activity?.turnCount ?? null,
      toolCount: Number.isFinite(run.activity?.toolCount) ? Number(run.activity.toolCount) : segment.activity?.toolCount ?? null,
    }
    if (Array.isArray(run.children) && run.children.length) {
      segment.children = mergeChildren(segment.children, run.children, segment.childSessionFile)
    }
    if (Number.isFinite(run.updatedAt)) lineage.lastActivityAt = Math.max(lineage.lastActivityAt ?? 0, Number(run.updatedAt))
    refreshLineage(lineage)
  }
}

/**
 * 合并 children：status 的条目带最新 state/model/thinking，事件补出来的条目带 sessionFile。
 * 同一 index 取并集，其余字段以 status 为准。
 * @param {any[]} existing
 * @param {any[]} incoming
 * @param {string | null} childSessionFile
 */
function mergeChildren(existing, incoming, childSessionFile) {
  const byIndex = new Map()
  for (const child of existing ?? []) byIndex.set(Number(child.index) || 0, { ...child })
  for (const raw of incoming) {
    const index = Number.isFinite(raw?.index) ? Number(raw.index) : byIndex.size
    const previous = byIndex.get(index) ?? {}
    byIndex.set(index, {
      ...previous,
      index,
      agent: raw?.agent ?? previous.agent ?? null,
      model: raw?.model ?? previous.model ?? null,
      thinking: raw?.thinking ?? previous.thinking ?? null,
      state: normalizeState(raw?.state, undefined, undefined),
      lastActivityAt: Number.isFinite(raw?.activity?.lastActivityAt) ? Number(raw.activity.lastActivityAt) : previous.lastActivityAt ?? null,
      // 单 child 的 run（绝大多数）直接复用 run 的子会话路径；多 child 靠路径里的 run-<i> 区分
      sessionFile: previous.sessionFile ?? (byIndex.size <= 1 ? childSessionFile : null),
    })
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/**
 * 给 UI 的列表：按最后活动时间降序（复活后立刻跳回顶部，用户才能察觉「它又动了」）。
 * 返回浅拷贝，避免调用方改到状态本体。
 * @param {any} state
 */
export function listLineages(state) {
  return [...(state?.lineages ?? [])]
    .map((lineage) => ({ ...lineage, segments: [...lineage.segments] }))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
}

/** 活跃 run 数（不是链数：一条链里同时可能有多段在跑） */
export function activeCount(state) {
  let count = 0
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments) if (isActiveState(segment.state)) count += 1
  }
  return count
}
