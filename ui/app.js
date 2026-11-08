/*
 * 子代理面板。
 *
 * 观测 + 两件事：插话（对某个 run 发一次 steer）、停止一个 run。
 *
 * 版式按 `docs/proto-mailbox-ui.html` 的 **A 方案**落地（用户验收过的那一版）：
 *   - 卡面只留「标题 · 状态 · 计时 / 身份 / 摘要 / 元信息 / 操作」，代际链折成一行。
 *   - 插话入口在卡片上，点了就地展开，**同一个按钮再点一次收起**（测试报告 P2）。
 *   - 停止不占输入区：按钮就地变「确认停止？」，3 秒不点自动退回。
 *   - 没有常驻输入坞、没有结果横幅——它们会顶得内容往下跳（U4）。
 *
 * 渲染策略（「位置突变」的总根源）：
 *   1. **秒级字段不进 HTML**：卡片里只放空的 `<span data-timing>`，诊断区的心跳
 *      只放空的 `<dd data-heartbeat>`，插入 DOM 后由 `uiPulse` 用 textContent 填。
 *      否则每秒算出的 HTML 都不同，整块 `innerHTML` 每秒重建一次——选区、焦点、
 *      动画全丢，点击落在被替换的节点上也不会触发 click。
 *   2. **分区 patch + 卡片按 runId 增量**：骨架只建一次，之后只动内容真变了的区块。
 *   3. **编辑插话时暂停重绘**：用户正在打字的那几秒，画面不该动；提交/取消后再同步。
 *   4. **拉数据与 UI 心跳分开**：拉取按活跃度 1s/3s/5s，隐藏时停；计时仍每秒走。
 *
 * 卡片标题来自子代理会话名（`steps[0].sessionName`）：顶层 `subagent()` 没有 name
 * 参数，同角色并发时只有这个名字能把两张卡分开、也才知道该对谁插话（报告 P1）。
 */

const bridge = window.pi || {
  invoke: () => Promise.reject(new Error('插件桥未加载')),
  on: () => () => {},
  context: {},
}

const el = document.getElementById('app')

/** 面板上下文里的会话路径：宿主会在切换会话时推新的 */
let context = bridge.context || {}
/** 最后一次成功拿到的状态 */
let snapshot = null
/** 最后一次失败原因（invoke 抛错 / 桥超时） */
let lastError = ''
/**
 * 第一次失败的时刻。错误横幅**不是**「一失败就宣布」。
 *
 * 切到别的面板时，宿主会把这个面板上挂着的调用 reject 掉——正好在 iframe 被摘掉前
 * 一帧画出「面板读取失败」，用户看到的就是一次莫名的红字闪屏，还会以为插件坏了。
 * 等一小会儿再宣布：这期间恢复就什么也不发生（用户根本不该知道有过一次瞬时失败）；
 * 真坏了，这点延迟也感觉不到。
 */
let errorSince = 0
const ERROR_SHOW_DELAY_MS = 400
/** 请求在飞的时候又要求刷新（切会话）→ 这次结果回来后立刻再问一次，别丢掉 */
let tickQueued = false
/* 诊断用的三个数：拉了几次、最后一次成功/失败是什么时候。
 * 「面板不更新」有两种完全不同的原因——没去拉，或者拉了但没数据；分开记才分得清。 */
let tickOkAt = 0
let tickFailAt = 0
/**
 * 手上这份数据的版本戳（main 给的 `rev`）。长轮询带回去：一样就说明「自上次以来
 * 什么都没变」，main 会把请求挂住等变化；不一样就立刻返回。
 *
 * 切会话必须清空——旧会话的版本戳对新会话毫无意义，带着它过去会让新会话白等 6 秒。
 */
let lastRev = ''
/** @type {number[]} */
const tickStamps = []
/**
 * 桥的 context 是 hello 之后 postMessage 推过来的，界面起来的那一刻还是空对象。
 * 这时候就发 getState，拿到的是「没有打开会话」——一句假话，还会让用户看见
 * 「先弹横幅再变卡片」。所以先等上下文，1.5s 兜底（真的没开会话时也得给结果）。
 */
let awaitingContext = !String(bridge.context?.sessionFile || '').trim()
/** @type {any} */
let contextFallback = null
/** 用户展开的代际链（按 lineageRoot 记），重绘后恢复 */
const genOpen = new Set()
/** 诊断折叠区的展开状态：整块重绘会把它拍回去，必须自己记 */
let diagOpen = false
/**
 * 滚动位置，按「内容归属的会话」记（`state.ownerSessionKey`）。
 *
 * 打开子会话后面板上下文变了，但内容还是父会话那条链（只读预览）——同一份内容
 * 不该被拍回顶部。归属没变就不动滚动位置，变了才换回该会话上次停的地方。
 * @type {Map<string, number>}
 */
const scrollMemo = new Map()
/** 当前 DOM 里的内容属于哪个会话（ownerSessionKey）；空 = 还没画过 */
let scrollOwner = ''
el.addEventListener(
  'scroll',
  () => {
    if (scrollOwner) scrollMemo.set(scrollOwner, el.scrollTop)
  },
  { passive: true },
)
/** 编辑插话时默认不重绘；改表单自身状态（展开/发送中）时放行一次 */
let paintOnce = false

/** 正在编辑的插话：`{ runId, agent, mode, text, busy, error }` */
let noteDraft = /** @type {any} */ (null)
/** 停止的二次确认：`{ runId, until }`，3 秒不点自动回退 */
let stopConfirm = /** @type {any} */ (null)
/** 顶部浮层提示（fixed 定位，不占文档流，所以不会顶内容） */
let notice = /** @type {{ text: string, tone: string, at: number, key: string } | null} */ (null)
/** 本会话发出去、还在等回执的投递：`[{ id, runId, kind, at }]` */
const sentNotes = []

const NOTICE_MS = { ok: 3_000, warn: 8_000, error: 8_000, info: 4_000 }
/**
 * 同一件事的重复提示在 8 秒内只出现一次（P8）。
 * 场景：用户连点三下「打开」，三下都失败——三条一样的提示叠在一起没有信息量。
 */
const NOTICE_DEDUPE_MS = 8_000
/**
 * 发出多久还没回执，就从「投递中」改口成「未确认」。
 * 6 秒的口径：worker 500ms 轮询 + 扩展内部最多 3s ack 等待 + RPC 往返。
 */
const RECEIPT_PATIENCE_MS = 6_000
/** 回执 chip 的保鲜期：再久就只是历史，留在卡上会让人以为刚刚才发生 */
const RECEIPT_VISIBLE_MS = 5 * 60_000

/**
 * @param {string} text
 * @param {string} [tone]
 * @param {string} [key] 去重键；同键 8 秒内只提示一次
 */
function setNotice(text, tone = 'info', key = '') {
  const now = Date.now()
  if (key && notice && notice.key === key && now - notice.at < NOTICE_DEDUPE_MS) return
  notice = { text, tone, at: now, key }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** 一句话截到 n 个字：卡面放不下整段，全文一律进 title（别让信息消失，只是别铺开） */
function truncate(value, n) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > n ? `${text.slice(0, n)}…` : text
}

/* ---------- 角色图标 ---------- */

/**
 * 图标几何数据（lucide 0.469，ISC 许可）。只留 path 本身：外壳由 `svgIcon` 统一套，
 * 这样 stroke 粗细、线帽、尺寸全在一处，不会出现某个图标比别的粗一档。
 * 取的是宿主自己也在用的那套图标库（插件 `plugin.json` 的 icon 就是 lucide 名），
 * 面板和宿主放在一起才对得上。
 */
const ICON_PATHS = {
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  hammer: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  'mouse-pointer-2': '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  binoculars: '<path d="M10 10h4"/><path d="M19 7V4a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3"/><path d="M20 21a2 2 0 0 0 2-2v-3.851c0-1.39-2-2.962-2-4.829V8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v11a2 2 0 0 0 2 2z"/><path d="M 22 16 L 2 16"/><path d="M4 21a2 2 0 0 1-2-2v-3.851c0-1.39 2-2.962 2-4.829V8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2z"/><path d="M9 7V4a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v3"/>',
  microscope: '<path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  compass: '<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>',
  'badge-check': '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
}

/**
 * 角色名 → 图标 + 语义族。
 *
 * 三个族不是为了好看，对应 pi-subagents 里**真实的能力差别**（agents/*.md 的
 * `acceptanceRole`）：`act` 能写文件（writer），`read` 只读（read-only），
 * `orch` 自己不干活、只派活（workflow / delegate）。颜色是这层差别的可视化——
 * 看一眼橙锤子就知道这张卡动过代码，青盾牌只是评审。
 *
 * 为什么硬编码而不去读 agent 定义文件：RPC 投影只给名字，不给 acceptanceRole；
 * 而「名字背后是什么」只在内置角色上稳定（用户自定义角色名字是随手起的）。
 * 猜错比不猜更糟——把只读角色认成 writer 会让人以为它能改文件。认不出就落
 * `AGENT_FALLBACK`：灰人像，明确表示「这是个角色，但它不是我认识的」。
 *
 * 别名照抄 frontmatter 的 `aliases`（worker: developer/coder/implementer/develop，
 * oracle: advisor）；读写变体共用同一个图标，因为 frontmatter 里它们本来就是一回事。
 */
const AGENT_LOOK = {
  // 编排：只派活，不碰文件
  workflow: { icon: 'workflow', tone: 'orch' },
  delegate: { icon: 'send', tone: 'orch' },
  // 能写：frontmatter 标了 acceptanceRole: writer
  worker: { icon: 'hammer', tone: 'act' },
  developer: { icon: 'hammer', tone: 'act' },
  coder: { icon: 'hammer', tone: 'act' },
  implementer: { icon: 'hammer', tone: 'act' },
  develop: { icon: 'hammer', tone: 'act' },
  'claude-code-writer': { icon: 'sparkles', tone: 'act' },
  'codex-exec-writer': { icon: 'terminal', tone: 'act' },
  'cursor-agent-writer': { icon: 'mouse-pointer-2', tone: 'act' },
  // 只读：侦察 / 研究 / 评审 / 决策
  scout: { icon: 'binoculars', tone: 'read' },
  researcher: { icon: 'microscope', tone: 'read' },
  reviewer: { icon: 'shield-check', tone: 'read' },
  oracle: { icon: 'compass', tone: 'read' },
  advisor: { icon: 'compass', tone: 'read' },
  'evidence-auditor': { icon: 'badge-check', tone: 'read' },
  'claude-code': { icon: 'sparkles', tone: 'read' },
  'codex-exec': { icon: 'terminal', tone: 'read' },
  'cursor-agent': { icon: 'mouse-pointer-2', tone: 'read' },
  'general-purpose': { icon: 'bot', tone: 'read' },
}
/**
 * 兜底：人像。跟 `general-purpose` 的机器人分开——「我认识这个角色，它是通用
 * 子代理」和「这名字我不认识」是两件事，用同一个图标就说不清了。
 * 不用问号圈：24 格的圆圈在 19px 里几乎撑满，比其它图标重一档，一排看过去就它扎眼。
 */
const AGENT_FALLBACK = { icon: 'user-round', tone: 'unknown' }

/** 名字归一：大小写、空格、下划线不该让同一角色落到兜底上 */
function lookOf(agent) {
  const key = String(agent ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
  return AGENT_LOOK[key] || AGENT_FALLBACK
}

/** 套统一外壳：粗细/线帽/尺寸一处定，新增图标只补 path */
function svgIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    ICON_PATHS[name] || ICON_PATHS.bot
  }</svg>`
}

/**
 * 角色徽章。
 *
 * 只回答「这是谁」：一个按族上色的图标。状态不再挂在徽章上——0.7.7–0.8.0 在它
 * 外面画过环（绿=跑着、琥珀=等人），但 19px 方块外的描边不管多淡都会被读成「框」，
 * 而且和卡片自己的边框叠在一起像是套了两层。现在状态全交给右边那行带底色的
 * label（见 style.css 的 .state），徽章回到干净的一个符号。
 */
const TONE_TIP = { act: '会改动文件', read: '只读', orch: '编排，自己不干活', unknown: '自定义角色' }

function agentBadge(agent) {
  const name = String(agent ?? '').trim()
  const look = lookOf(name)
  const tip = name ? `${name} · ${TONE_TIP[look.tone] || ''}` : '子代理'
  return `<span class="ico tone-${look.tone}" title="${esc(tip)}">${svgIcon(look.icon)}</span>`
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtAge(ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000))
  if (sec < 60) return `${sec}s 前`
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`
  return `${Math.floor(sec / 3600)}h 前`
}

