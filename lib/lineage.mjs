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
  // stopping 是 stop 受理后的中间态（回执 state: "stopping"），必须留着显示——
  // 归一成 unknown 的话用户点了停止却看到「未知」，会以为插件坏了
  // `lost` 是插件侧判出来的「进程已经没了」（应用重启把它带走，status.json 却永远停在
  // running）。它不是上游给的状态，但必须进白名单，否则归一时会被抹成 unknown。
  const known = [
    'running',
    'queued',
    'stopping',
    'complete',
    'failed',
    'partial',
    'stopped',
    'paused',
    'rejected',
    'lost',
  ]
  if (known.includes(value)) return value
  if (stopped) return 'stopped'
  if (success === true) return 'complete'
  if (success === false) return 'failed'
  return 'unknown'
}

/** 终态：进了这里 status 就不该再碰——status 的 runs 列表会长期保留已完成的 run， */
/** 不跳过的话每 5s 心跳都会重复 merge 并写盘（实测 mtime 一直刷到几分钟之后）。 */
const TERMINAL_STATES = new Set(['complete', 'failed', 'partial', 'stopped', 'rejected', 'lost'])

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
      /**
       * 干预能力的布尔面（来自 `ping.capabilities.{steer,stop}`）。
       * capabilities 只留了键名，值丢失；而「不能插话」得让按钮置灰而不是点了报错。
       */
      supports: /** @type {{ steer: boolean, stop: boolean } | null} */ (null),
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

/**
 * 两个会话路径是不是同一份文件。
 *
 * 必须容错：事件载荷里的路径来自扩展（反斜杠、盘符大小写不定），`status.json` 里的
 * 来自 runner（`path.join`），而 `childSessionFile` 有时是我们自己拼的。严格相等在
 * Windows 上会因为一个斜杠方向对不上，表现成「resume 永远接不上链」——已经踩过一次。
 * 先精确比，再按「统一分隔符 + 忽略大小写」比；Linux 上后一步可能误判，但两份路径
 * 通常同源，差异只会出在分隔符。
 * @param {unknown} a @param {unknown} b
 */
