/*
 * 子代理面板。
 *
 * 观测 + 两件事：插话（对某个 run 发一次 steer）、停止一个 run。
 *
 * 交互形态定为「A · 卡片内联」：
 *   - 插话入口在卡片上，点了就地展开一个小表单，提交后收起、原地留一行回执。
 *     没有常驻输入坞 —— 那玩意儿既占版面，又永远说不清「我现在说的是谁」。
 *   - 停止不占输入区：按钮就地变「确认停止」，3 秒不点自动退回。
 *   - 不再有绿色/结果横幅：它会顶得内容往下跳（U4）。
 *
 * 渲染策略（这是「位置突变」的总根源）：
 *   1. **计时数字单独更新**：卡片 HTML 里只放 `<span data-timing>`，每秒用 textContent
 *      改那一个数字，不重建 DOM。否则整块 innerHTML 每秒重来一次，选区、焦点、动画全丢。
 *   2. **HTML 没变就不碰 DOM**：`lastHtml` 比对，相等直接返回。
 *   3. **编辑插话时暂停重绘**：用户正在打字的那几秒，画面不该动；提交/取消后再同步。
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
/** 用户手动展开的链（按 lineageRoot 记），重绘后恢复 */
const expanded = new Set()
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

const STATE_TEXT = {
  running: '运行中',
  complete: '已完成',
  failed: '失败',
  error: '出错',
  stopped: '已停止',
  stopping: '正在停止',
  timeout: '超时',
  cancelled: '已取消',
  queued: '排队中',
  pending: '等待中',
  unknown: '状态未知',
}