/** 「已等」用中文口径：盯着一个卡等的时候，「3 分」比「180s」更像人话 */
function fmtWait(ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000))
  if (sec < 60) return `${sec} 秒`
  const minutes = Math.floor(sec / 60)
  if (minutes < 60) return `${minutes} 分`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/**
 * 「需要关注」的卡上带一句时长，但两种关注说的不是一件事：
 *
 *   - 等待回答 → 「已等 3 分」。状态只说明「在等」，不说明「等了多久」，而这两件事
 *     决定要不要管它：等 20 秒是正常，等 8 分钟大概率父会话那边没人接。起点是控制
 *     事件自己的 `ts`（真值），老数据才退回 `attentionSince`。
 *   - 无响应 → 「已 3 分无活动」。这个数**必须**用 `lastActivityAt`（磁盘上的真实最后
 *     活动），不能用我们开始观察的时刻：插件重启、切面板都不会让它变新或变旧。
 */
function attentionText(segment, now) {
  const state = stateOf(segment)
  if (state === 'stalled') {
    const last = Number(segment?.lastActivityAt) || Number(segment?.attentionSince) || 0
    return last ? `已 ${fmtWait(now - last)}无活动` : ''
  }
  if (state !== 'waiting') return ''
  const since = Number(segment?.attentionAt) || Number(segment?.attentionSince) || 0
  return since ? `已等 ${fmtWait(now - since)}` : ''
}