export function samePath(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  if (!left || !right) return false
  if (left === right) return true
  const norm = (/** @type {string} */ value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(left) === norm(right)
}

/** @param {any} state @param {string} childSessionFile */
function findSegmentByChildSession(state, childSessionFile) {
  for (const lineage of state.lineages) {
    for (const segment of lineage.segments) {
      if (samePath(segment.childSessionFile, childSessionFile)) return { lineage, segment }
    }
  }
  return null
}

/**
 * 同上，但取**最后一个**匹配段（链尾）。
 *
 * resume 实测会**复用同一个子会话文件**继续写（首行 `parentSession` 指向父会话而非
 * 前一段），所以一条 resume 链上的每一段 `childSessionFile` 都相同——接链必须取链尾，
 * 取第一个会把第 3 次 resume 接到第 1 段后面。
 * @param {any} state
 * @param {string} childSessionFile
 */
function findLastSegmentByChildSession(state, childSessionFile) {
  if (!childSessionFile) return null
  let best = null
  for (const lineage of state.lineages) {
    for (const segment of lineage.segments) {
      if (samePath(segment.childSessionFile, childSessionFile)) best = { lineage, segment }
    }
  }
  return best
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
    /**
     * 子代理的会话名：`"worker: 你是测试用子代理 A。工作目录: …"`。
     * 顶层的 run 没有 name 参数（测试报告 P1），这个名字是**唯一**能区分
     * 同角色并发实例的东西，所以一路带上来给面板当标题。
     */
    sessionName: payload.sessionName ?? null,
    /** 实际用的模型 / 思考档位（来自 run 的 status.json，agent 侧补齐）——卡片上要能一眼看见分层生效 */
    model: payload.model ?? null,
    thinking: payload.thinking ?? null,
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
 * 用「run 自己的 status.json」把卡住的段推进终态（自愈）。
 *
 * 为什么需要：live 文件是**扩展实例在某个时刻的快照**，而它的更新完全依赖事件。
 * `async-complete` 恰好是这一轮**最后一个**事件——扩展换代、退出、或者订阅断掉，
 * 那一次就没有人把它写下来，卡片永远停在「运行中」：中间过程（child-status）都在动，
 * 唯独「这张卡结束了」这一步丢。等下次切面板、插件重载，换一个新实例重新读 status，
 * 才「突然好了」——这就是「最后一个完成的卡不刷新」的机制。
 *
 * 而 run 目录里的 `status.json` 是 pi-subagents 自己写的**地面真相**，与插件生死无关。
 * 所以由 main（它一直活着）每轮顺手核对一次：段还是活的、run 说它已经终态，就以 run
 * 为准。只在活跃段上做——终态段不再读，代价是每个活跃段一次 stat。
 *
 * `readSnapshot` 由调用方注入：这个文件是纯逻辑，不碰 IO。
 *
 * @param {any} state
 * @param {(asyncDir: string) => any} readSnapshot
 * @returns {number} 被推进终态的段数
 */
export function healFromSnapshots(state, readSnapshot) {
  let healed = 0
  for (const lineage of state?.lineages ?? []) {
    let touched = false
    for (const segment of lineage.segments ?? []) {
      if (!isActiveState(segment.state)) continue
      const dir = String(segment.asyncDir ?? '').trim()
      if (!dir) continue
      const snap = readSnapshot(dir)
      if (!snap || !TERMINAL_STATES.has(String(snap.state))) continue
      segment.state = normalizeState(snap.state)
      const ended = Number(snap.endedAt)
      segment.endedAt = Number.isFinite(ended) && ended > 0 ? ended : Date.now()
      // 活动时间跟着落地：链的排序按它走，卡片才会挪到「已结束」那一段去
      segment.activity = {
        ...(segment.activity ?? {}),
        lastActivityAt: Math.max(Number(segment.activity?.lastActivityAt) || 0, segment.endedAt),
      }
      healed += 1
      touched = true
    }
    if (touched) refreshLineage(lineage)
  }
  return healed
}

/**
 * 进程已经不在、status.json 却永远停在 running 的段 → 判成「已中断」（`lost`）。
 *
 * 这是「应用重启」留下的坑：run 的 runner 是 Electron 的子进程，重启把整棵进程树带走，
 * 但没有机会写终态。`status.json` 于是冻结在最后一帧（`state: running`），任何基于
 * 「文件里写了什么」的判定都会一直说它在跑——卡片永远转圈，停止按钮点了也没人接。
 *
 * 唯一可靠的判据是 pid：`isAlive(pid) === false` 就说明这条 run 不可能再动了。
 * 不做「多少秒没更新就判死」——静默长思考是正常的，误判的代价比多等一会更大。
 *
 * @param {any} state
 * @param {(dir: string) => any} readSnapshot
 * @param {(pid: unknown) => boolean} isAlive
 * @returns {number} 这一次判成中断的段数
 */
export function healDeadProcesses(state, readSnapshot, isAlive) {
  let lost = 0
  for (const lineage of state?.lineages ?? []) {
    let touched = false
    for (const segment of lineage.segments ?? []) {
      if (!isActiveState(segment.state)) continue
      const dir = String(segment.asyncDir ?? '').trim()
      if (!dir) continue
      const snap = readSnapshot(dir)
      if (!snap || !snap.pid) continue
      // 有终态的照终态走（healFromSnapshots 负责），这里只管「还没结束但进程没了」
      if (TERMINAL_STATES.has(String(snap.state))) continue
      if (isAlive(snap.pid)) continue
      segment.state = 'lost'
      // 留下 pid 是为了诊断：「到底谁死了」在日志/卡面 title 里能直接看到
      segment.lostPid = Number(snap.pid) || null
      const ended = Number(snap.lastUpdate)
      segment.endedAt = Number.isFinite(ended) && ended > 0 ? ended : Date.now()
      // 什么都没跑完：排队中的步骤不该再挂着
      segment.pendingSteps = []
      segment.activity = {
        ...(segment.activity ?? {}),
        lastActivityAt: Math.max(Number(segment.activity?.lastActivityAt) || 0, segment.endedAt),
      }
      lost += 1
      touched = true
    }
    if (touched) refreshLineage(lineage)
  }
  return lost
}

/**
 * 终态段不该挂着「排队中的步骤」。
 *
 * 旧版本（≤0.9.7）把普通代理的 `steps[0]` 当成「待启动的一步」写进了 live 文件，
 * 于是 run 结束后卡上还留着一行「第 1 步 · 待启动」、身份行写着「0/1 完成」。
 * 数据源头已经修了（见 run-snapshot.mjs 的 pendingStepsOf），但 live 文件是扩展写的，
 * 而扩展**只有新会话才换代**——不清一遍，用户得等到下次开会话才看不见那张幽灵卡。
 * 所以读侧再抹一次：跑完的段不可能还有「在排队等启动」的步骤。
 *
 * @param {any} state
 * @returns {number} 清掉了几个段（诊断用）
 */
export function clearTerminalPending(state) {
  let cleared = 0
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments ?? []) {
      if (isActiveState(segment.state)) continue
      if (!(segment.pendingSteps ?? []).length) continue
      segment.pendingSteps = []
      cleared += 1
    }
  }
  return cleared
}

