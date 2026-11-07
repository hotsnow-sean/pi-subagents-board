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
 *   1. **计时数字不进 HTML**：卡片里只放空的 `<span data-timing>`，插入 DOM 后由
 *      `tickTimings` 用 textContent 填。否则每秒算出的 HTML 都不同，`lastHtml` 比对
 *      永远不相等，整块 innerHTML 每秒重建一次——选区、焦点、动画全丢。
 *   2. **HTML 没变就不碰 DOM**：`lastHtml` 比对，相等只推计时。
 *   3. **编辑插话时暂停重绘**：用户正在打字的那几秒，画面不该动；提交/取消后再同步。
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
let busy = false
/** 用户展开的代际链（按 lineageRoot 记），重绘后恢复 */
const genOpen = new Set()
/** 诊断折叠区的展开状态：整块重绘会把它拍回去，必须自己记 */
let diagOpen = false
/** 上一帧的 HTML：一样就不碰 DOM */
let lastHtml = ''
/** 编辑插话时默认不重绘；改表单自身状态（展开/发送中）时放行一次 */
let paintOnce = false

/** 正在编辑的插话：`{ runId, agent, mode, text, busy, error }` */
let noteDraft = /** @type {any} */ (null)
/** 停止的二次确认：`{ runId, until }`，3 秒不点自动回退 */
let stopConfirm = /** @type {any} */ (null)
/** 顶部浮层提示（绝对定位，不占文档流，所以不会顶内容） */
let notice = /** @type {{ text: string, tone: string, at: number } | null} */ (null)
/** 本会话发出去、还在等回执的投递：`[{ id, runId, kind, at }]` */
const sentNotes = []

const NOTICE_MS = { ok: 3_000, warn: 8_000, error: 8_000, info: 4_000 }
/**
 * 发出多久还没回执，就从「投递中」改口成「未确认」。
 * 6 秒的口径：worker 500ms 轮询 + 扩展内部最多 3s ack 等待 + RPC 往返。
 */
const RECEIPT_PATIENCE_MS = 6_000
/** 回执 chip 的保鲜期：再久就只是历史，留在卡上会让人以为刚刚才发生 */
const RECEIPT_VISIBLE_MS = 5 * 60_000

function setNotice(text, tone = 'info') {
  notice = { text, tone, at: Date.now() }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
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
  paused: '已暂停',
  rejected: '被拒绝',
  unknown: '状态未知',
}

const ACTIVE_STATES = new Set(['running', 'queued'])