function fmtClock(at) {
  const d = new Date(Number(at) || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 18.4k 这种口径：卡片上没地方写 18432 */
function fmtTokens(total) {
  const n = Number(total) || 0
  if (!n) return ''
  if (n < 1_000) return `${n} tok`
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k tok`
  return `${Math.round(n / 1_000)}k tok`
}

/** run id 前 8 位：插话 / 停止都要认这个 id，只写角色名对不上号（P1） */
function shortId(runId) {
  const id = String(runId || '')
  return id.length > 8 ? id.slice(0, 8) : id
}

const STATE_TEXT = {
  running: '运行中',
  complete: '已完成',
  failed: '失败',
  error: '出错',
  stopped: '已停止',
  stopping: '正在停止',
  partial: '部分完成',
  timeout: '超时',
  cancelled: '已取消',
  queued: '排队中',
  pending: '等待中',
  waiting: '等待回答',
  stalled: '无响应',
  launch: '未启动',
  lost: '已中断',
  paused: '已暂停',
  rejected: '被拒绝',
  unknown: '状态未知',
}

const ACTIVE_STATES = new Set(['running', 'queued'])

/**
 * 「它需要你关注」——`activityState` 的取值（报告 P10）。
 *
 * 这时候 `state` / `status` 都还是 `running`，面板原来照着渲染就成了「运行中」，
 * 用户看着一张永远跑不完的卡。真正区分跑着与等人的只有这一项。
 */
const WAITING_ACTIVITY = 'needs_attention'

/**
 * 但 `needs_attention` 有**三种**语义，卡面必须分开（报告 P19）：
 *
 *   - `supervisor_request`：它调了 contact_supervisor，在等你回答 → **等待回答**（橙实底，
 *     全场唯一「你必须做点什么」的状态，配问题原文）；
 *   - `idle`：60 秒没有任何活动。可能只是长思考，也可能是上游请求悬住了 → **无响应**
 *     （淡橙空心 + 已 N 分无活动）。这类 run 若还没有超时保护，就是等多久都不会自己结束；
 *   - 另有一档 `active_long_running`（`type` 字段，不是 `reason`）：还在跑，只是慢 →
 *     仍然是「运行中」，只加一句弱说明，别当故障。
 *
 * 读不到控制事件时退回「等待回答」并在 tooltip 里说明——猜错成「无响应」会让用户去
 * 停一个正在思考的 run，比不给结论更糟。
 */
const ASK_REASON = 'supervisor_request'
const IDLE_REASON = 'idle'

/**
 * 卡片上真正要显示的状态：把 `activityState` / `failureStage` 折进 `state`。
 *
 * 只在还活跃时折 `activityState`——终态段偶尔留着上一次的 `needs_attention`，不能让
 * 它把「已完成」说成「等你回答」。
 * @param {any} segment
 */
function stateOf(segment) {
  const raw = String(segment?.state || 'unknown')
  if (ACTIVE_STATES.has(raw) && String(segment?.activityState || '') === WAITING_ACTIVITY) {
    return String(segment?.attentionReason || '') === IDLE_REASON ? 'stalled' : 'waiting'
  }
  // 编排层就崩了、一个子代理都没被创建出来：这跟「跑了 6 秒超时」不是一回事，
  // 不能都写「失败」。判定在 main 侧算好（lib/lineage.mjs 的 failureStageOf），
  // 这里只读字段——UI 里没有 steps 数据，自己算不准。
  if (String(segment?.failureStage || '') === 'launch') return 'launch'
  return raw
}

/**
 * 点 / 文字的颜色跟着状态走：卡片上不再挂胶囊标签（原型 A 的做法）。
 *
 * 没有「排队」这一档：pi-subagents 的队列态就是 `queued`，它本来就算活跃（等槽位），
 * 所以落到 `live`。曾经给它留过一个橙色 `warn` 分支，但被上面这行先吃掉，从来没
 * 亮过——留着只会误导下一个改这里的人，删掉。
 *
 * `waiting` 是**唯一**能拿到橙色的状态，而且它值得：那张卡不是在跑，是在等你。
 */
function stateClass(state) {
  const key = String(state || 'unknown')
  if (key === 'waiting') return 'waiting'
  // 「无响应」用同一族的橙，但做成**空心**：它说的是「可能卡住了」，不是「我在等你」。
  // 实心的橙在面板上等于「必须处理」，而 idle 有一半是长思考，天天亮就该被无视了。
  if (key === 'stalled') return 'stalled'
  if (ACTIVE_STATES.has(key)) return 'live'
  if (key === 'launch') return 'launch'
  if (key === 'failed' || key === 'error' || key === 'timeout' || key === 'rejected') return 'bad'
  // 「已中断」是插件判出来的终态（进程没了，status 却停在 running）。它跟失败不一样：
  // 没人写过错，是应用重启把进程带走了。用灰而不是红，免得看成「任务做错了」。
  if (key === 'lost') return 'lost'
  if (key === 'stopping') return 'stopping'
  return 'done'
}

function stateText(state) {
  const key = String(state || 'unknown')
  return STATE_TEXT[key] || key
}

/**
 * 会话名 → 卡片标题。
 * `"worker: 你是测试用子代理 A。工作目录: C:/…"` → `"你是测试用子代理 A"`
 *
 * 三件事（都来自实测报告）：
 *   1. 去掉冒号前的角色名、`工作目录:` 之后是噪音、句末标点。
 *   2. **`【…】` 优先**：任务首行常写成「【名字】说明」，而上游把 sessionName 截到
 *      ~48 字符——方括号里的名字通常完整，路径却常把句尾啃掉（报告 P1′）。
 *   3. **复活提示语不是标题**：resume 出来的 run 的 sessionName 是
 *      `worker: You are reviving a previous subagent conversation. Origin…`，
 *      直接显示就是一团模板废话（报告 P1″）——返回空串，让上层回退到原 run 的标题。
 */
const REVIVE_NOISE = /reviving a previous subagent conversation/i

function taskTitle(sessionName) {
  let text = String(sessionName || '').trim()
  if (!text || REVIVE_NOISE.test(text)) return ''
  text = text.replace(/^[\w.\-]{1,32}\s*[:：]\s*/, '')
  text = text.split(/工作目录\s*[:：]/)[0]
  text = text.replace(/\s+/g, ' ').trim().replace(/[\s.。．；;,，·]+$/, '')
  if (!text) return ''
  // 方括号段提到最前：`写个脚本【名字】…` 这种把名字写在中间的首行也不会被截掉
  const tagged = /【[^】]{1,40}】/.exec(text)
  if (tagged) {
    const rest = text.replace(tagged[0], '').replace(/^[\s:：·\-—,，]+/, '').trim()
    text = rest ? `${tagged[0]} ${rest}` : tagged[0]
  }
  return text.length > 42 ? `${text.slice(0, 42)}…` : text
}

/**
 * 链的标题：从链尾往前找第一个说得出的名字。
 *
 * 一条链的每一段都是同一个人，所以上一段的名字对下一段有效——这是 resume 段
 * （sessionName 是复活提示语）唯一的兜底来源。
 *
 * 优先级（报告 P6）：`label`（workflow 给这一步起的名字）> sessionName > 子代理的 name。
 * 都没有才退回 `角色 · runId8`——**别只写角色名**：workflow 的父 run 角色就叫
 * `workflow`，只写它等于没写；mode（single/workflow）永远不作标题。
 */
function titleOf(lineage, segment) {
  const segments = lineage.segments || []
  // 容器没有自己的名字：`label` 属于第一步、`sessionName` 是子代理的任务首句。
  // 父子卡并排时用哪个都会撞名，直接给「角色 · 尾号」。
  if ((segment?.containerOf || []).length) {
    return `${String(lineage.agent || segment?.agent || '子代理')} · ${shortId(segment?.runId)}`
  }
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const label = String(segments[index]?.label || '').trim()
    if (label) return taskTitle(label) || label
    const own = taskTitle(segments[index]?.sessionName)
    if (own) return own
    const child = (segments[index]?.children || []).map((item) => taskTitle(item?.sessionName)).find(Boolean)
    if (child) return child
  }
  // 还在跑、但整条链都还没有名字：宁可说「启动中」，也不要把 `delegate · abc12345`
  // 摆上去。那个字符串读起来像「这张卡就叫这个名字」，而它最多存在到子进程写完
  // status.json（上游把 async-started 的 task 字段 redact 了，任务名只能等文件），
  // 于是用户眼里就是「标题闪成角色名和 id」。要等就等，别用一个假名字占位。
  if (segment?.state === 'running' || segment?.state === 'stopping') return '启动中'
  const agent = String(lineage.agent || segment?.agent || '子代理')
  const id = shortId(segment?.runId)
  return id ? `${agent} · ${id}` : agent
}

/** 段的时间信息：进行中看「从现在倒推」，终态看耗时 */
function timingOf(segment, now) {
  if (segment.durationMs) return fmtDuration(segment.durationMs)
  const start = Number(segment.startedAt) || 0
  const end = Number(segment.endedAt) || (segment.state === 'running' ? now : 0)
  if (!start || !end) return ''
  return fmtDuration(end - start)
}

/**
 * 计时器上的悬停说明：**卡片只显示时长，看不出谁更晚**。
 *
 * 排序按最后活动时间倒序，可卡面上那个 `0:44`（时长）和 `1:05` 谁更新完全看不出来，
 * 于是任何一次顺序不合直觉都会被当成「排序坏了」。补上绝对钟点，用户一悬停就能核对。
 */
function timingTitle(segment) {
  const start = Number(segment.startedAt) || 0
  if (!start) return ''
  const end = Number(segment.endedAt) || 0
  return end ? `开始 ${fmtClock(start)} · 结束 ${fmtClock(end)}` : `开始 ${fmtClock(start)} · 仍在运行`
}

/** 一段已经跑完的时长（不随现在变，所以能直接写进 HTML） */
function pastTiming(segment) {
  const duration = Number(segment?.durationMs)
  if (Number.isFinite(duration) && duration > 0) return fmtDuration(duration)
  const start = Number(segment?.startedAt) || 0
  const end = Number(segment?.endedAt) || 0
  return start && end ? fmtDuration(end - start) : ''
}

/**
 * 计时器的悬停说明，链上补一句「上次完成」。
 *
 * 卡面那个 `0:05` 是**本次**的时长——resume 之后它从 1:04 变成 0:03，不解释一句
 * 就像数据丢了。悬停里给出上一段的收尾时刻与耗时，用户自己就能对上。
 */
function timingTitleOf(segment) {
  const base = timingTitle(segment)
  const lineage = findLineageOf(segment?.runId)
  const segments = lineage?.segments || []
  if (segments.length < 2) return base
  const index = segments.findIndex((item) => String(item.runId) === String(segment.runId))
  const prev = index > 0 ? segments[index - 1] : null
  const ended = Number(prev?.endedAt) || 0
  if (!prev || !ended) return base
  const duration = pastTiming(prev)
  return [base, `上次 ${fmtClock(ended)} 完成${duration ? `（${duration}）` : ''}`].filter(Boolean).join(' · ')
}

/**
 * 计时占位：**内容留空**，插入 DOM 后由 `tickTimings` 用 textContent 填。
 * 这样 `lastHtml` 不含随时间变化的东西，结构没变就永远不重绘。
 */
function timingSpan(segment) {
  return `<span class="timer" data-timing="${esc(segment.runId)}"></span>`
}

function findSegment(runId) {
  for (const lineage of snapshot?.lineages || []) {
    for (const segment of lineage.segments || []) {
      if (String(segment.runId) === String(runId)) return segment
    }
  }
  return null
}

/** 某个 run 所在的链。卡片上的「续跑中」「上次完成」都要看整条链，不能只看这一段 */
function findLineageOf(runId) {
  for (const lineage of snapshot?.lineages || []) {
    for (const segment of lineage.segments || []) {
      if (String(segment.runId) === String(runId)) return lineage
    }
  }
  return null
}

/**
 * 状态词。带语境：一条链上有多段、且链尾还在跑 → 「续跑中」。
 *
 * 只在多段链上这么说。「运行中」对第一段是对的，但 resume 之后用户心里的问题是
 * 「它是在重跑吗」——「续跑中」当场回答了；单段卡上没有「续」可谈，不该改口。
 */
function stateLabelOf(segment) {
  const state = stateOf(segment)
  const lineage = findLineageOf(segment?.runId)
  const segments = lineage?.segments || []
  // 「续跑中」只描述「这条链又在跑」这一件事。等回答 / 无响应是在描述**现在发生了什么**，
  // 优先级更高——不然一张卡写着「续跑中」却停在那儿半小时，看着像在动。
  if (
    segments.length > 1 &&
    ACTIVE_STATES.has(String(segment?.state || '')) &&
    state !== 'waiting' &&
    state !== 'stalled'
  ) {
    return '续跑中'
  }
  return stateText(state)
}

/** 「它正在跑什么」：status 独有字段，卡片上显示成 `bash 2.3s` */
function toolText(segment, now) {
  const child = (segment.children || []).find((item) => item.currentTool)
  if (!child) return ''
  const started = Number(child.currentToolStartedAt) || 0
  const age = started ? fmtDuration(now - started) : ''
  return age ? `${child.currentTool} ${age}` : String(child.currentTool)
}

/**
 * 完成态闸门（P2′ 的应修点 2）。
 *
 * 竞态是这么发生的：按钮点开时 run 还在跑，用户打字的十几秒里它结束了，
 * 提交就撞进终态——扩展会拒，回执还会说得很晚。数据层的 `canSteer` 只决定
 * 「按钮出不出现」，管不到这段已经在打的草稿。
 *
 * 所以这里每秒核对一次：段一旦不是活跃态，就地说明并禁用发送，**草稿留在框里**
 * （用户可能想复制去 resume）。只改文本和 disabled，不动结构——textarea 的焦点
 * 不能丢，否则等于把人正在写的字打断。
 */
function updateDraftGate() {
  if (!noteDraft) return
  const segment = findSegment(noteDraft.runId)
  const active = Boolean(segment) && ACTIVE_STATES.has(String(segment.state))
  const gate = el.querySelector('[data-draft-gate]')
  if (gate) {
    const text = active ? '' : '它已经结束了，这一条发不出去（草稿留着，可以复制走）'
    if (gate.textContent !== text) gate.textContent = text
    gate.hidden = !text
  }
  const send = /** @type {HTMLButtonElement | null} */ (el.querySelector('[data-note-send]'))
  if (send) {
    const disabled = Boolean(noteDraft.busy) || !active
    if (send.disabled !== disabled) send.disabled = disabled
    const label = noteDraft.busy ? '发送中…' : active ? '发送' : '已结束'
    if (send.textContent !== label) send.textContent = label
  }
}

/** 每秒只改这几个数字和标签，不动结构 */
function tickTimings() {
  const now = Date.now()
  for (const node of el.querySelectorAll('[data-timing]')) {
    const segment = findSegment(node.getAttribute('data-timing'))
    const next = segment ? timingOf(segment, now) : ''
    if (node.textContent !== next) node.textContent = next
    const tip = segment ? timingTitleOf(segment) : ''
    if (node.title !== tip) node.title = tip
  }
  // 「已等 3 分 / 已 2 分无活动」每秒往前走：它只改文本，结构不变，打字时也不会动
  for (const node of el.querySelectorAll('[data-wait]')) {
    const segment = findSegment(node.getAttribute('data-wait'))
    const next = segment ? attentionText(segment, now) : ''
    if (node.textContent !== next) node.textContent = next
  }
  for (const node of el.querySelectorAll('[data-tool]')) {
    const segment = findSegment(node.getAttribute('data-tool'))
    const next = segment ? toolText(segment, now) : ''
    if (node.textContent !== next) node.textContent = next
    // 空的时候整块收掉：否则 flex gap 会留一个空档
    node.style.display = next ? '' : 'none'
  }
  // 状态文字：结构不变，只换字和类。打字期间 run 结束时尤其重要——不重建 DOM
  // （保焦点），但卡面不能还挂着「运行中」骗人。状态全在这一个 label 上：底色、
  // 呼吸动画都由 class 决定，所以这里的比对是「卡面是否已经说了真话」的唯一保障
  for (const node of el.querySelectorAll('[data-state]')) {
    const segment = findSegment(node.getAttribute('data-state'))
    const state = stateOf(segment)
    const text = stateLabelOf(segment)
    if (node.textContent !== text) node.textContent = text
    const cls = `state ${stateClass(state)}`
    if (node.className !== cls) node.className = cls
    // 卡片的绿边 / 琥珀边也是 class 决定的：字换了边没换，就成了「已完成的卡还亮着」。
    // 只拨这两个 class，container / step / viewing 一律不碰（它们只由结构决定）。
    const card = node.closest('.card')
    if (card) {
      const live = ACTIVE_STATES.has(String(segment?.state || '')) && state !== 'waiting' && state !== 'stalled'
      if (card.classList.contains('live') !== live) card.classList.toggle('live', live)
      const waiting = state === 'waiting'
      if (card.classList.contains('waiting') !== waiting) card.classList.toggle('waiting', waiting)
      const stalled = state === 'stalled'
      if (card.classList.contains('stalled') !== stalled) card.classList.toggle('stalled', stalled)
    }
  }
  updateDraftGate()
}

/* ---------- 插话（A 方案：卡片内联） ---------- */

/** 这个 run 上最近一条投递回执：先看 agent 写的，再看本地「已发出待确认」 */
function mailFor(runId) {
  const id = String(runId ?? '')
  if (!id) return null
  const confirmed = (snapshot?.mail || []).find((item) => String(item.runId) === id)
  if (confirmed && Date.now() - Number(confirmed.at || 0) < RECEIPT_VISIBLE_MS) return { confirmed: true, ...confirmed }
  const pending = sentNotes.filter((item) => item.runId === id).sort((a, b) => b.at - a.at)[0]
  if (pending && Date.now() - pending.at < RECEIPT_VISIBLE_MS) return { confirmed: false, ...pending }
  return null
}

/** 回执 chip 的图标：颜色已经说明了语气，图标只是让它在小字里也有形状 */
const CHIP_ICON = { read: '✓', bad: '✕', warn: '!', sent: '↑', muted: '·' }

/**
 * 「停止」撞上「它刚好自己结束了」的几种说法。
 *
 * 扩展的原话是 `Async run … is complete; stop only supports running or queued async
 * runs, or a paused whole run.`——用户点停止的 50 毫秒里 run 自己跑完了，目标其实
 * 已经达成。把它当失败挂一条红色横幅，会让人以为插件坏了；而它又是**永久的**
 * （回执在卡上挂 5 分钟），比不提示更糟。
 *
 * 只认「这个 run 已经结束」的说法。`not running` 太宽（也可能是「父会话进程不在」），
 * 那种是真失败，不能降级成一句「它自己结束了」。
 */
const STOP_BENIGN = /is (?:already )?complete|stop only supports running|already (?:complete|finished|stopped)|no longer running/i
/** 这类回执只是「回应了你的点击」，看一眼就该收掉 */
const BENIGN_MS = 8_000
/** 真·停止失败也留一会儿就收：它是一次性动作，不值得在卡上挂满 5 分钟 */
const STOP_FAIL_MS = 60_000

/**
 * 插话 / 停止的回执怎么说：只陈述扩展给的事实，不猜。
 * @param {any} mail
 * @param {any} segment
 */
function describeMail(mail, segment) {
  if (!mail) return null
  const kind = mail.kind === 'stop' ? 'stop' : 'note'
  if (!mail.confirmed) {
    const age = Date.now() - Number(mail.at || 0)
    if (age < RECEIPT_PATIENCE_MS) {
      return { text: kind === 'stop' ? '停止请求已发出…' : '正在投递…', tone: 'sent' }
    }
    return {
      text:
        kind === 'stop'
          ? '停止请求已发出，没等到确认（父会话进程可能不在）'
          : '已发出，没等到确认（父会话进程可能不在）',
      tone: 'warn',
    }
  }
  if (mail.state === 'expired') return { text: '这条没投出去：已经过期了', tone: 'warn' }
  if (!mail.ok) {
    // 竞态：点确认的瞬间它自己结束了。目标已达成，不算失败——
    // 挂成中性短提示，8 秒后自己消失（见 renderMailChip 的 ttl）。
    if (kind === 'stop' && STOP_BENIGN.test(String(mail.error || ''))) {
      return { text: '你点停止时它已经自己结束了', tone: 'muted', ttl: BENIGN_MS }
    }
    // 停止的失败不长挂：它是一次性动作，要么重试要么算了。5 分钟红字只会变成
    // 卡面上的一块遗言。插话不一样——那条真的没进去，得留着让人看见。
    return { text: mail.error || '这条没投进去', tone: 'bad', ttl: kind === 'stop' ? STOP_FAIL_MS : 0 }
  }
  if (kind === 'stop') return { text: `停止已受理 · ${fmtClock(mail.at)}`, tone: 'read' }
  if (mail.state === 'delivered') return { text: `已插进它这一轮 · ${fmtClock(mail.at)}`, tone: 'read' }
  // 停在 queued：扩展受理了，但还没走到回合边界。它要是先结束了，这条就永远进不去——
  // 别让卡片一直说「等它这一步结束」，那是在骗人（P2′）
  if (segment && !ACTIVE_STATES.has(String(segment.state))) {
    return { text: '已受理，但它先结束了 · 这条可能没进去', tone: 'warn' }
  }
  return { text: `已受理，它这一步做完才插进去 · ${fmtClock(mail.at)}`, tone: 'sent' }
}

function renderMailChip(segment) {
  const mail = mailFor(segment.runId)
  const described = describeMail(mail, segment)
  if (!described) return ''
  // ttl 到点就收掉。轮询在 run 结束后是 5s 一轮，实际最迟十几秒内消失；
  // 不用另开定时器——卡片本来就在重绘。
  if (described.ttl && Date.now() - Number(mail?.at || 0) > described.ttl) return ''
  return `<div class="chip chip-${esc(described.tone)}"><span class="chip-ico">${CHIP_ICON[described.tone] || '·'}</span>${esc(
    described.text,
  )}</div>`
}

/**
 * 插话表单。**只在编辑这一个 run 时出现**，提交即收起。
 * 编辑期间 render 会整体跳过（见 render 开头），所以这里的 textarea 不会被重建。
 */
function renderNoteForm(segment) {
  if (!noteDraft || String(noteDraft.runId) !== String(segment.runId)) return ''
  const busyAttr = noteDraft.busy ? ' disabled' : ''
  return `<div class="inline">
    <div class="hint">直接插进 <b>${esc(noteDraft.agent || '这个子代理')}</b> 当前这一轮 · Enter 发送 · Shift+Enter 换行 · Esc 收起</div>
    <p class="gate" data-draft-gate hidden></p>
    <textarea data-note-input rows="3" placeholder="例如：先别改测试，把 JSON 输出的字段名定下来"${busyAttr}>${esc(noteDraft.text)}</textarea>
    <div class="compose-acts">
      <button data-note-cancel${busyAttr}>取消</button>
      <button class="send" data-note-send${busyAttr}>${noteDraft.busy ? '发送中…' : '发送'}</button>
    </div>
    ${noteDraft.error ? `<p class="form-error">${esc(noteDraft.error)}</p>` : ''}
  </div>`
}

/**
 * 干预入口。**只在 canSteer / canStop 为真时出现**——这两个字段是数据层算的，
 * 前台 run（没有 async id）和已终态段不会出现按钮，用户不会先点再被报错。
 */
function renderActs(segment) {
  const runId = esc(segment.runId)
  const acts = []
  // 「已中断」是插件判出来的：这条 run 的进程已经没了，没有谁在跑它。
  // 这里必须把话说明白——否则用户会以为还能停止/插话，点下去毫无反应。
  if (stateOf(segment) === 'lost') {
    acts.push('<span class="hint">运行进程已结束 · 这次不会再有输出</span>')
  }
  if (segment.canSteer) {
    const open = noteDraft && String(noteDraft.runId) === String(segment.runId)
    // 「无响应」时先说清楚：这一条会排队，可能根本不会被读（实测挂死期 steer
    // requested=1 delivered=0，stop 之后才报「child completed before consuming」）。
    const tip = open
      ? '再点一次收起'
      : stateOf(segment) === 'stalled'
        ? '它当前没有响应，这条会排队，可能不被消费'
        : '给它当前这一轮插一句话'
    acts.push(
      `<button class="primary${open ? ' on' : ''}" data-note="${runId}" aria-expanded="${open ? 'true' : 'false'}" title="${esc(
        tip,
      )}">插话</button>`,
    )
  }
  // 「打开」指向哪份会话、能不能点，由 main 判定（P8）：顶层 childSessionFile 常常
  // 指向一个不存在的路径，真实的那份在 status.json 的 steps 里。UI 不猜路径。
  //
  // 正在看的那张卡把按钮换成「返回」（main 标 viewing）：点「打开」等于再打开自己，
  // 没有反馈；换成返回，卡上还多一圈高亮——「我现在在看谁」这个问题当场就有答案。
  if (segment.viewing && segment.viewBackTo) {
    acts.push(
      `<button class="primary on" data-open-session="${esc(
        segment.viewBackTo,
      )}" title="你现在看的就是它的会话，点这里回主会话">返回</button>`,
    )
  } else if (segment.openState === 'ok' && segment.openTarget) {
    // 链内共用（resume 复用同一份 session.jsonl）：入口是**链级**的，title 要说清
    // 「打开的是整条链」，否则用户会以为点开只看到这一次。
    const runs = (findLineageOf(segment.runId)?.segments || []).length
    const tip = `${segment.openShared && runs > 1 ? `这 ${runs} 次运行共用一份会话，` : ''}打开它的会话（只读预览）`
    acts.push(`<button data-open-session="${esc(segment.openTarget)}" title="${esc(tip)}">打开</button>`)
  } else if (segment.openState === 'missing') {
    acts.push(
      '<button disabled title="这段会话的文件已经不在磁盘上了（一次性 run 的目录会被清理）">打开</button>',
    )
  } else if (segment.openState === 'shared' && segment.openOwnerRunId) {
    // workflow 容器 run 自己没有会话（childSessionFile 是猜的，实测不存在），
    // 候选链落到它那一步的会话——那一步在列表里另有卡片，入口归它。
    // 这里不出按钮，只说明去处，免得两个「打开」通向同一份文件。
    // 已经有缩进子卡时就不用说了：入口就在下面，明摆着。
    // 0.9.9 起「链内共用」不再走这条分支（那是同一条链自己的会话），所以能到这里的
    // 只有真容器。措辞也别再叫「容器」——用户会以为这张卡是个装着别的卡的盒子。
    if (!(segment.containerOf || []).length) {
      acts.push(`<span class="hint">会话属于 ${esc(shortId(segment.openOwnerRunId))} 那一步</span>`)
    }
  }
  if (segment.canStop) {
    const confirming = stopConfirm && String(stopConfirm.runId) === String(segment.runId) && Date.now() < stopConfirm.until
    if (confirming) {
      acts.push(`<button class="confirm" data-stop-confirm="${runId}">确认停止？</button>`)
      acts.push(`<button data-stop-cancel>取消</button>`)
    } else {
      acts.push(`<button class="danger" data-stop="${runId}">停止</button>`)
    }
  }
  return acts.length ? `<div class="acts">${acts.join('')}</div>` : ''
}