function statePill(state) {
  const key = String(state || 'unknown')
  return `<span class="pill pill-${esc(key)}">${esc(STATE_TEXT[key] || key)}</span>`
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
 * 计时占位：内容先渲染一次，之后由 `tickTimings` 单独改 textContent。
 * key 用 runId —— 同一段在页面上的身份就是它。
 */
function timingSpan(segment, now) {
  const id = String(segment.runId || '')
  return `<span class="muted timing" data-timing="${esc(id)}">${esc(timingOf(segment, now))}</span>`
}

function findSegment(runId) {
  for (const lineage of snapshot?.lineages || []) {
    for (const segment of lineage.segments || []) {
      if (String(segment.runId) === String(runId)) return segment
    }
  }
  return null
}

/** 每秒只改这几个数字，不动结构 */
function tickTimings() {
  const now = Date.now()
  for (const node of el.querySelectorAll('[data-timing]')) {
    const segment = findSegment(node.getAttribute('data-timing'))
    const next = segment ? timingOf(segment, now) : ''
    if (node.textContent !== next) node.textContent = next
  }
}

function renderChildren(segment, now) {
  const children = segment.children || []
  if (!children.length) {
    // 没有 children 明细（status 中途接入的段）：只要能推导出子会话路径，就给一个卡级入口
    return segment.childSessionFile
      ? `<button class="open-session" data-open-session="${esc(segment.childSessionFile)}">打开子会话 <span class="chev">›</span></button>`
      : ''
  }
  return `<ul class="children">${children
    .map((child) => {
      const inner = `
        <span class="dot dot-${esc(child.state || 'unknown')}"></span>
        <span class="child-agent">${esc(child.agent || '子代理')}</span>
        ${child.model ? `<span class="muted">${esc(child.model)}</span>` : ''}
        ${child.thinking ? `<span class="muted">thinking·${esc(child.thinking)}</span>` : ''}
        <span class="muted">${esc(STATE_TEXT[child.state] || child.state || '')}</span>
        ${child.lastActivityAt ? `<span class="muted">${esc(fmtAge(now - child.lastActivityAt))}</span>` : ''}`
      // 有子会话路径才能点：路径来自 async-complete 的 results，后台 run 派发即返回时可能没有
      return child.sessionFile
        ? `<li><button class="child-btn" data-open-session="${esc(child.sessionFile)}" title="只读预览这段子会话">${inner}<span class="chev">›</span></button></li>`
        : `<li>${inner}</li>`
    })
    .join('')}</ul>`
}

/* ---------- 插话（A 方案：卡片内联） ---------- */

/** 这个 run 上最近一条投递回执：先看 agent 写的，再看本地「已发出待确认」 */
function mailFor(runId) {
  const id = String(runId ?? '')
  if (!id) return null
  const confirmed = (snapshot?.mail || []).find((item) => String(item.runId) === id)
  if (confirmed) return { confirmed: true, ...confirmed }
  const pending = sentNotes.filter((item) => item.runId === id).sort((a, b) => b.at - a.at)[0]
  return pending ? { confirmed: false, ...pending } : null
}

/** 回执文案：四种事实，全部来自扩展给的结果，不猜 */
function describeMail(mail) {
  if (!mail) return null
  const kind = mail.kind === 'stop' ? 'stop' : 'note'
  if (!mail.confirmed) {
    const age = Date.now() - Number(mail.at || 0)
    if (age < RECEIPT_PATIENCE_MS) {
      return { text: kind === 'stop' ? '停止请求已发出…' : '正在投递给子代理…', tone: 'waiting' }
    }
    return {
      text:
        kind === 'stop'
          ? '停止请求已发出，但没等到确认（父会话进程可能不在）'
          : '已发出，但没等到确认（父会话进程可能不在）',
      tone: 'warn',
    }
  }
  if (mail.state === 'expired') return { text: '这条没投出去：已经过期了', tone: 'warn' }
  if (!mail.ok) return { text: mail.error || '投递失败', tone: 'error' }
  if (kind === 'stop') return { text: `已受理停止 · ${fmtClock(mail.at)}`, tone: 'ok' }
  if (mail.state === 'delivered') return { text: `已插进子代理这一轮 · ${fmtClock(mail.at)}`, tone: 'ok' }
  return { text: `已排队，等它这一步结束 · ${fmtClock(mail.at)}`, tone: 'ok' }
}

function renderMailLine(segment) {
  const described = describeMail(mailFor(segment.runId))
  if (!described) return ''
  return `<p class="mail-line mail-${esc(described.tone)}">${esc(described.text)}</p>`
}

/**
 * 插话表单。**只在编辑这一个 run 时出现**，提交即收起。
 * 编辑期间 render 会整体跳过（见 render 开头），所以这里的 textarea 不会被重建。
 */
function renderNoteForm(segment) {
  if (!noteDraft || String(noteDraft.runId) !== String(segment.runId)) return ''
  const busyAttr = noteDraft.busy ? ' disabled' : ''
  return `<div class="note-form">
    <textarea data-note-input rows="2" placeholder="对 ${esc(noteDraft.agent || '这个子代理')} 说一句（Enter 发送，Shift+Enter 换行）"${busyAttr}>${esc(noteDraft.text)}</textarea>
    <div class="note-row">
      <span class="note-hint">插进它当前这一轮</span>
      <span class="spacer"></span>
      <button class="act" data-note-cancel${busyAttr}>取消</button>
      <button class="act act-primary" data-note-send${busyAttr}>${noteDraft.busy ? '发送中…' : '发送'}</button>
    </div>
    ${noteDraft.error ? `<p class="mail-line mail-error">${esc(noteDraft.error)}</p>` : ''}
  </div>`
}

/**
 * 干预入口。**只在 canSteer / canStop 为真时出现**——这两个字段是数据层算的，
 * 前台 run（没有 async id）和已终态段不会出现按钮，用户不会先点再被报错。
 */
function renderActions(segment) {
  const runId = esc(segment.runId)
  const acts = []
  if (segment.canSteer) {
    acts.push(`<button class="act" data-note="${runId}">插话…</button>`)
  }
  if (segment.canStop) {
    const confirming = stopConfirm && String(stopConfirm.runId) === String(segment.runId) && Date.now() < stopConfirm.until
    if (confirming) {
      acts.push(`<button class="act act-danger" data-stop-confirm="${runId}">确认停止</button>`)
      acts.push('<button class="act" data-stop-cancel>取消</button>')
    } else {
      acts.push(`<button class="act act-danger" data-stop="${runId}">停止</button>`)
    }
  }
  return acts.length ? `<div class="actions">${acts.join('')}</div>` : ''
}

function renderSegment(segment, now, isLast) {
  const summary = segment.summary
    ? `<p class="summary">${esc(segment.summary.slice(0, 240))}${segment.summary.length > 240 ? '…' : ''}</p>`
    : ''
  const tokens = segment.tokens?.total ? `<span class="muted">${esc(segment.tokens.total)} tok</span>` : ''
  const cost = Number.isFinite(segment.costUsd) ? `<span class="muted">$${segment.costUsd.toFixed(4)}</span>` : ''
  return `<div class="segment ${isLast ? 'segment-last' : ''}">
    <div class="segment-head">
      ${statePill(segment.state)}
      ${timingSpan(segment, now)}
      ${tokens}
      ${cost}
      ${segment.origin === 'status' ? '<span class="muted" title="插件在这个 run 开始之后才起来，只看到它的当前状态">中途接入</span>' : ''}
    </div>
    ${renderChildren(segment, now)}
    ${summary}
    ${renderActions(segment)}
    ${renderNoteForm(segment)}
    ${renderMailLine(segment)}
  </div>`
}

function renderLineage(lineage, now) {
  const segments = lineage.segments || []
  const last = segments[segments.length - 1] || {}
  const isOpen = expanded.has(lineage.lineageRoot)
  const earlier = segments.slice(0, -1)
  const reviveLine =
    earlier.length > 0
      ? `<button class="link" data-open="${esc(lineage.lineageRoot)}">已从第 ${earlier.length} 段继续 · 累计 ${esc(
          fmtDuration(segments.reduce((sum, s) => sum + (s.durationMs || 0), 0)),
        )}</button>`
      : ''
  const history = isOpen && earlier.length
    ? `<div class="history">${earlier.map((segment) => renderSegment(segment, now, false)).join('')}</div>`
    : ''

  return `<article class="card card-${esc(lineage.state || 'unknown')}">
    <header class="card-head">
      <span class="dot dot-${esc(lineage.state || 'unknown')}"></span>
      <span class="agent">${esc(lineage.agent || '子代理')}</span>
      ${statePill(lineage.state)}
    </header>
    ${renderSegment(last, now, true)}
    ${reviveLine}
    ${history}
    ${lineage.cwd ? `<p class="path" title="${esc(lineage.cwd)}">${esc(lineage.cwd)}</p>` : ''}
  </article>`
}

function renderBanner(degrade) {
  if (!degrade || degrade.kind === 'ok') return ''
  return `<div class="banner banner-${esc(degrade.tone || 'info')}">
    <strong>${esc(degrade.title)}</strong>
    <p>${esc(degrade.detail)}</p>
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
  if (stopConfirm && Date.now() >= stopConfirm.until) {
    stopConfirm = null
  }

  const data = snapshot
  if (lastError) {
    const html = `<div class="banner banner-error"><strong>面板读取失败</strong><p>${esc(lastError)}</p></div>`
    if (html !== lastHtml) el.innerHTML = html
    lastHtml = html
    return
  }
  if (!data) {
    if (lastHtml !== '<p class="muted pad">正在读取…</p>') {
      el.innerHTML = '<p class="muted pad">正在读取…</p>'
      lastHtml = '<p class="muted pad">正在读取…</p>'
    }
    return
  }

  const lineages = data.lineages || []
  const active = Number(data.activeCount) || 0
  const modeText =
    data.source?.mode === 'push' ? '推送' : data.source?.mode === 'poll' ? '轮询' : data.source ? '未连接' : '—'
  // 当前视图是子会话的只读预览：给一条一眼能找到的回去路（宿主会正常激活主会话，可写）
  const back = data.parentSessionFile
    ? `<button class="back-link" data-open-session="${esc(data.parentSessionFile)}">← 返回主会话</button>`
    : ''

  const body = lineages.length
    ? lineages.map((lineage) => renderLineage(lineage, now)).join('')
    : data.degrade?.kind === 'ok'
      ? '<p class="muted pad">这个会话最近没有子代理运行。</p>'
      : ''

  const html = `
    ${renderNotice()}
    <div class="head">
      <span class="title">子代理</span>
      ${active ? `<span class="count">${active} 个在跑</span>` : ''}
      <span class="spacer"></span>
      <span class="muted" title="数据源">${esc(modeText)}</span>
    </div>
    ${back}
    ${renderBanner(data.degrade)}
    ${body}
    <details class="diag"${diagOpen ? ' open' : ''}>
      <summary>诊断</summary>
      <dl>
        <dt>会话</dt><dd>${esc(data.sessionFile || '—')}</dd>
        <dt>数据文件</dt><dd>${esc(data.dataFile || '—')}</dd>
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
  } else {
    // 结构没变，只把计时数字推到当前值
    tickTimings()
  }
}

/* ---------- 操作 ---------- */

function openNote(runId) {
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

function closeNote() {
  noteDraft = null
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
// toggle 不冒泡但捕获阶段能到达：details 每次重建后状态由 diagOpen 恢复，
// 用户点击 summary → 浏览器切 open → toggle 事件更新 diagOpen → 下一帧重绘不丢。
el.addEventListener(
  'toggle',
  (/** @type {Event} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target)
    if (target instanceof HTMLDetailsElement && target.classList.contains('diag')) diagOpen = target.open
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
    if (runId) openNote(runId)
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
    return
  }
  const button = /** @type {HTMLElement | null} */ (target.closest('[data-open]'))
  if (!button) return
  const root = button.getAttribute('data-open')
  if (!root) return
  if (expanded.has(root)) expanded.delete(root)
  else expanded.add(root)
  render()
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