/** 点 / 文字的颜色跟着状态走：卡片上不再挂胶囊标签（原型 A 的做法） */
function stateClass(state) {
  const key = String(state || 'unknown')
  if (ACTIVE_STATES.has(key)) return 'live'
  if (key === 'failed' || key === 'error' || key === 'timeout' || key === 'rejected') return 'bad'
  if (key === 'stopping') return 'stopping'
  if (key === 'queued' || key === 'pending') return 'warn'
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
 * （sessionName 是复活提示语）唯一的兜底来源。都没有才退回角色名。
 */
function titleOf(lineage, segment) {
  const segments = lineage.segments || []
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const own = taskTitle(segments[index]?.sessionName)
    if (own) return own
    const child = (segments[index]?.children || []).map((item) => taskTitle(item?.sessionName)).find(Boolean)
    if (child) return child
  }
  return String(lineage.agent || segment?.agent || '子代理')
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
  }
  for (const node of el.querySelectorAll('[data-tool]')) {
    const segment = findSegment(node.getAttribute('data-tool'))
    const next = segment ? toolText(segment, now) : ''
    if (node.textContent !== next) node.textContent = next
    // 空的时候整块收掉：否则 flex gap 会留一个空档
    node.style.display = next ? '' : 'none'
  }
  // 状态文字与点：结构不变，只换字和类。打字期间 run 结束时尤其重要——
  // 不重建 DOM（保焦点），但卡面不能还挂着「运行中」骗人
  for (const node of el.querySelectorAll('[data-state]')) {
    const segment = findSegment(node.getAttribute('data-state'))
    const state = segment?.state || 'unknown'
    const text = stateText(state)
    if (node.textContent !== text) node.textContent = text
    const cls = `state ${stateClass(state)}`
    if (node.className !== cls) node.className = cls
  }
  for (const node of el.querySelectorAll('[data-dot]')) {
    const segment = findSegment(node.getAttribute('data-dot'))
    const cls = `dot ${stateClass(segment?.state)}`
    if (node.className !== cls) node.className = cls
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

/** 回执文案：四种事实，全部来自扩展给的结果，不猜 */
function describeMail(mail, segment) {
  if (!mail) return null
  const kind = mail.kind === 'stop' ? 'stop' : 'note'
  if (!mail.confirmed) {
    const age = Date.now() - Number(mail.at || 0)
    if (age < RECEIPT_PATIENCE_MS) {
      return { text: kind === 'stop' ? '停止请求已发出…' : '正插进去…', tone: 'sent' }
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
  if (!mail.ok) return { text: mail.error || '这条没投进去', tone: 'bad' }
  if (kind === 'stop') return { text: `停止已受理 · ${fmtClock(mail.at)}`, tone: 'read' }
  if (mail.state === 'delivered') return { text: `已插进它这一轮 · ${fmtClock(mail.at)}`, tone: 'read' }
  // 停在 queued：扩展受理了，但还没走到回合边界。它要是先结束了，这条就永远进不去——
  // 别让卡片一直说「等它这一步结束」，那是在骗人（P2′）
  if (segment && !ACTIVE_STATES.has(String(segment.state))) {
    return { text: '已排队，但它先结束了 · 这条可能没进去', tone: 'warn' }
  }
  return { text: `已排队，等它这一步结束 · ${fmtClock(mail.at)}`, tone: 'sent' }
}

const CHIP_ICON = { read: '✓', bad: '✕', warn: '!', sent: '↑' }

function renderMailChip(segment) {
  const described = describeMail(mailFor(segment.runId), segment)
  if (!described) return ''
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
  if (segment.canSteer) {
    const open = noteDraft && String(noteDraft.runId) === String(segment.runId)
    acts.push(
      `<button class="primary${open ? ' on' : ''}" data-note="${runId}" aria-expanded="${open ? 'true' : 'false'}" title="${
        open ? '再点一次收起' : '给它当前这一轮插一句话'
      }">插话</button>`,
    )
  }
  const sessionFile = segment.childSessionFile || (segment.children || []).find((child) => child.sessionFile)?.sessionFile
  if (sessionFile) acts.push(`<button data-open-session="${esc(sessionFile)}" title="打开它的会话（只读预览）">打开</button>`)
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

/** 身份行：角色名 · run id 尾号 · 回合数。同角色并发时靠这一行分人 */
function renderIdent(lineage, segment, title) {
  const parts = []
  const agent = String(lineage.agent || segment.agent || '')
  if (agent && agent !== title) parts.push({ html: `<span class="who">${esc(agent)}</span>` })
  if (segment.runId) parts.push({ html: `<code>${esc(shortId(segment.runId))}</code>` })
  const turns = Number(segment.activity?.turnCount)
  if (Number.isFinite(turns) && turns > 0) parts.push({ html: `${turns} 回合` })
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

function renderMeta(segment) {
  const items = []
  const childCount = (segment.children || []).length
  if (childCount > 1) items.push(`<span>${childCount} 个子代理</span>`)
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
  const text = String(segment.summary || segment.error || '').trim()
  if (!text) return ''
  const bad = !segment.summary && Boolean(segment.error)
  return `<p class="summary${bad ? ' bad' : ''}" title="${esc(text)}">${esc(text)}</p>`
}

/**
 * 代际链 + 子代理明细：折成一行，点开才看。
 * 默认收起——卡面只留「现在」，历史不该抢位置。
 */
function renderGen(lineage, segment) {
  const segments = lineage.segments || []
  const earlier = segments.slice(0, -1)
  const children = segment.children || []
  if (!earlier.length && children.length < 2) return ''
  const open = genOpen.has(lineage.lineageRoot)
  const label = earlier.length ? `前 ${earlier.length} 段已折叠 · 共 ${segments.length} 段` : `子代理明细 · ${children.length} 个`
  const lines = []
  earlier.forEach((past, index) => {
    const text = `第 ${index + 1} 段 · ${stateText(past.state)} · ${timingOf(past, Date.now())}${
      past.summary ? ` · ${past.summary.slice(0, 60)}` : ''
    }`
    lines.push(
      past.childSessionFile
        ? `<button class="gen-line" data-open-session="${esc(past.childSessionFile)}">${esc(text)}<span class="chev">›</span></button>`
        : `<div class="gen-line">${esc(text)}</div>`,
    )
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

function renderCard(lineage, now) {
  const segments = lineage.segments || []
  const segment = segments[segments.length - 1] || {}
  const state = segment.state || lineage.state || 'unknown'
  const live = ACTIVE_STATES.has(String(state))
  const title = titleOf(lineage, segment)
  return `<article class="card${live ? ' live' : ''}">
    <div class="row1">
      <span class="dot ${esc(stateClass(state))}" data-dot="${esc(segment.runId)}"></span>
      <span class="agent" title="${esc(String(segment.sessionName || title))}">${esc(title)}</span>
      <span class="state ${esc(stateClass(state))}" data-state="${esc(segment.runId)}">${esc(stateText(state))}</span>
      ${timingSpan(segment)}
    </div>
    ${renderIdent(lineage, segment, title)}
    ${renderSummary(segment)}
    ${renderMeta(segment)}
    ${renderActs(segment)}
    ${renderNoteForm(segment)}
    ${renderMailChip(segment)}
    ${renderGen(lineage, segment)}
  </article>`
}

function renderBanner(degrade) {
  if (!degrade || degrade.kind === 'ok') return ''
  return `<div class="banner banner-${esc(degrade.tone || 'info')}">
    <strong>${esc(degrade.title)}</strong>
    <span>${esc(degrade.detail)}</span>
  </div>`
}

/** 顶部浮层：绝对定位，不占文档流，所以不会顶得内容往下跳 */
function renderNotice() {
  if (!notice) return ''
  const ttl = NOTICE_MS[notice.tone] ?? 4_000
  if (Date.now() - notice.at > ttl) {
    notice = null
    return ''
  }
  return `<div class="notice notice-${esc(notice.tone)}">${esc(notice.text)}</div>`
}

function render() {
  const now = Date.now()
  // 编辑插话时不重建：用户正在打字，画面一动就丢焦点，而且卡片位置会跳。
  // 但「展开表单」「切成发送中」这些是表单自己的状态变化，要放行一次。
  if (noteDraft && !paintOnce) {
    tickTimings()
    return
  }
  paintOnce = false
  if (stopConfirm && Date.now() >= stopConfirm.until) stopConfirm = null

  const data = snapshot
  if (lastError) {
    const html = `<div class="banner banner-error"><strong>面板读取失败</strong><span>${esc(lastError)}</span></div>`
    if (html !== lastHtml) el.innerHTML = html
    lastHtml = html
    return
  }
  if (!data) {
    const html = '<p class="pad dim">正在读取…</p>'
    if (html !== lastHtml) {
      el.innerHTML = html
      lastHtml = html
    }
    return
  }

  const lineages = data.lineages || []
  const active = Number(data.activeCount) || 0
  const previewing = Boolean(data.parentSessionFile)
  const back = previewing
    ? `<button class="back" data-open-session="${esc(data.parentSessionFile)}">← 主会话</button>`
    : ''

  const body = lineages.length
    ? lineages.map((lineage) => renderCard(lineage, now)).join('')
    : data.degrade?.kind === 'ok'
      ? `<div class="empty"><strong>这个会话还没有子代理运行记录</strong><span>派一个后台子代理，它跑起来就会出现在这里。</span></div>`
      : ''

  const html = `
    ${renderNotice()}
    <div class="head">
      ${back}
      <b>子代理</b>
      <span class="head-sub">· ${previewing ? '子会话预览' : '本会话'}</span>
      <span class="spacer"></span>
      <span class="count">${active ? `${active} 个在跑` : `${lineages.length} 个记录`}</span>
    </div>
    ${renderBanner(data.degrade)}
    ${body}
    <details class="diag"${diagOpen ? ' open' : ''}>
      <summary>诊断</summary>
      <dl>
        <dt>会话</dt><dd>${esc(data.sessionFile || '—')}</dd>
        <dt>数据文件</dt><dd>${esc(data.dataFile || '—')}</dd>
        <dt>数据源</dt><dd>${esc(
          data.source?.mode === 'push' ? '推送' : data.source?.mode === 'poll' ? '轮询' : '未连接',
        )}</dd>
        <dt>心跳</dt><dd>${data.liveness?.ageMs == null ? '—' : esc(fmtAge(data.liveness.ageMs))}</dd>
        <dt>能力</dt><dd>${esc((data.source?.capabilities || []).join(', ') || '—')}</dd>
        <dt>干预</dt><dd>${esc(
          data.source?.supports
            ? `插话 ${data.source.supports.steer ? '可用' : '不支持'} · 停止 ${data.source.supports.stop ? '可用' : '不支持'}`
            : '—（扩展未公告）',
        )}</dd>
        <dt>事件</dt><dd>${esc((data.source?.events || []).join(', ') || '—')}</dd>
        <dt>最近错误</dt><dd>${esc(data.source?.lastError || '—')}</dd>
      </dl>
    </details>
  `
  if (html !== lastHtml) {
    const scrollTop = el.scrollTop
    el.innerHTML = html
    el.scrollTop = scrollTop
    lastHtml = html
  }
  // 结构没变也要推一次：新插入的计时占位是空的
  tickTimings()
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
    void tick()
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
  void tick()
}

/**
 * 打开一段会话（宿主二分：主会话激活、子会话只读预览）。
 *
 * 走宿主 `sessions.activate`：目标在当前工作区侧栏就正常激活——「返回主会话」
 * 时用户拿到的是可写对话；子会话不在侧栏，退化为只读预览（观测层不指挥会话）。
 * 失败是常态（一次性 run 的会话会被清理），所以文案说清原因，而不是静默。
 * @param {string} sessionFile
 */
async function openSession(sessionFile) {
  try {
    const result = await bridge.invoke('openSession', { sessionFile })
    if (!result?.ok) setNotice('会话文件已不存在，可能已被清理', 'warn')
  } catch (error) {
    setNotice(`打开失败：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  render()
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

async function tick() {
  if (busy) return
  busy = true
  try {
    const sessionFile = String(context?.sessionFile || '')
    snapshot = await bridge.invoke('getState', { sessionFile })
    lastError = ''
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  } finally {
    busy = false
    render()
  }
}

bridge.on('context', (next) => {
  context = next || {}
  snapshot = null
  lastHtml = ''
  // 换会话了，正在编辑的插话指向的 run 已经不在这个会话里——留着只会发错地方
  noteDraft = null
  stopConfirm = null
  sentNotes.length = 0
  genOpen.clear()
  void tick()
})
bridge.on('dispose', () => {
  if (timer) clearInterval(timer)
  noteDraft = null
})

let timer = null
// 1s 一次：拿不到新数据时也要让计时和「未确认」的措辞往前走
timer = setInterval(() => {
  if (!busy) void tick()
}, 1000)
void tick()