/** 这张卡的角色名：链上的 agent 优先（链是跨段聚合的，比单段可靠） */
function agentOf(lineage, segment) {
  return String(lineage.agent || segment?.agent || '')
}

/** 身份行：角色名 · run id 尾号 · 回合数 · 步骤数 · 续跑来源。同角色并发时靠这一行分人 */
function renderIdent(lineage, segment, title) {
  const parts = []
  const agent = agentOf(lineage, segment)
  const steps = (segment.containerOf || []).length
  // 排队中的步骤也要算进来：它们没有 runId 但还是这趟编排里的步骤。只数已建卡的，
  // 会出现「写着 1 步，下面却列出 3 行」——那行字反而成了误导。
  const totalSteps = steps + (segment.pendingSteps || []).length
  // 容器卡的标题就是「角色 · 尾号」（它没有自己的名字），身份行再写一遍纯属重复
  if (!totalSteps) {
    if (agent && agent !== title) parts.push({ html: `<span class="who">${esc(agent)}</span>` })
    if (segment.runId) parts.push({ html: `<code>${esc(shortId(segment.runId))}</code>` })
  }
  if (totalSteps) {
    // 容器卡：子卡就在下面缩进着，这里只说「几步、跑完几步」——
    // 会话入口归子卡自己，容器不提供「打开」（见 renderActs）
    const done = Number(segment.containerDone) || 0
    parts.push({
      html: `<span class="steps">${
        done >= totalSteps ? `${totalSteps} 步` : `${totalSteps} 步 · ${done}/${totalSteps} 完成`
      }</span>`,
    })
  }
  const turns = Number(segment.activity?.turnCount)
  if (Number.isFinite(turns) && turns > 0) parts.push({ html: `${turns} 回合` })
  if (segment.revivedFrom) {
    // resume 的卡跟原卡同名，不给个标记就分不清「这是新的那次」。
    // 0.9.9 起写**次数**而不是某个 runId 尾号：`续 9ea2d148` 要用户自己去对是哪条，
    // 而「续 ×2」直接回答「这张卡被用了几次」。id 放 title 里，排查时仍然有。
    const root = String(segment.reviveRoot || segment.revivedFrom)
    const hops = Number(segment.reviveHops) || 1
    const tip = `这条链续过 ${hops} 次 · 最初 ${root} · 上一次 ${String(segment.revivedFrom)}`
    parts.push({ html: `<span class="revive" title="${esc(tip)}">↻ 续 ×${hops}</span>` })
  }
  if (!parts.length) return ''
  return `<div class="ident">${parts.map((part) => part.html).join('<span class="sep">·</span>')}</div>`
}

/**
 * 插话投递计数（报告 P2′ 的建议 3）：`steering.requested / delivered / failed`。
 *
 * 比那条 5 分钟就隐掉的 chip 更耐久：chip 说的是「刚才那条」，这里说的是「这个 run
 * 一共被插过几次、几次没投进」。数据来自 run 的 status.json（RPC status 不带）。
 */
function steeringText(steering) {
  if (!steering) return null
  const requested = Number(steering.requested) || 0
  if (!requested) return null
  const delivered = Number(steering.delivered) || 0
  const failed = Number(steering.failed) || 0
  const waiting = (Number(steering.pending) || 0) + (Number(steering.scheduled) || 0)
  const tip = `插话 ${requested} 次 · 送达 ${delivered} · 失败 ${failed} · 待投 ${waiting}`
  if (failed > 0) return { text: `插话 ${requested} · ${failed} 没投进`, bad: true, tip }
  if (waiting > 0) return { text: `插话 ${requested} · 待投 ${waiting}`, bad: false, tip }
  return { text: `插话 ${requested} 次`, bad: false, tip }
}

/**
 * 模型 / 思考档位：报告 P3 里「调用参数 > agent frontmatter > 全局默认」的分层，
 * 用户得能在卡上直接确认自己这层生效了。只显示，不解释。
 */
function modelText(segment) {
  const model = String(segment.model || '').trim()
  if (!model) return ''
  const thinking = String(segment.thinking || '').trim()
  // 模型名常常很长（`deepseek/deepseek-v4-pro`）：去掉 provider 前缀，留最后一段
  const short = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  return thinking ? `${short} · ${thinking}` : short
}

function renderMeta(segment) {
  const items = []
  const childCount = (segment.children || []).length
  // 容器卡不写「N 个子代理」：它的子代理就是下面缩进着的那几张卡，
  // 身份行已经有「N 步」，再报一次人数只是重复
  const container = (segment.containerOf || []).length > 0
  if (childCount > 1 && !container) items.push(`<span>${childCount} 个子代理</span>`)
  const model = modelText(segment)
  if (model) items.push(`<span class="model" title="${esc(String(segment.model || ''))}">${esc(model)}</span>`)
  // 「它正在跑什么」——占位留空，内容由 tickTimings 填，免得每秒重算 HTML
  if (segment.state === 'running' && (segment.children || []).some((child) => child.currentTool)) {
    items.push(`<span class="tool" data-tool="${esc(segment.runId)}"></span>`)
  }
  const steer = steeringText(segment.steering)
  if (steer) items.push(`<span class="${steer.bad ? 'bad' : ''}" title="${esc(steer.tip)}">${esc(steer.text)}</span>`)
  const tokens = fmtTokens(segment.tokens?.total)
  if (tokens) items.push(`<span>${esc(tokens)}</span>`)
  if (Number.isFinite(segment.costUsd) && segment.costUsd > 0) items.push(`<span>$${segment.costUsd.toFixed(3)}</span>`)
  if (!items.length) return ''
  return `<div class="meta">${items.join('')}</div>`
}

/** 摘要：终态读 summary，失败且没摘要时读 error（红的，别让人以为只是普通说明） */
function renderSummary(segment) {
  const raw = String(segment.summary || segment.error || '').trim()
  if (!raw) return ''
  // 堆栈不是给人读的：`Error: 一句话\n    at workflow-script.js:1:7\n    at …` 只留
  // 第一句，整串进 title。判据是「第二行以 at 开头」——正常的摘要是人话，不会长这样，
  // 所以带换行的正常摘要（`delegate:\n完成：…`）不会被误截。
  const text = /^[^\n]*\n\s+at\s/.test(raw) ? raw.split('\n')[0].trim() : raw
  const bad = !segment.summary && Boolean(segment.error)
  return `<p class="summary${bad ? ' bad' : ''}" title="${esc(raw)}">${esc(text)}</p>`
}