/**
 * 读侧接链自愈：把「明明记着 `revivedFrom`、却还自成一链」的段认回来源段。
 *
 * 什么时候会有这种脏数据：resume 开始后、插件还没接上链就被重启/换代，孤链被写进了
 * live 文件。之后无论怎么读，它都是一张独立的卡——用户看到的是「同一个东西出现了两遍」。
 *
 * 顺序很重要：链内段按 `startedAt` 升序排（`refreshLineage` 保证），从旧到新处理才能
 * 让 `reviveHops` 逐级累加；反过来先处理链尾会让跳数少算。
 * @param {any} state
 * @returns {number} 被搬进来源链的段数
 */
export function relinkOrphans(state) {
  let moved = 0
  for (const lineage of [...(state?.lineages ?? [])]) {
    for (const segment of [...(lineage.segments ?? [])]) {
      const from = String(segment.revivedFrom ?? '').trim()
      if (!from) continue
      const hit = linkRevived(state, String(segment.runId ?? ''), { revivedFrom: from })
      if (hit?.merged) moved += 1
    }
  }
  return moved
}

/**
 * 读侧兜底：段上没有 `revivedFrom`，但 run 自己的 `status.json` 里写着，就补上。
 *
 * 为什么需要：`async-started` 的载荷不带 `revivedFrom`，续跑的归属要么来自 launch
 * 描述符（0.10.4 起，见 `resumeSourceOf`），要么等 status.json。而上一代插件写下的
 * 历史段可能两边都没赶上——它就那么以孤链留在 live 文件里。
 *
 * 为什么放在 main 而不是 worker：worker 的 state 只有**本代**见过的段，而 main 合并了
 * 所有代的 live 文件。resume 最常发生在「刚重启 / 插件刚换代」之后，那时候 worker 手里
 * 根本没有来源段，main 却有——同一件判断，main 的成功率高得多。
 *
 * 只碰活跃段、只碰还没有 `revivedFrom` 的段：终态的归属不会再变了，已经接过的不必重读。
 * @param {any} state
 * @param {(asyncDir: string) => any} readSnapshot
 * @returns {number} 这次补上 `revivedFrom` 的段数
 */
export function adoptRevivedFromSnapshots(state, readSnapshot) {
  let adopted = 0
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments ?? []) {
      if (String(segment.revivedFrom ?? '').trim()) continue
      if (!isActiveState(segment.state) && segment.state !== 'stopping') continue
      const dir = String(segment.asyncDir ?? '').trim()
      if (!dir) continue
      const snap = readSnapshot(dir)
      const from = String(snap?.revivedFrom ?? '').trim()
      if (!from) continue
      segment.revivedFrom = from
      // 子会话文件顺手纠正：续跑复用的是来源 run 的那一份，started 阶段猜的是自己的
      const file = (snap?.steps ?? [])
        .map((/** @type {any} */ step) => String(step?.sessionFile ?? '').trim())
        .find(Boolean) || ''
      if (file) segment.childSessionFile = file
      adopted += 1
    }
  }
  return adopted
}

/**
 * 把同一会话的多份 live 状态合成一份（**按代合并**，不按时间取最新）。
 * 背景：live 文件名带「实例后缀」（`<sessionKey>-<pid>-<startedAt>.json`），因为扩展
 * 会随会话切换**换代**——每个新实例的 `state` 都是空的。原先是「按 startedAt 取最新
 * 的那一份」，于是：
 *
 *   · 刚开软件 / 刚换会话那一刻，新实例只知道自己见过的 run，**历史卡片凭空消失**，
 *     要等它把 status 读一遍才回来一部分（而 status 只报还在跑的）；
 *   · 上一代写下的终态段，新一代根本不知道，看起来就是「这张卡停在运行中不再刷新」。
 *
 * 正确做法是取**并集**：所有代都得看，同一个 runId 以更新的那一代为谁；只有老一代
 * 才有的段保留下来。这样「换一次实例丢一段历史」不会再发生。
 *
 * 顶层字段（sessionFile / source / updatedAt / startedAt）取最新一代——判活、能力、
 * 数据源都得以当前这个实例为准。
 *
 * @param {any[]} states 按 startedAt **从老到新**排好的状态
 */