/**
 * 历史折叠行的标签：说「续了几次、上次什么时候收尾」，不说「共几段」。
 *
 * 「前 1 段已折叠 · 共 2 段」是数据库的说法，读起来像这张卡是个装着段的容器；
 * 用户真正想知道的是「这东西被用了几次」「上一次是什么时候完的」。耗时只在两端
 * 都有时间戳时才算——旧数据缺 `durationMs` 的情况不少，别显示 0:00。
 * @param {any[]} earlier
 */
function historyLabel(earlier) {
  const times = earlier.length
  const last = earlier[earlier.length - 1] || {}
  const ended = Number(last.endedAt) || 0
  const duration = pastTiming(last)
  if (!ended) return `已续 ${times} 次 · 共 ${times + 1} 次运行`
  return `已续 ${times} 次 · 上次 ${fmtClock(ended)} 完成${duration ? `（${duration}）` : ''}`
}

/**
 * 代际链 + 子代理明细：折成一行，点开才看。
 * 默认收起——卡面只留「现在」，历史不该抢位置。
 *
 * 0.9.9 起历史行**不再是会话入口**：一条链的每一段共用同一份 `session.jsonl`
 * （resume 复用原文件继续写），点第 1 次和第 2 次打开的是同一份对话。留着那些
 * 可点行只会让人以为「点第 N 次能看第 N 段」，而且让卡面失去唯一的入口
 * （「打开」在卡上，和别的子代理一样）。历史行只承担「时间线」。
 */
function renderGen(lineage, segment) {
  const segments = lineage.segments || []
  const earlier = segments.slice(0, -1)
  // 容器卡的子代理已经是下面那些缩进的卡了：明细表只是在同样的内容上再念一遍，
  // 而且点进去还是同一份会话。容器不展开这张表（续跑历史照旧保留）。
  const container = (segment.containerOf || []).length > 0
  const children = container ? [] : segment.children || []
  if (!earlier.length && children.length < 2) return ''
  const open = genOpen.has(lineage.lineageRoot)
  const label = earlier.length ? historyLabel(earlier) : `子代理明细 · ${children.length} 个`
  const lines = []
  earlier.forEach((past, index) => {
    // 计时同样走占位：`running` 的旧段每秒都在变，写进 HTML 就等于让整卡重绘
    const tail = past.summary ? ` · ${esc(past.summary.slice(0, 60))}` : ''
    const inner = `第 ${index + 1} 次 · ${esc(stateText(stateOf(past)))} · <span data-timing="${esc(
      past.runId,
    )}"></span>${tail}`
    lines.push(`<div class="gen-line">${inner}</div>`)
  })
  if (children.length > 1) {
    children.forEach((child, index) => {
      const inner = `<span class="dot ${esc(stateClass(child.state))}"></span><span class="gen-agent">${esc(
        child.agent || `子代理 ${index + 1}`,
      )}</span>${child.model ? `<span class="gen-dim">${esc(child.model)}</span>` : ''}${
        child.thinking ? `<span class="gen-dim">thinking·${esc(child.thinking)}</span>` : ''
      }<span class="gen-dim">${esc(stateText(child.state))}</span>`
      lines.push(
        child.sessionFile
          ? `<button class="gen-line" data-open-session="${esc(child.sessionFile)}">${inner}<span class="chev">›</span></button>`
          : `<div class="gen-line">${inner}</div>`,
      )
    })
  }
  return `<details class="gen" data-gen="${esc(lineage.lineageRoot)}"${open ? ' open' : ''}><summary>${esc(label)}</summary>${lines.join(
    '',
  )}</details>`
}

/**
 * 复活高亮：一条链上多出一段时，这张卡在 1.2s 内带一圈底色。
 *
 * 为什么不一闪而过：排序改成启动时间之后，resume 是唯一还会让卡片移动的场景
 * （新一段的 startedAt 更晚，链回到前面）。移动本身是对的，但「刚才动的是哪张」
 * 得有人回答——高亮就是这个回答。不做循环动画：卡片已经在转圈了，两个动画会打架。
 *
 * 基线按 `owner|root` 记：换会话/切预览时同一 root 的段数会「从 2 变 1 再变 2」，
 * 不带 owner 前缀就会在切回来时误闪一次。
 */
const REVIVE_HIGHLIGHT_MS = 1_200
const reviveAt = new Map()
const lastSegCount = new Map()
let reviveFocus = ''
let reviveSweepAt = 0

function revKey(lineage) {
  const owner = String(snapshot?.ownerSessionKey || snapshot?.sessionKey || '')
  return `${owner}|${String(lineage?.lineageRoot || '')}`
}

function isRevived(lineage) {
  const at = Number(reviveAt.get(revKey(lineage))) || 0
  return at > 0 && Date.now() - at < REVIVE_HIGHLIGHT_MS
}

/** 渲染前跑一次：段数增加 = 这条链刚被 resume 过 */
function markRevivals(lineages) {
  for (const lineage of lineages || []) {
    const key = revKey(lineage)
    if (!String(lineage?.lineageRoot || '')) continue
    const segments = lineage.segments || []
    const prev = lastSegCount.get(key)
    if (prev !== undefined && segments.length > prev) {
      reviveAt.set(key, Date.now())
      reviveFocus = String(segments[segments.length - 1]?.runId || '')
      reviveSweepAt = Date.now() + REVIVE_HIGHLIGHT_MS + 60
    }
    lastSegCount.set(key, segments.length)
  }
  // 会话开得多了以后这张表只增不减；400 条足够覆盖任何真实使用，超了直接重来
  if (lastSegCount.size > 400) {
    lastSegCount.clear()
    reviveAt.clear()
  }
}

function renderCard(lineage) {
  const segments = lineage.segments || []
  const segment = segments[segments.length - 1] || {}
  const state = stateOf(segment)
  const waiting = state === 'waiting'
  const stalled = state === 'stalled'
  // 「还在跑」的绿边让位给「需要关注」的琥珀边：同一张卡不该又绿又橙
  const live = ACTIVE_STATES.has(String(segment.state || '')) && !waiting && !stalled
  const title = titleOf(lineage, segment)
  const container = (segment.containerOf || []).length > 0
  const step = Boolean(segment.stepOf)
  // label 上的 tooltip 只在「一眼看不出来龙去脉」时才给
  const stateTip =
    state === 'launch'
      ? '编排层在启动第一个子代理之前就失败了：这次没有任何子代理被创建出来，所以也没有会话可打开'
      : waiting
        ? `它在等你回答一个问题，自己不会往下走；${
            segment.hasDeadline ? '超过 run 的 deadline 会超时' : '这次运行没有超时保护，不回答就一直等'
          }`
          : stalled
            ? `它已经一段时间没有任何活动了。可能只是长思考，也可能上游请求悬住了——${
                segment.hasDeadline
                  ? '超过 run 的 deadline 会被判超时。'
                  : '这次运行没有超时保护，不会自己结束；要收场只能手动停止。'
              }`
            : state === 'lost'
              ? `运行它的子进程已经结束（pid ${segment.lostPid ?? '未知'}），最常见的原因是应用重启把进程带走了。status 文件冻结在最后一帧，所以这张卡刚才一直显示运行中——这次运行不会再有输出，也不需要停止。${
                  segment.startedAt ? `开始于 ${fmtClock(Number(segment.startedAt))}` : ''
                }`
              : ''
  // 运行中的「在动」由一个转圈承担，不再让 label 底色呼吸。呼吸幅度受限于字与底的
  // 对比度（再浓就掉出 AA），余光里几乎看不出来；转圈是位移变化，一眼就看得见。
  // 「无响应」偏偏不能转：转圈的意思是「在动」，那正是它没在做的事。
  const spin = live ? '<i class="spin" aria-hidden="true"></i>' : ''
  // data-card 是增量渲染的锚点：结构没变的卡在下一帧被原样复用（P7）。
  // viewing = 你眼前这份内容就是它（只读预览子会话时由 main 标出）。
  // container / step 决定缩进与连接线：容器是「大框的头」，步骤卡缩进挂在它下面。
  return `<article class="card${live ? ' live' : ''}${waiting ? ' waiting' : ''}${
    stalled ? ' stalled' : ''
  }${state === 'lost' ? ' lost' : ''}${segment.viewing ? ' viewing' : ''}${container ? ' container' : ''}${
    step ? ' step' : ''
  }${isRevived(lineage) ? ' revived' : ''}" data-card="${esc(segment.runId)}">
    <div class="row1">
      ${agentBadge(agentOf(lineage, segment))}
      <span class="agent" title="${esc(String(segment.sessionName || title))}">${esc(title)}</span>
      <span class="state ${esc(stateClass(state))}"${
        stateTip ? ` title="${esc(stateTip)}"` : ''
      } data-state="${esc(segment.runId)}">${esc(stateLabelOf(segment))}${spin}</span>
      ${waiting || stalled ? `<span class="wait" data-wait="${esc(segment.runId)}"></span>` : ''}
      ${timingSpan(segment)}
    </div>
    ${renderIdent(lineage, segment, title)}
    ${renderSummary(segment)}
    ${renderAsk(segment)}
    ${renderMeta(segment)}
    ${renderActs(segment)}
    ${renderNoteForm(segment)}
    ${renderMailChip(segment)}
    ${renderGen(lineage, segment)}
  </article>`
}

/**
 * 它问的那句话（报告 P20）。
 *
 * 子代理的提问**不进会话流**，只以带外通知飘过去；面板原来也只在等，不说是等什么。
 * 数据和回答现在都在 run 的 `events.jsonl` 里（agent 侧读的），这里只管显示。
 *
 * 两种情况分开：
 *   - 还没回答 → 卡面上出一块引用（最多两行，全文进 title），下面一行说清楚去哪儿答。
 *     面板**不能**替用户回答：宿主 `tool.execute` 只能跑插件自己声明的工具，
 *     `subagent_supervisor({action:'reply'})` 够不到；硬塞一个输入框只会给一个假的入口。
 *   - 已经答了 → 卡面不占位，退成一行弱字（谁问的、什么时候答的、答的什么）。
 */
function renderAsk(segment) {
  const ask = segment?.attentionAsk
  const question = String(ask?.question || '').trim()
  const answer = String(ask?.answer || '').trim()
  if (!question && !answer) return ''

  if (stateOf(segment) === 'waiting' && question) {
    // 卡面只放前 120 字：问题常常带整段上下文，全铺开会把卡撑成一堵墙
    const shown = question.length > 120 ? `${question.slice(0, 120)}…` : question
    return `<div class="ask">
      <p class="ask-q" title="${esc(question)}">${esc(shown)}</p>
      <p class="ask-hint">在主会话里回复它，回答会直接送到它手上</p>
    </div>`
  }

  if (!answer) return ''
  const asked = Number(ask?.askedAt) || 0
  const answered = Number(ask?.answeredAt) || 0
  const took = Number(ask?.durationMs) || 0
  const head = asked ? `问过「${truncate(question, 40) || '…'}」` : '问过一次'
  const tail = answered
    ? ` · ${fmtClock(answered)} 你答了「${truncate(answer, 40)}」${took ? `（等了 ${fmtWait(took)}）` : ''}`
    : ''
  const tip = [question && `问：${question}`, answer && `答：${answer}`].filter(Boolean).join('\n')
  return `<p class="asklog" title="${esc(tip)}">${esc(head + tail)}</p>`
}

/** 一张链最后那段的 run id（卡片显示的就是这一段） */
function cardRunId(lineage) {
  const segments = lineage.segments || []
  return String(segments[segments.length - 1]?.runId || '')
}

/** 这张卡是不是 `parentRunId` 那一步：链上任意一段标了 stepOf 就算（resume 段也一样） */
function isChildCard(lineage, parentRunId) {
  return (lineage.segments || []).some((segment) => String(segment.stepOf || '') === parentRunId)
}

/**
 * 排队中的步骤：**不是卡**——它还没有 runId，没有会话、没有计时、点不动。
 *
 * 只用来解释「容器说有 3 步，为什么下面只有 1 张」。虚线边 + 降透明度，一眼看出
 * 它跟旁边那些真卡不是一回事，也就不会有人去点它。
 */
function renderPending(step) {
  const index = Number(step?.index) || 0
  const label = String(step?.label || '').trim() || `第 ${index + 1} 步`
  return `<div class="card step pending">
    <div class="row1">
      ${agentBadge(step?.agent)}
      <span class="agent">${esc(label)}</span>
      <span class="state">待启动</span>
    </div>
  </div>`
}

/**
 * 列表：容器卡 + 一束缩进的子卡，连接线由 CSS 画。
 *
 * main 已经把子卡排在父卡后面，这里只需顺着看「紧跟的这几张是不是我的子」。
 * 递归是为了嵌套容器（workflow 里再开 workflow）：子卡自己也带一束，缩进自然叠一层。
 * 子卡不是「另一种卡」——插话、停止、打开都照旧，只是视觉上归属父卡。
 *
 * 排队中的步骤（`pendingSteps`）没有 runId，接在子树末尾：串行 workflow 里排队的
 * 本来就在后面几步，位置是对的；并行乱序时可能偏一点，但总比「整条不显示」强。
 */
function renderList(lineages) {
  const out = []
  let index = 0
  while (index < lineages.length) {
    const lineage = lineages[index]
    const segments = lineage.segments || []
    const runId = cardRunId(lineage)
    const last = segments[segments.length - 1] || {}
    out.push(renderCard(lineage))
    index += 1
    const pending = (last.pendingSteps || []).map(renderPending).join('')
    if (!(last.containerOf || []).length && !pending) continue
    const kids = []
    while (index < lineages.length && isChildCard(lineages[index], runId)) {
      kids.push(lineages[index])
      index += 1
    }
    // 子卡不在紧跟位置时（数据缺口），它们会以缩进卡的形式留在原位——不藏起来
    if (kids.length || pending) {
      out.push(`<div class="subtree" data-card="sub:${esc(runId)}">${renderList(kids)}${pending}</div>`)
    }
  }
  return out.join('')
}

function renderBanner(degrade) {
  // 没有标题就没有横幅：`ok` 与 `archived`（只剩归档，实例都退出了）都不该占一行。
  // 判标题而不是枚举 kind——以后再加「不需要用户行动的」状态不会漏成这样一条空横幅。
  if (!degrade || !degrade.title) return ''
  return `<div class="banner banner-${esc(degrade.tone || 'info')}">
    <strong>${esc(degrade.title)}</strong>
    <span>${esc(degrade.detail)}</span>
  </div>`
}

/**
 * 空态。分成两种语气：
 *   - `asEmpty`（没打开会话 / 还没运行记录）：这里**暂时没东西**，是正常状态，
 *     画虚线框就行——横幅带左侧色条，是「有事要你注意」的语气，用在这里太重。
 *   - `kind: 'ok'` 但列表为空：数据链路是通的，只是这个会话还没派过子代理。
 *
 * 其余 kind（连不上 / 数据过期 / 插件卸载中）仍然走横幅：那些是**真问题**，
 * 该被注意到。
 */
function renderEmpty(degrade) {
  if (degrade && degrade.kind !== 'ok' && !degrade.asEmpty) return ''
  const title = degrade?.asEmpty ? degrade.title : '还没有子代理运行记录'
  const detail = degrade?.asEmpty
    ? degrade.detail
    : '派一个后台子代理，它跑起来就会出现在这里。'
  const hint = degrade?.asEmpty ? degrade.hint : ''
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(detail)}</span>${
    hint ? `<span class="empty-hint">${esc(hint)}</span>` : ''
  }</div>`
}

/** 顶部浮层：fixed 定位，不占文档流，所以不会顶得内容往下跳；滚动时也不跟着跑 */
function renderNotice() {
  if (!notice) return ''
  const ttl = NOTICE_MS[notice.tone] ?? 4_000
  if (Date.now() - notice.at > ttl) {
    notice = null
    return ''
  }
  return `<div class="notice notice-${esc(notice.tone)}">${esc(notice.text)}</div>`
}

/* ---------- 渲染：骨架只建一次，之后按分区 patch（P7） ---------- */

/**
 * 为什么拆成五个分区：整块 `el.innerHTML = html` 最省事，代价是**每秒一次把
 * 所有卡片连同用户的选区、焦点、滚动位置一起重建**。诊断区的「心跳 3s 前」就是
 * 那个每秒都在变的字段——它一变，整块 HTML 就不相等，于是整块重建。
 *
 * 现在的规矩：
 *   1. 秒级字段（心跳、计时、当前工具耗时）一律留空占位，由 `uiPulse` 用
 *      textContent 填——HTML 里没有任何随时间变化的东西；
 *   2. 卡片按 runId 增量替换：key 序列没变时只换内容真的变了的那几张；
 *   3. 顶栏 / 横幅 / 诊断各自比较，互不牵连。
 */
let shell = null

function ensureShell() {
  if (shell) return
  el.innerHTML = `
    <div class="slot notice-slot"></div>
    <div class="slot head-slot"></div>
    <div class="slot banner-slot"></div>
    <div class="cards"></div>
    <div class="slot diag-slot"></div>`
  shell = {
    notice: el.querySelector('.notice-slot'),
    head: el.querySelector('.head-slot'),
    banner: el.querySelector('.banner-slot'),
    cards: el.querySelector('.cards'),
    diag: el.querySelector('.diag-slot'),
  }
}

/** 分区写入：内容没变就不碰 DOM。用节点上的 `__html` 记住上次的值 */
function setSlot(node, html) {
  if (!node) return false
  if (node.__html === html) return false
  node.__html = html
  node.innerHTML = html
  return true
}

/**
 * 卡片列表：key 序列（runId 及其顺序）没变时，只替换内容变了的卡；
 * 成员或顺序变了才整组重建——那一刻通常是用户刚派了新 run，不在操作旧卡。
 * @param {string} html
 */
function patchCards(html) {
  if (!shell?.cards) return
  if (shell.cards.__html === html) return
  shell.cards.__html = html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const next = Array.from(tpl.content.children)
  const prev = Array.from(shell.cards.children)
  const sameOrder =
    prev.length === next.length &&
    next.every((node, i) => prev[i].getAttribute('data-card') === node.getAttribute('data-card'))
  if (!sameOrder) {
    shell.cards.replaceChildren(...next)
    return
  }
  next.forEach((node, i) => {
    if (prev[i].outerHTML !== node.outerHTML) prev[i].replaceWith(node)
  })
}

/**
 * 内容归属（`ownerSessionKey`）变了才恢复滚动位置；没变就一律不碰。
 *
 * 打开子会话时归属没变（面板显示的还是父会话那条链），所以滚动位置原地不动；
 * 从别的会话切回来时换回它上次停的地方。读 `scrollTop` 会强制一次 layout，
 * 因此只在这里读，不进每秒的心跳。
 * @param {any} data
 */
function syncScroll(data) {
  const owner = String(data?.ownerSessionKey || data?.sessionKey || '')
  if (!owner || owner === scrollOwner) return
  scrollOwner = owner
  const saved = scrollMemo.get(owner)
  el.scrollTop = saved == null ? 0 : saved
}

/**
 * 顶栏。返回按钮只有图标：这一行本来就窄，「← 主会话」四个字占的位置比
 * 状态词还多；图标 + `title` 足够，卡上那个「返回」才是带字的。
 *
 * 主体写**状态**（本会话 / 子会话预览），不写「子代理」：右栏 tab 的标题已经是
 * 「子代理」，顶部再来一遍只是把同一个名字说了两遍。这一行该回答的是另外两个问题
 * ——「我在哪一层」「这儿有几个在跑」。
 *
 * 主会话时**左侧什么都不放**：没有标题，就没有「标题被按钮推着跑」这回事——
 * 位移的前提是那儿有个东西。空着比放一个淡箭头占位更干净，也不用解释「这个淡图标
 * 为什么点不动」。进预览时左侧长出一条 `‹ 主会话`，右侧计数是右对齐的，原位不动。
 *
 * 返回控件把「回哪儿」写在自己身上（`‹ 主会话`），而不是另起一行说「你在子会话预览」：
 * 前者回答「点了会去哪」，后者只是描述状态。整块（箭头 + 文字）是一个按钮，
 * 点文字也能点，命中区域比 22px 的方图标大一倍多。
 */
function renderHead(data, lineages) {
  const active = Number(data.activeCount) || 0
  const previewing = Boolean(data.parentSessionFile)
  const arrow = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.9 3.4 5.1 8l4.8 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  const back = previewing
    ? `<button class="back" data-open-session="${esc(data.parentSessionFile)}" title="返回主会话" aria-label="返回主会话">${arrow}<span>主会话</span></button>`
    : ''
  return `<div class="head">
    ${back}
    <span class="spacer"></span>
    <span class="count">${active ? `${active} 个在跑` : `${lineages.length} 个记录`}</span>
  </div>`
}

/** 诊断区：**心跳是占位**，由 uiPulse 填。写在这里就会让整块 HTML 每秒变一次 */
function renderDiag(data) {
  return `<details class="diag"${diagOpen ? ' open' : ''}>
    <summary>诊断</summary>
    <dl>
      <dt>会话</dt><dd>${esc(data.sessionFile || '—')}</dd>
      <dt>数据文件</dt><dd>${esc(data.dataFile || '—')}</dd>
      <dt>数据源</dt><dd>${esc(
        data.source?.mode === 'push' ? '推送' : data.source?.mode === 'poll' ? '轮询' : '未连接',
      )}</dd>
      <dt>心跳</dt><dd data-heartbeat></dd>
      <dt>轮询</dt><dd data-poll></dd>
      <dt>记录</dt><dd>${esc(
        data.generations > 1
          ? `${data.generations} 代实例合并（换过会话/重开过软件，历史已并进来）`
          : '当前实例',
      )}${data.healed ? ` · 自愈 ${data.healed} 张` : ''}${
        data.pinnedCards > 0 ? ` · 保底 ${data.pinnedCards} 张（运行中/刚结束）` : ''
      }${data.hiddenCards > 0 ? ` · 另有 ${data.hiddenCards} 张更早的未显示` : ''}</dd>
      <dt>能力</dt><dd>${esc((data.source?.capabilities || []).join(', ') || '—')}</dd>
      <dt>干预</dt><dd>${esc(
        data.source?.supports
          ? `插话 ${data.source.supports.steer ? '可用' : '不支持'} · 停止 ${data.source.supports.stop ? '可用' : '不支持'}`
          : '—（扩展未公告）',
      )}</dd>
      <dt>事件</dt><dd>${esc((data.source?.events || []).join(', ') || '—')}</dd>
      <dt>最近错误</dt><dd>${esc(data.source?.lastError || '—')}</dd>
    </dl>
  </details>`
}

function render() {
  // 面板已经被宿主摘掉（`dispose`）：什么都不画。
  // 切面板时挂起的长轮询会被 reject，此时再画一帧，用户就看见一次「读取失败」的红字。
  if (disposed) return
  // 编辑插话时不重建：用户正在打字，画面一动就丢焦点，而且卡片位置会跳。
  // 但「展开表单」「切成发送中」这些是表单自己的状态变化，要放行一次。
  if (noteDraft && !paintOnce) {
    uiPulse()
    return
  }
  paintOnce = false
  if (stopConfirm && Date.now() >= stopConfirm.until) stopConfirm = null
  ensureShell()
  setSlot(shell.notice, renderNotice())

  const data = snapshot
  // 错误要「过了足够久」才顶掉整页：瞬时失败（切换面板、宿主重载）不该变成红屏
  const errorReady = Boolean(lastError) && errorSince > 0 && Date.now() - errorSince >= ERROR_SHOW_DELAY_MS
  if (errorReady) {
    setSlot(shell.head, '')
    setSlot(shell.banner, `<div class="banner banner-error"><strong>面板读取失败</strong><span>${esc(lastError)}</span></div>`)
    patchCards('')
    setSlot(shell.diag, '')
    return
  }
  if (!data) {
    setSlot(shell.head, '')
    setSlot(shell.banner, '<p class="pad dim">正在读取…</p>')
    patchCards('')
    setSlot(shell.diag, '')
    return
  }

  const lineages = data.lineages || []
  markRevivals(lineages)
  setSlot(shell.head, renderHead(data, lineages))
  setSlot(shell.banner, data.degrade?.asEmpty ? '' : renderBanner(data.degrade))
  patchCards(lineages.length ? renderList(lineages) : renderEmpty(data.degrade))
  setSlot(shell.diag, renderDiag(data))
  // 内容归属换人了才动滚动位置（同一份内容不拍回顶部）
  syncScroll(data)
  // 新插入的占位是空的，立刻推一次
  uiPulse()
  // 复活的那张卡：只在它本来就在眼前时温和对齐。不在视口内一律不动——
  // 为了追一张卡把用户正在读的内容推走，比不追更烦。
  if (reviveFocus) {
    const node = el.querySelector(`.card[data-card="${reviveFocus}"]`)
    if (node && inViewport(node)) node.scrollIntoView({ block: 'nearest' })
    reviveFocus = ''
  }
}

/** 元素是否完整落在滚动容器里（边界各放宽 4px，贴边不算「在外面」） */
function inViewport(node) {
  const box = node.getBoundingClientRect()
  const view = el.getBoundingClientRect()
  return box.top >= view.top - 4 && box.bottom <= view.bottom + 4
}

/**
 * 每秒一次的纯 UI 心跳：只改文本，不发请求、不重建结构。
 * 拉数据的节奏是另一回事（见 pollLoop）——诊断/计时不该跟着它一起变慢。
 */
function uiPulse() {
  // 高亮只该出现一次：动画播完后重绘一帧把 class 摘掉，否则下次复活时 class 还在，
  // 浏览器不会重播同一个动画——「第二次 resume 没有高亮」会成为一个很怪的 bug。
  if (reviveSweepAt && Date.now() >= reviveSweepAt) {
    reviveSweepAt = 0
    render()
    return
  }
  tickTimings()
  const heartbeat = el.querySelector('[data-heartbeat]')
  if (heartbeat) {
    const age = snapshot?.liveness?.ageMs
    const next = age == null ? '—' : fmtAge(age)
    if (heartbeat.textContent !== next) heartbeat.textContent = next
  }
  // 「拉了没 / 拿到没」分开看：这两个数一起停，才是真停了
  const poll = el.querySelector('[data-poll]')
  if (poll) {
    const next = pollSummary()
    if (poll.textContent !== next) poll.textContent = next
  }
  // 提示的过期由它自己判定（返回空串），也只影响这一个分区
  if (shell?.notice) setSlot(shell.notice, renderNotice())
}

/* ---------- 操作 ---------- */

/** 插话入口：**toggle**——同一个按钮再点一次收起，误触不会留下一个常驻框（P2） */
function toggleNote(runId) {
  if (noteDraft && String(noteDraft.runId) === String(runId)) {
    const dropped = String(noteDraft.text || '').trim().length > 0
    noteDraft = null
    if (dropped) setNotice('已收起，没发出去的内容没有保留', 'info')
    render()
    return
  }
  const segment = findSegment(runId)
  noteDraft = {
    runId: String(runId),
    agent: String(segment?.agent || ''),
    mode: 'steer',
    text: '',
    busy: false,
    error: '',
  }
  paintOnce = true
  render()
  const input = el.querySelector('[data-note-input]')
  if (input) input.focus()
}

function closeNote({ quiet = false } = {}) {
  const dropped = Boolean(noteDraft && String(noteDraft.text || '').trim())
  noteDraft = null
  if (dropped && !quiet) setNotice('已收起，没发出去的内容没有保留', 'info')
  render()
}

async function submitNote() {
  if (!noteDraft || noteDraft.busy) return
  const text = String(noteDraft.text || '').trim()
  if (!text) {
    noteDraft.error = '说点什么再发'
    paintOnce = true
    render()
    return
  }
  // 完成态闸门（P2′）：表单展开之后它结束了，就别投——扩展必然拒，用户还要再猜一次。
  // 草稿不动，用户能复制去 resume。
  const target = findSegment(noteDraft.runId)
  if (!target || !ACTIVE_STATES.has(String(target.state))) {
    noteDraft.error = '它已经结束了，这条没投出去（草稿留着）'
    paintOnce = true
    render()
    return
  }
  // 投递按**父会话**寻址：预览子会话时链属于父会话，跑着这条链的 agent 在父会话进程里
  const sessionKey = String(snapshot?.ownerSessionKey || '')
  if (!sessionKey) {
    noteDraft.error = '拿不到会话标识，先切回主会话再试'
    paintOnce = true
    render()
    return
  }
  noteDraft.busy = true
  noteDraft.error = ''
  paintOnce = true
  render()
  try {
    const result = await bridge.invoke('note', {
      sessionKey,
      runId: noteDraft.runId,
      agent: noteDraft.agent || undefined,
      // 默认打断它当前这一轮；扩展还支持 follow_up（等这一轮做完再说），需要时由 UI 加开关
      mode: noteDraft.mode || 'steer',
      message: text,
    })
    if (!result?.ok) {
      noteDraft.busy = false
      noteDraft.error = result?.error?.message || '没能投出去，请重试'
      paintOnce = true
      render()
      return
    }
    sentNotes.push({ id: String(result.id || ''), runId: String(noteDraft.runId), kind: 'note', at: Date.now() })
    noteDraft = null
    render()
    // 用户动作发起的刷新一律 force：正在飞的那次是 6s 长轮询，排队等它等于让回执晚 6 秒
    void pollOnce({ force: true })
  } catch (error) {
    noteDraft.busy = false
    noteDraft.error = `发送失败：${error instanceof Error ? error.message : String(error)}`
    paintOnce = true
    render()
  }
}

async function confirmStop(runId) {
  const sessionKey = String(snapshot?.ownerSessionKey || '')
  if (!sessionKey) {
    setNotice('拿不到会话标识，先切回主会话再试', 'error')
    render()
    return
  }
  stopConfirm = null
  // 3 秒确认窗口里它可能已经自己跑完了。这时候还发 stop，扩展只会回一句
  // 「stop only supports running or queued…」——用一次"失败"去换一次"目标已达成"，
  // 纯属自找红字。本地状态已经知道它停了，就不发了（竞态窗口内那一下由回执兜底）。
  const segment = findSegment(runId)
  if (!segment || !ACTIVE_STATES.has(String(segment.state))) {
    setNotice('它已经自己结束了，不用再停', 'warn', `stop:${runId}`)
    render()
    return
  }
  try {
    const result = await bridge.invoke('stop', { sessionKey, runId })
    if (!result?.ok) {
      setNotice(result?.error?.message || '停止请求没能投出去', 'error')
    } else {
      sentNotes.push({ id: String(result.id || ''), runId: String(runId), kind: 'stop', at: Date.now() })
    }
  } catch (error) {
    setNotice(`停止失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  render()
  // stop 的「stopping」到终态要靠 status 收敛，别让用户盯着不动的卡
  void pollOnce({ force: true })
}