export function mergeLiveStates(states) {
  const list = (Array.isArray(states) ? states : []).filter((state) => state && typeof state === 'object')
  if (!list.length) return null
  if (list.length === 1) return list[0]

  const newest = list[list.length - 1]
  /** 同一条链在同一代里只会出现一次；跨代按 lineageRoot 对齐 @type {Map<string, any>} */
  const byRoot = new Map()
  for (const state of list) {
    for (const lineage of state.lineages ?? []) {
      const root = String(lineage?.lineageRoot ?? '')
      if (!root) continue
      let target = byRoot.get(root)
      if (!target) {
        target = { ...lineage, segments: [] }
        byRoot.set(root, target)
      }
      target.agent = lineage.agent ?? target.agent
      target.cwd = lineage.cwd ?? target.cwd
      target.asyncDir = lineage.asyncDir ?? target.asyncDir
      target.lastActivityAt = Math.max(Number(target.lastActivityAt) || 0, Number(lineage.lastActivityAt) || 0)
      for (const segment of lineage.segments ?? []) {
        const runId = String(segment?.runId ?? '')
        if (!runId) continue
        const at = target.segments.findIndex((/** @type {any} */ item) => String(item.runId) === runId)
        // 后写的是更新的那一代：同 runId 直接覆盖（终态一旦落地就不会再被翻回 running）
        if (at >= 0) target.segments[at] = segment
        else target.segments.push(segment)
      }
    }
  }
  const lineages = [...byRoot.values()]
  for (const lineage of lineages) refreshLineage(lineage)
  return { ...newest, lineages }
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
 * 把一段认回它的来源段（resume 的「原地复活」）。
 *
 * 为什么需要这个函数：`async-started` 的载荷里**没有** `revivedFrom`，也没有
 * `sessionFile`（上游 `async-execution.js` 的 emit 字段清单为证）。所以 run 刚起来的
 * 那几百毫秒里，我们手里只有 runId，只能先建一条孤链——用户看到的就是「又冒出一张
 * 新卡」。而 run 目录里的 `status.json` **第一帧就带 `revivedFrom` 和
 * `steps[].sessionFile`**（runner 构造 payload 时就写），读一次就能接上。
 *
 * 线索优先级：
 *   1. `revivedFrom` —— 直接来源的 runId，最准，跨目录也成立；
 *   2. `sessionFile` —— resume 复用同一份子会话文件，命中链尾段即同一条链。
 *
 * 搬完把孤链清掉（`splice`），整条链只留一份 `refreshLineage` 的结果；
 * 返回 `merged` 说明「这次真的搬了段」，供诊断计数用。
 *
 * @param {any} state
 * @param {string} runId
 * @param {{ revivedFrom?: string | null, sessionFile?: string | null }} hint
 * @returns {{ lineage: any, segment: any, merged: boolean } | null}
 */
export function linkRevived(state, runId, hint = {}) {
  const found = findSegment(state, String(runId ?? ''))
  if (!found) return null
  const { segment } = found

  /** @type {{ lineage: any, segment: any } | null} */
  let source = null
  const revivedFrom = String(hint.revivedFrom ?? '').trim()
  if (revivedFrom) source = findSegment(state, revivedFrom)
  if (!source && hint.sessionFile) {
    const byFile = findLastSegmentByChildSession(state, String(hint.sessionFile))
    // 命中的是自己（推导出来的 childSessionFile 恰好等于候选）不算来源
    if (byFile && byFile.segment !== segment) source = byFile
  }
  if (!source) return null

  // 字段先补：即使两条链本来就同根（老数据/事件已带 revivedFrom），徽标也得对
  segment.revivedFrom = String(source.segment.runId)
  segment.reviveRoot = source.segment.reviveRoot || source.lineage.lineageRoot
  segment.reviveHops = (Number(source.segment.reviveHops) || 0) + 1
  delete segment.reviveProbe

  if (source.lineage === found.lineage) {
    refreshLineage(found.lineage)
    return { lineage: found.lineage, segment, merged: false }
  }

  // 搬段：按 startedAt 插进去，事件乱序时也不能排到前面
  const orphan = found.lineage
  orphan.segments = orphan.segments.filter((/** @type {any} */ item) => item !== segment)
  source.lineage.segments.push(segment)
  refreshLineage(source.lineage)
  refreshLineage(orphan)
  if (!orphan.segments.length) {
    const at = state.lineages.indexOf(orphan)
    if (at >= 0) state.lineages.splice(at, 1)
  }
  return { lineage: source.lineage, segment, merged: true }
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

  // 接链线索，按实测可靠性排序：
  //   1. **复用同一个子会话文件**：resume 不开新文件，往原 session.jsonl 继续写——
  //      新段 sessionFile 与某段 childSessionFile 相同，就是「那个人又接着说了一句」。
  //      取链尾（同一文件被整条链共享）。
  //   2. 子会话首行 parentSession：实测指向**父会话**而非前一段子会话，只对 fresh
  //      fork 出的新文件才可能命中；留着兜底。
  let parent = childFile ? findLastSegmentByChildSession(state, childFile) : null
  if (!parent && payload.childParentSession) {
    parent = findSegmentByChildSession(state, String(payload.childParentSession))
  }

  let found = findSegment(state, runId)

  if (!found) {
    if (parent) {
      // resume 出来的新段（插件中途才看到它的 complete）：直接接在链尾
      const segment = createSegment(
        {
          ...payload,
          runId,
          revivedFrom: parent.segment.runId,
          startedAt: endedAt - (Number.isFinite(payload.durationMs) ? Number(payload.durationMs) : 0),
        },
        at,
        'complete',
      )
      parent.lineage.segments.push(segment)
      refreshLineage(parent.lineage)
      found = { lineage: parent.lineage, segment }
    } else {
      // 插件在 run 开始之后才起来：整段补出来（缺 cwd/asyncDir，UI 要能容忍）
      const lineage = createLineage(runId, { agent: payload.agent, at })
      const segment = createSegment(
        {
          ...payload,
          runId,
          startedAt: endedAt - (Number.isFinite(payload.durationMs) ? Number(payload.durationMs) : 0),
        },
        at,
        'complete',
      )
      lineage.segments.push(segment)
      state.lineages.push(lineage)
      refreshLineage(lineage)
      found = { lineage, segment }
    }
  } else if (parent && parent.lineage !== found.lineage && found.lineage.segments.length === 1 && found.lineage.lineageRoot === runId) {
    // async-started 先建的孤链：complete 时确定了归属（它复用的是别的段的子会话文件），
    // 整体挪过去。条件限定「孤链」——已有多段的链不动，避免误挪。
    const index = state.lineages.indexOf(found.lineage)
    if (index >= 0) state.lineages.splice(index, 1)
    found.segment.revivedFrom = parent.segment.runId
    parent.lineage.segments.push(found.segment)
    found.lineage = parent.lineage
  }

  const { segment, lineage } = found

  segment.state = normalizeState(payload.state, payload.success, payload.stopped)
  segment.endedAt = endedAt
  segment.agent = payload.agent ?? segment.agent
  if (typeof payload.sessionName === 'string' && payload.sessionName.trim()) segment.sessionName = payload.sessionName.trim()
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
    segment.children = results.map((/** @type {any} */ result, /** @type {number} */ index) =>
      normalizeModelThinking({
        index: Number.isFinite(result?.index) ? Number(result.index) : index,
        agent: result?.agent ?? null,
        // 会话名（任务首行）——面板卡片标题的来源，见 createSegment 注释
        sessionName: result?.sessionName ?? null,
        model: result?.model ?? null,
        thinking: null,
        state: normalizeState(result?.status, result?.success),
        sessionFile: result?.sessionFile ?? null,
        lastActivityAt: endedAt,
      }),
    )
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
    // 已终态的段不再吃 status：事件（async-complete）的信息比 status 全，
    // 且不跳过的话心跳会一直改它、写盘、刷新 lastActivityAt，UI 跟着一直动
    if (TERMINAL_STATES.has(segment.state)) continue
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
  let position = 0
  for (const raw of incoming) {
    // 实测 pi-subagents 的 status children **不带 index**。不能用 byIndex.size 兜底——
    // 那会把同一条 child 每次轮询都当成「第 N 个新 child」追加，children 无限增长
    // （实测 1 分钟攒出 59 条）。status 每次返回同一份快照，位置是稳定的，按位置归位。
    const index = Number.isFinite(raw?.index) ? Number(raw.index) : position
    position += 1
    const previous = byIndex.get(index) ?? {}
    byIndex.set(index, {
      ...previous,
      index,
      agent: raw?.agent ?? previous.agent ?? null,
      // 同类并发时唯一可区分的东西（P1）；status 里有，事件里也有，取先到的
      sessionName: raw?.sessionName ?? previous.sessionName ?? null,
      model: raw?.model ?? previous.model ?? null,
      thinking: raw?.thinking ?? previous.thinking ?? null,
      state: normalizeState(raw?.state, undefined, undefined),
      lastActivityAt: Number.isFinite(raw?.activity?.lastActivityAt) ? Number(raw.activity.lastActivityAt) : previous.lastActivityAt ?? null,
      // 「它正在跑什么」——status 独有，卡片上显示成 `bash 2.3s`
      currentTool: raw?.currentTool ?? previous.currentTool ?? null,
      currentToolStartedAt: Number.isFinite(raw?.currentToolStartedAt) ? Number(raw.currentToolStartedAt) : previous.currentToolStartedAt ?? null,
      // 单 child 的 run（绝大多数）直接复用 run 的子会话路径；多 child 靠路径里的 run-<i> 区分
      sessionFile: previous.sessionFile ?? (incoming.length === 1 ? childSessionFile : null),
    })
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/**
 * 归一 child 的 model / thinking 表述。
 *
 * 同一个 child 在两个来源里写法不同：async-complete 的 results 里是
 * `model: "deepseek/deepseek-flash:high"`（thinking 档位编在模型名后缀），
 * status 里是 `model: "deepseek/deepseek-flash" + thinking: "high"`。
 * 不归一的话自愈收敛对不上、UI 也会显示两种写法。
 * @param {any} child
 */
export function normalizeModelThinking(child) {
  if (!child || child.thinking || typeof child.model !== 'string') return child
  const match = /:(high|medium|low|minimal|xhigh|off)$/.exec(child.model)
  if (!match) return child
  return { ...child, model: child.model.slice(0, child.model.length - match[0].length), thinking: match[1] }
}

/**
 * 收敛 children：修复「mergeChildren 按 byIndex.size 兜底」时期攒出来的重复条目
 * （同一条 child 被每次轮询追加一条，实测 1 分钟攒出 59 条、2 小时 123 条）。
 *
 * 三层收敛，按保守程度递进：
 *   1. sessionFile 相同 → 必是同一个 child，字段级合并；
 *   2. 无路径条目若与某条带路径条目身份全同（agent/model/thinking/state）→ 吸收；
 *   3. 剩余无路径条目按完整签名（含 lastActivityAt）去重——真实并行的多个 child
 *      不可能 lastActivityAt 精确到毫秒还全同。
 * 已收敛过的干净数据走这个函数是无操作。
 * @param {any[] | undefined} children
 */
function sanitizeChildren(children) {
  if (!Array.isArray(children)) return []
  const withFile = new Map()
  const loose = []
  for (const raw of children) {
    const child = normalizeModelThinking(raw)
    if (child?.sessionFile) {
      const kept = withFile.get(child.sessionFile)
      if (!kept) withFile.set(child.sessionFile, { ...child })
      else for (const key of ['index', 'agent', 'sessionName', 'model', 'thinking', 'state', 'lastActivityAt', 'currentTool']) if (kept[key] == null && child[key] != null) kept[key] = child[key]
    } else {
      loose.push(child)
    }
  }
  const merged = [...withFile.values()]
  const rooted = [...withFile.values()]
  const seen = new Set()
  for (const child of loose) {
    // 第 2 层：身份与某条**带路径**条目全同的无路径条目是孪生，吸收。
    // 注意范围只在 withFile——loose 之间身份相同是真实并行 child 的常态，
    // 只能靠第 3 层的 lastActivityAt 区分。
    const twin = rooted.find(
      (kept) =>
        kept.agent === child.agent && kept.model === child.model && (kept.thinking ?? null) === (child.thinking ?? null) && kept.state === child.state,
    )
    if (twin) continue
    const signature = [child?.agent, child?.model, child?.thinking, child?.state, child?.lastActivityAt].join('|')
    if (seen.has(signature)) continue
    seen.add(signature)
    merged.push(child)
  }
  return merged.sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
}

/** 算作「没成」的状态（`stopped` 是你自己叫停的，不算失败，别混进来） */
const FAILED_STATES = new Set(['failed', 'error', 'timeout', 'rejected'])

/**
 * 这次失败是「跑了但没成」还是「压根没起来」。
 *
 * 两种在数据上**全叫 `failed`**，面板原来只能都写「失败」——于是下面这两张卡长得
 * 一模一样：
 *
 *   · `Subagent timed out after 6000ms.`（子代理真跑了 6 秒，超时）
 *   · `Error: … at workflow-script.js:17`（workflow 脚本第 17 行抛错，**一个子代理
 *     都没被创建**）
 *
 * 用户看不出前者是努力过，后者是根本没上场。判据不用 `state` 字面，用**执行痕迹**：
 * token、回合数、子代理明细，任何一样有值就说明它真的跑过；三样全空还失败，只能是
 * 没起来（脚本/运行时在启动第一个子代理之前就崩了）。
 *
 * 为什么**不看 `childSessionFile`**：实测它经常是一个**不存在**的路径（workflow 容器
 * 直接拼 `…/<runId>/run-0/session.jsonl`，而那个 run 压根没被创建）。拿它当证据，
 * 「脚本报错」会被误判成「跑过」——踩过一次，别再踩。
 *
 * @param {any} segment
 * @returns {'' | 'run' | 'launch'} `''` = 不是失败态
 */
export function failureStageOf(segment) {
  if (!segment || !FAILED_STATES.has(String(segment.state ?? ''))) return ''
  const ran =
    Number(segment.tokens?.total) > 0 ||
    Number(segment.activity?.turnCount) > 0 ||
    (Array.isArray(segment.children) && segment.children.length > 0)
  return ran ? 'run' : 'launch'
}

/** 链的末段 runId：组（父卡 + 各步骤子卡）的锚点挂在最后一个 run 上 */
export function lastRunIdOf(lineage) {
  const segments = Array.isArray(lineage?.segments) ? lineage.segments : []
  return String(segments[segments.length - 1]?.runId ?? '')
}

/**
 * 组的活动锚点：组内（含子卡、孙卡）最新活动时间。
 *
 * **不再是排序键**（0.9.9 起改用 `groupStartedAt`）。留着是因为「最近活动」仍然
 * 是判断「这东西还在动吗」的有效信号，裁剪保底与后续诊断都可能要用；但拿它排序
 * 会让并行运行的几张卡随谁刚调完一个工具互相插队，读起来一直在跳。
 *
 * `seen` 防环：父子关系来自磁盘上互指的 status.json，脏数据理论上能成环，递归不能
 * 靠「一定不会有环」的假设（真跑出过一次栈溢出）。
 *
 * @param {any} lineage
 * @param {Map<string, any[]>} [childrenOf]
 * @param {Set<any>} [seen]
 */
export function groupActivityOf(lineage, childrenOf = new Map(), seen = new Set()) {
  if (!lineage || seen.has(lineage)) return 0
  seen.add(lineage)
  let best = Number(lineage.lastActivityAt) || 0
  for (const child of childrenOf.get(lastRunIdOf(lineage)) ?? []) {
    best = Math.max(best, groupActivityOf(child, childrenOf, seen))
  }
  return best
}

/**
 * 链的排序时间：**链尾那一段的启动时间**。
 *
 * 一条链的「出生时刻」就是它最近一次被使用时那一刻——resume 会起一个新 run，
 * 它的 `startedAt` 比上一段晚，于是这张卡「又动了一次」，回到前面。注意这不是
 * 「最近活动」：跑了多久、调了多少工具、完成还是失败，都不改变这个值。
 *
 * 这样卡片的位置只在「它被启动」时移动一次，读起来是安静的；同时 0.8.8 撤掉
 * 「运行中置顶」想解决的「完成那刻跳位」也从根上消失了（键没有翻转的余地）。
 *
 * 缺 `startedAt` 的段（插件中途启动、由 status 补出来的残缺段）回退到结束时间，
 * 再回退到活动时间，最后是 0（排最后，总比丢掉强）。
 * @param {any} lineage
 */
export function startedAtOf(lineage) {
  const segments = Array.isArray(lineage?.segments) ? lineage.segments : []
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const at = Number(segments[index]?.startedAt)
    if (Number.isFinite(at) && at > 0) return at
  }
  const ended = endedAtOf(lineage)
  return ended || Number(lineage?.lastActivityAt) || 0
}

/**
 * 组的排序时间：组内（含子卡、孙卡）**最晚启动**的那一段。
 *
 * 用组内最大值而不是父卡自己的 `startedAt`：workflow 的第三步是十分钟后启动的，
 * 那一刻确实「这里又起了个新 run」，整组往前挪一格才对——否则一个正在推进的工作流
 * 会一直卡在很下面，用户以为它停了。
 *
 * `seen` 防环，理由同 `groupActivityOf`。
 * @param {any} lineage
 * @param {Map<string, any[]>} [childrenOf]
 * @param {Set<any>} [seen]
 */
export function groupStartedAt(lineage, childrenOf = new Map(), seen = new Set()) {
  if (!lineage || seen.has(lineage)) return 0
  seen.add(lineage)
  let best = startedAtOf(lineage)
  for (const child of childrenOf.get(lastRunIdOf(lineage)) ?? []) {
    best = Math.max(best, groupStartedAt(child, childrenOf, seen))
  }
  return best
}

/** 刚结束的卡「保底保留」窗口：结束后这段时间内，不因为翻页上限被裁掉 */
export const RECENT_ENDED_MS = 10 * 60 * 1000

/** 这一段是否「该留在面板上」：还活着，或者停在等用户处理（paused） */
function holdsCard(/** @type {any} */ state) {
  const key = String(state ?? '')
  return isActiveState(key) || key === 'paused'
}

/** 链的结束时刻：取最后一段有 endedAt 的；没有就用最后活动时间兜底 */
function endedAtOf(/** @type {any} */ lineage) {
  const segments = lineage?.segments ?? []
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const at = Number(segments[i]?.endedAt)
    if (Number.isFinite(at) && at > 0) return at
  }
  return Number(lineage?.lastActivityAt) || 0
}

/**
 * 从「全部链」里挑出要显示的，给右栏一个软上限。
 *
 * 为什么不能直接 `slice(0, limit)`：
 *
 *  - **运行中的卡必须留**。`lastActivityAt` 不是「是否还活着」的代理：长跑但静默的
 *    run（在编译、在等模型）、以及等待回答时（心跳有意不刷新活动时间，否则 UI 会
 *    一直动），它的时间会落后于一串刚结束的历史卡。照时间线一刀切，正在跑的那张
 *    恰好被切掉——「看不到还在跑的子代理」比看到旧卡糟得多。
 *  - **刚结束的卡也得留**。刚派出去的那个子代理跑完了，是用户最想确认的一件事；
 *    卡在边界上被裁掉，表现就是「一完成就消失」。
 *
 * 所以分两档：pinned（活跃 + 结束不足 `recentMs`）无条件保留，剩下的名额才按原时间
 * 序补历史卡。pinned 自身超过 limit 时不再裁——宁可右栏长一点，也不藏活着的卡。
 *
 * 顺序原样保留（`listLineages` 已按时间降序）：保底不会把卡重新排序，只是让它们
 * 不被切掉；「活跃卡上升到顶部」由 `linkContainers` 的组排序负责。
 *
 * @param {any[]} lineages 已排序的链
 * @param {{ limit?: number, now?: number, recentMs?: number }} [options]
 * @returns {{ shown: any[], hidden: number, pinned: number, active: number, recent: number }}
 */
export function pickVisible(lineages, options = {}) {
  const list = Array.isArray(lineages) ? lineages : []
  const { limit = 20, now = Date.now(), recentMs = RECENT_ENDED_MS } = options
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0

  /** @type {Set<number>} */
  const pinned = new Set()
  let active = 0
  let recent = 0
  for (const [index, lineage] of list.entries()) {
    const segments = Array.isArray(lineage?.segments) ? lineage.segments : []
    if (segments.some((/** @type {any} */ segment) => holdsCard(segment?.state)) || holdsCard(lineage?.state)) {
      pinned.add(index)
      active += 1
      continue
    }
    const ended = endedAtOf(lineage)
    if (ended > 0 && now - ended <= recentMs) {
      pinned.add(index)
      recent += 1
    }
  }

  const restBudget = Math.max(0, cap - pinned.size)
  /** @type {any[]} */
  const shown = []
  let restUsed = 0
  for (const [index, lineage] of list.entries()) {
    if (pinned.has(index)) {
      shown.push(lineage)
      continue
    }
    if (restUsed < restBudget) {
      shown.push(lineage)
      restUsed += 1
    }
  }

  return { shown, hidden: list.length - shown.length, pinned: pinned.size, active, recent }
}

/**
 * 给 UI 的列表：按最后活动时间降序（复活后立刻跳回顶部，用户才能察觉「它又动了」）。
 * 返回浅拷贝，避免调用方改到状态本体；children 在拷贝上收敛，旧数据读一次就好。
 *
 * 顺带算出 `canSteer` / `canStop`：**UI 照着置灰，而不是点了才报错**（计划 §5.4）。
 * 判定保守：只有活跃段（running / queued）可干预——前台 run 没有 async id，
 * paused run 的 stop 要 native runner-terminal proof，两者都明确不做。
 *
 * `failureStage` 也在这里算（见 `failureStageOf`）：投影时算，不落盘——存储里不必
 * 多一个会过期的派生字段，agent 侧也就不用来一次全量重写。
 * @param {any} state
 */
export function listLineages(state) {
  const supports = state?.source?.supports ?? null
  // 旧落盘文件没有 supports（字段后加）：不因此禁用，交给 RPC 回错误——
  // 禁用会让「明明能插话却灰着」，比报错更让人困惑。
  const canSteer = supports ? supports.steer === true : true
  const canStop = supports ? supports.stop === true : true
  return [...(state?.lineages ?? [])]
    .map((lineage) => ({
      ...lineage,
      segments: lineage.segments.map((/** @type {any} */ segment) => ({
        ...segment,
        children: sanitizeChildren(segment.children),
        canSteer: canSteer && isActiveState(segment.state),
        canStop: canStop && isActiveState(segment.state),
        failureStage: failureStageOf(segment),
      })),
    }))
    // 排序键是**链尾段的启动时间**，不是最近活动（见 startedAtOf 的注释）。
    // 并列时用 chain id 兜底：同一毫秒启动的两张卡不能每秒互相换位。
    .sort((a, b) => startedAtOf(b) - startedAtOf(a) || String(b.lineageRoot).localeCompare(String(a.lineageRoot)))
}

/** 活跃 run 数（不是链数：一条链里同时可能有多段在跑） */
export function activeCount(state) {
  let count = 0
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage.segments) if (isActiveState(segment.state)) count += 1
  }
  return count
}