/**
 * 打开一段会话（宿主二分：主会话激活、子会话只读预览）。
 *
 * 走宿主 `sessions.activate`：目标在当前工作区侧栏就正常激活——「返回主会话」
 * 时用户拿到的是可写对话；子会话不在侧栏，退化为只读预览（观测层不指挥会话）。
 * 失败是常态（一次性 run 的会话会被清理），所以文案说清原因，而不是静默。
 * 同一份文件连点多次只提示一次（P8）。
 * @param {string} sessionFile
 */
async function openSession(sessionFile) {
  let moved = false
  try {
    const result = await bridge.invoke('openSession', { sessionFile })
    moved = Boolean(result?.ok)
    if (!moved) setNotice('会话文件已不存在，可能已被清理', 'warn', `open:${sessionFile}`)
  } catch (error) {
    setNotice(`打开失败：${error instanceof Error ? error.message : String(error)}`, 'error', `open:${sessionFile}`)
  }
  render()
  if (!moved) return
  // 「打开 / 返回」改的是**视图身份**（我在看哪份会话），live 数据一个字节都没动。
  // 手上的版本戳仍然是旧的：不丢它就等于让 main 挂满 6 秒再回一句「什么都没变」，
  // 用户看到的是按钮点了没反应、过一会儿才换字（这就是「变化不太对了」）。
  // 丢掉戳 + 直接 force 一次：宿主那边上下文一变，这里立刻拿到「返回 / 打开」的正确归属。
  lastRev = ''
  void pollOnce({ force: true })
}

// 事件委托，挂一次就够——innerHTML 重建不带走 el 自己的监听器。
// toggle 不冒泡但捕获阶段能到达：details 每次重建后状态由 genOpen / diagOpen 恢复，
// 用户点击 summary → 浏览器切 open → toggle 更新状态 → 下一帧重绘不丢。
el.addEventListener(
  'toggle',
  (/** @type {Event} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target)
    if (!(target instanceof HTMLDetailsElement)) return
    if (target.classList.contains('diag')) diagOpen = target.open
    const root = target.getAttribute('data-gen')
    if (root) {
      if (target.open) genOpen.add(root)
      else genOpen.delete(root)
    }
  },
  true,
)
el.addEventListener('input', (/** @type {InputEvent} */ event) => {
  const target = /** @type {HTMLTextAreaElement} */ (event.target)
  if (noteDraft && target.matches?.('[data-note-input]')) noteDraft.text = target.value
})
el.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
  if (!noteDraft) return
  const target = /** @type {HTMLElement} */ (event.target)
  if (!target?.matches?.('[data-note-input]')) return
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submitNote()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeNote()
  }
})
el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
  const target = /** @type {HTMLElement} */ (event.target)
  if (!target?.closest) return

  if (target.closest('[data-note-cancel]')) {
    closeNote()
    return
  }
  if (target.closest('[data-note-send]')) {
    void submitNote()
    return
  }
  const noteButton = /** @type {HTMLElement | null} */ (target.closest('[data-note]'))
  if (noteButton) {
    const runId = noteButton.getAttribute('data-note')
    if (runId) toggleNote(runId)
    return
  }
  if (target.closest('[data-stop-cancel]')) {
    stopConfirm = null
    render()
    return
  }
  const stopConfirmButton = /** @type {HTMLElement | null} */ (target.closest('[data-stop-confirm]'))
  if (stopConfirmButton) {
    const runId = stopConfirmButton.getAttribute('data-stop-confirm')
    if (runId) void confirmStop(runId)
    return
  }
  const stopButton = /** @type {HTMLElement | null} */ (target.closest('[data-stop]'))
  if (stopButton) {
    const runId = stopButton.getAttribute('data-stop')
    // 就地二次确认：3 秒不点自动退回，不弹框、不占输入区
    if (runId) stopConfirm = { runId, until: Date.now() + 3_000 }
    render()
    return
  }
  const sessionButton = /** @type {HTMLElement | null} */ (target.closest('[data-open-session]'))
  if (sessionButton) {
    const file = sessionButton.getAttribute('data-open-session')
    if (file) void openSession(file)
  }
})

/** 请求代际：上下文一变就并发发新请求，只让最新那次写回（旧结果属于旧上下文） */
let reqSeq = 0
/**
 * 最新那次请求还在飞。只有它挡得住新的轮询——被放弃的旧请求不算：它的结果注定要丢，
 * 等它没有意义（它最长要挂满 6 秒的长轮询）。
 */
let latestPending = false

/**
 * @param {{ force?: boolean }} [options]
 *
 * `force` 是给**用户动作**（点打开 / 返回、宿主推了新上下文）用的：这类变化不能排队，
 * 因为正在飞的那次请求是长轮询——数据没变它就在 main 里挂着，最长 6 秒才回。排队等它
 * 就等于「点了按钮半天不换字」。并发再发一次，靠 `reqSeq` 把过期的那份丢掉。
 */
async function tick(options = {}) {
  // 正在飞的那次请求问的不是当前会话（刚切会话 / 刚从后台回来）→ 排一次，别丢掉。
  // 丢掉的话要等下一个轮询周期才会去问新会话，用户看到的就是「卡了一会儿」。
  if (latestPending && !options.force) {
    tickQueued = true
    return
  }
  const seq = ++reqSeq
  latestPending = true
  noteTickStart()
  const askedFor = String(context?.sessionFile || '')
  const askedRev = lastRev
  try {
    const state = await bridge.invoke('getState', {
      sessionFile: askedFor,
      // 长轮询：版本没变就让 main 挂住，变化立刻返回。
      //
      // 不看 `document.hidden` 决定挂不挂：宿主把右栏切走时 iframe 常常只是被 CSS
      // 隐藏，这个标志未必跟着更新（P16 就是被它坑的）。一旦它误报 true，长轮询会
      // 退化成 5s 轮询，比现在更慢。挂着一个 promise 的成本远低于「猜错就变慢」。
      rev: askedRev,
      waitMs: LONG_POLL_MS,
    })
    // 期间又发了一次（点了按钮 / 换了上下文）：这份结果已经过期，写进去就是拿旧视图
    // 覆盖新视图——「返回」按下去按钮先变回「打开」，紧接着又弹回「返回」，就是它干的
    if (seq !== reqSeq) return
    // 期间切了会话：这份结果属于上一个会话，写进去就是串台，丢掉重来
    if (String(context?.sessionFile || '') !== askedFor) {
      tickQueued = true
      return
    }
    snapshot = state
    lastRev = String(state?.rev || '')
    lastError = ''
    errorSince = 0
    tickOkAt = Date.now()
  } catch (error) {
    // 面板已销毁：这次失败是「宿主收摊」的副产品，不是用户该看到的读取失败
    if (disposed) return
    if (seq !== reqSeq) return
    if (!errorSince) {
      errorSince = Date.now()
      // 延迟到期要自己补一次重绘：这期间没有别的事件会来推动它
      setTimeout(() => {
        if (!disposed) render()
      }, ERROR_SHOW_DELAY_MS + 40)
    }
    lastError = error instanceof Error ? error.message : String(error)
    tickFailAt = Date.now()
  } finally {
    // 只有最新那次负责重绘与续跑：旧的写完也白写
    if (seq === reqSeq) {
      latestPending = false
      render()
      if (tickQueued) {
        tickQueued = false
        // 走 pollOnce 而不是直接 tick：这条支路也要能扛住渲染异常，
        // 否则「补问一次」抛错就成了没人管的 rejection
        void pollOnce()
      }
    }
  }
}

bridge.on('context', (next) => {
  // 面板可能被宿主**复用**：同一个插件换面板时入口 URL 不变，iframe 不重新导航，
  // 文档一直活着（宿主只在整块面板卸载时才发 dispose）。万一真的收到了 dispose 又
  // 收到新的 context，说明这边还活着——把自己救回来，否则之后一律不重绘，等于白屏。
  if (disposed) {
    disposed = false
    if (!pulseTimer) {
      pulseTimer = setInterval(() => {
        if (!disposed) uiPulse()
      }, 1000)
    }
  }
  context = next || {}
  awaitingContext = false
  if (contextFallback) {
    clearTimeout(contextFallback)
    contextFallback = null
  }
  // **不在这里清 snapshot / 清 DOM**：清空会让「打开子会话」「从设置页回来」白闪一下，
  // 而且是两次空态（先「正在读取…」再出卡片）。新数据到达前保留上一帧，
  // 顶多一瞬间旧内容，比空白好。滚动位置也靠这一点保住（见 syncScroll）。
  lastError = ''
  // 计时也要一起清：只清文案不清时刻，下一次失败会「立刻到期」——等于没有迟滞
  errorSince = 0
  // 版本戳按会话算，换会话必须清零：带着旧会话的 rev 去问，main 会误判「没变化」
  // 并把请求挂满 6 秒，用户看到的就是「切过来还是旧内容」
  lastRev = ''
  // 正在编辑的插话指向的 run 已经不在这个会话里——留着只会发错地方
  noteDraft = null
  stopConfirm = null
  sentNotes.length = 0
  genOpen.clear()
  // 上下文一变就是「视图换了」，不能排队等长轮询：正在挂的那次问的是旧会话，
  // 数据没变它还要挂几秒。这里并发一次，旧的那份结果会被代际号丢掉。
  // 走 pollOnce：宿主重推 context 是**轮询链死掉之后唯一的救命绳**，这条绳自己不能再断。
  void pollOnce({ force: true })
})

/* ---------- 两条独立的时钟（P9） ---------- */

/** 长轮询挂多久：桥的调用超时是 10s，6s 留足余量 */
const LONG_POLL_MS = 6_000

/*
 * 拉数据的节奏
 *
 * 从 0.9.1 起主通道是**长轮询**：`getState({ rev, waitMs })` 在数据没变时挂住，一有变化
 * （`fs.watch` 看到 live 目录落盘）立刻返回。所以「一返回就再发一次」就是最紧的循环，
 * 不用再按 1s/3s/5s 猜节奏——有变化毫秒级到，没变化就静静挂着（6s 一轮，空转成本是一次
 * 挂着的 promise）。
 *
 * 200ms 的缝不是节流，是留给「渲染完、事件处理完」的余量：main 刚返回就立刻再问，
 * 极端情况下会和上一帧的 DOM 更新挤在一起。
 */
function pollDelay() {
  if (lastError) return 5_000
  // 渲染出过错就先慢下来：错因可能是稳定复现的（同一份数据每次都炸），
  // 200ms 一轮会变成每秒五次无意义的重试。
  if (loopErrors && Date.now() - lastLoopErrAt < 5_000) return 1_500
  // 还没拿到版本戳（首帧 / 空会话）：空会话没有可等的变化，别用 200ms 去打它
  if (!lastRev) return 500
  return 200
}

/** @type {any} */
let pollTimer = null
/** @type {any} */
let pulseTimer = null
let disposed = false
/** 上一次发起请求的时刻：看门狗据此判断「轮询链是不是断了」 */
let lastTickAt = 0
/** tick **自己抛错**的次数与最后一条原因（渲染 bug，不是请求失败） */
let loopErrors = 0
let lastLoopError = ''
let lastLoopErrAt = 0
/** 看门狗把停摆的轮询救回来几次 */
let stallRevives = 0

/**
 * 轮询链断了的兜底阈值：正常节奏是「6s 长轮询 + 200ms」，一轮最多 ~6.2s。
 * 超过这个还没发起新请求，就不是慢，是停了。
 *
 * 取 9s：比最慢的正常一轮留 2.8s 余量（桥自己的超时是 10s，真悬着的那次也快到期），
 * 又不会让用户「跑完了却盯着旧卡」等太久。实测：第一次请求永远不回来时，
 * 9.2s 后看门狗补一次，卡片当场换成「已完成」。
 */
const STALL_MS = 9_000

function noteTickStart() {
  const now = Date.now()
  lastTickAt = now
  tickStamps.push(now)
  while (tickStamps.length && now - tickStamps[0] > 60_000) tickStamps.shift()
}

function pollSummary() {
  const now = Date.now()
  const recent = tickStamps.filter((at) => now - at < 60_000).length
  const last = tickOkAt ? `上次成功 ${fmtAge(now - tickOkAt)}` : '还没成功过'
  const fail = tickFailAt && tickFailAt > tickOkAt ? ` · 上次失败 ${fmtAge(now - tickFailAt)}` : ''
  // 长轮询下「次数」不再是节奏，而是「这一分钟里被唤醒了几次」——数据在变的频率
  const mode = `长轮询 6s · 唤醒 ${recent} 次/分`
  // 两个例外计数只在非 0 时出现：正常面板不该有这两个数，有就说明有过事故
  const loop = loopErrors ? ` · 渲染出错 ${loopErrors} 次（${lastLoopError.slice(0, 40)}）` : ''
  const watchdog = stallRevives ? ` · 看门狗兜底 ${stallRevives} 次` : ''
  return `${mode} · ${last}${fail}${loop}${watchdog}`
}

/**
 * 一次「拉 + 排下一次」。
 *
 * 这里的 try/catch 不是防请求失败（那在 `tick` 里已经处理成红字）：拦的是 **`tick` 自己
 * 抛错**——渲染 / DOM 更新里的 bug。原来写的是 `await tick(); schedulePoll()`，一条链：
 * 中间抛一次，链就断了，**面板永久停在上一帧**，只有用户切窗口或切面板（宿主重推
 * context → force）才能把它救回来。用户看到的就是「跑完了卡片还写着运行中，切一下窗口
 * 才变」——一个渲染异常被报成了「数据不刷新」。
 */
async function pollOnce(options = {}) {
  try {
    await tick(options)
  } catch (error) {
    loopErrors += 1
    lastLoopErrAt = Date.now()
    lastLoopError = error instanceof Error ? error.message : String(error)
  } finally {
    if (!disposed) schedulePoll()
  }
}

function schedulePoll(delay = pollDelay()) {
  if (disposed) return
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => {
    pollTimer = null
    if (disposed) return
    void pollOnce()
  }, delay)
}

// UI 心跳与拉数据分开：拉取降到 3s/5s 时，计时和「未确认」的措辞仍要每秒往前走。
// 不再看 document.hidden：同一个可疑信号既是「不拉数据」的起因，也让计时在回来时
// 一眼是旧数。它只改文本、不发请求，藏起来时跑也没成本。
pulseTimer = setInterval(() => {
  if (disposed) return
  uiPulse()
  // 看门狗：轮询链断在哪一环都不该让面板**永久**停在上一帧。这里只回答一个问题
  // ——「有多久没发起过新请求了」，不猜原因；用 force 绕过「请求在飞」的门禁，
  // 所以悬着的那次也拦不住它。正常节奏 6s 一轮，12s 没动静就是真停了。
  if (!lastTickAt) return
  if (Date.now() - lastTickAt > STALL_MS) {
    stallRevives += 1
    void pollOnce({ force: true })
  }
}, 1000)

document.addEventListener('visibilitychange', () => {
  if (disposed) return
  // 这里**不**清掉定时器就不管了（P16 的坑）：清掉之后无论可见不可见都要重新排，
  // 否则表就停在那一刻。切回来时先拉一把，别让用户盯着上次的快照。
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (document.hidden) {
    schedulePoll()
    return
  }
  void pollOnce({ force: true })
})

bridge.on('dispose', () => {
  disposed = true
  if (pollTimer) clearTimeout(pollTimer)
  if (pulseTimer) clearInterval(pulseTimer)
  if (contextFallback) clearTimeout(contextFallback)
  pollTimer = null
  pulseTimer = null
  contextFallback = null
  noteDraft = null
})

/**
 * 开局：上下文里有 sessionFile 就直接拉；没有就先画骨架等着。
 *
 * 桥在 iframe load 时发 hello，宿主回一条 `plugin-context`——两者之间有个几十到几百
 * 毫秒的空窗，那时 `bridge.context` 还是 `{}`。在这个空窗里发 getState 会拿到
 * 「没有打开会话」的横幅，接着再被真数据替换，用户看到的就是「白闪 + 延迟」。
 * 1.5 秒兜底：真的没开会话时也得给个结果，不能让面板一直停在「正在读取…」。
 */
function startTicking() {
  void pollOnce()
}

if (awaitingContext) {
  render()
  contextFallback = setTimeout(() => {
    contextFallback = null
    if (!String(context?.sessionFile || '').trim()) {
      awaitingContext = false
      startTicking()
    }
  }, 1_500)
} else {
  startTicking()
}
