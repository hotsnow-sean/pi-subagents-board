/*
 * 子代理面板。
 *
 * P2-a 打通数据，P2-b 加「打开会话 + 信箱」，P2-c 加干预（steer / stop）。
 *
 * 三条硬约束来自实测教训：
 *   1. 面板每秒轮询，整块 DOM 会重建——**所有操作结果都必须存成变量**再渲染，
 *      只写一次 DOM 的东西会在下一帧消失（探针那次「点了没结果框」就是这么来的）。
 *   2. 输入框**不能放进每秒重建的容器里**：用户每打一个字就被重建一次，焦点与光标全丢。
 *      所以干预坞是 body 下独立的 #dock，只在它自己的状态变化时重绘。
 *   3. 看不到数据时不能只显示空白：降级原因（未连上 / 陈旧 / 无记录）必须写出来，
 *      否则用户分不清「没跑」和「插件坏了」。
 */

const bridge = window.pi || {
  invoke: () => Promise.reject(new Error('插件桥未加载')),
  on: () => () => {},
  context: {},
}

const el = document.getElementById('app')
const dockEl = document.getElementById('dock')

/** 面板上下文里的会话路径：宿主会在切换会话时推新的 */
let context = bridge.context || {}
/** 最后一次成功拿到的状态 */
let snapshot = null
/** 最后一次失败原因（invoke 抛错 / 桥超时） */
let lastError = ''
let busy = false
/** 用户手动展开的链（按 lineageRoot 记），重绘后恢复 */
const expanded = new Set()
/** 诊断折叠区的展开状态：每秒整块重绘会把它拍回去，必须自己记 */
let diagOpen = false
/** 最近一次「打开子会话」的结果；同样要活过重绘 */
let actionResult = /** @type {{ text: string, tone: string } | null} */ (null)
let actionTimer = /** @type {any} */ (null)

/**
 * 写动作结果。成功类给 autoHideMs 就自动消失——横幅常驻的话，用户点完一次，
 * 往后每秒重绘都带着一条过时的「已打开」，比没有更吵（实测反馈）。
 * 失败/警告常驻：错误信息需要时间读。
 */
function setActionResult(result, autoHideMs = 0) {
  actionResult = result
  if (actionTimer) {
    clearTimeout(actionTimer)
    actionTimer = null
  }
  if (result && autoHideMs > 0) {
    actionTimer = setTimeout(() => {
      actionResult = null
      actionTimer = null
      render()
    }, autoHideMs)
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes >= 60) return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function fmtAge(ms) {
  const value = Number(ms) || 0
  if (value < 1000) return '刚刚'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.floor(minutes / 60)} 小时前`
}

const STATE_TEXT = {
  running: '进行中',
  queued: '排队中',
  stopping: '停止中',
  complete: '已完成',
  failed: '失败',
  partial: '部分完成',
  stopped: '已停止',
  paused: '已暂停',
  rejected: '被拒绝',
  unknown: '未知',
}

function statePill(state) {
  const key = String(state || 'unknown')
  return `<span class="pill pill-${esc(key)}">${esc(STATE_TEXT[key] || key)}</span>`
}

/** 段的时间信息：进行中看「从现在倒推」，终态看耗时 */
function segmentTiming(segment, now) {
  if (segment.durationMs) return fmtDuration(segment.durationMs)
  const start = Number(segment.startedAt) || 0
  const end = Number(segment.endedAt) || (segment.state === 'running' ? now : 0)
  if (!start || !end) return ''
  return fmtDuration(end - start)
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

/**
 * 干预入口。**只在 canSteer / canStop 为真时出现**——这两个字段是数据层算的，
 * 前台 run（没有 async id）和已终态段不会出现按钮，用户不会先点再被报错。
 */
function renderActions(segment) {
  if (!segment.canSteer && !segment.canStop) return ''
  return `<div class="actions">
    ${segment.canSteer ? `<button class="act" data-steer="${esc(segment.runId)}">插话…</button>` : ''}
    ${segment.canStop ? `<button class="act act-danger" data-stop="${esc(segment.runId)}">停止</button>` : ''}
  </div>`
}

function renderSegment(segment, now, isLast) {
  const timing = segmentTiming(segment, now)
  const summary = segment.summary ? `<p class="summary">${esc(segment.summary.slice(0, 240))}${segment.summary.length > 240 ? '…' : ''}</p>` : ''
  const tokens = segment.tokens?.total ? `<span class="muted">${esc(segment.tokens.total)} tok</span>` : ''
  const cost = Number.isFinite(segment.costUsd) ? `<span class="muted">$${segment.costUsd.toFixed(4)}</span>` : ''
  return `<div class="segment ${isLast ? 'segment-last' : ''}">
    <div class="segment-head">
      ${statePill(segment.state)}
      <span class="muted">${esc(timing)}</span>
      ${tokens}
      ${cost}
      ${segment.origin === 'status' ? '<span class="muted" title="插件在这个 run 开始之后才起来，只看到它的当前状态">中途接入</span>' : ''}
    </div>
    ${renderChildren(segment, now)}
    ${summary}
    ${renderActions(segment)}
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
    ? `<div class="history">${earlier.map((segment, index) => renderSegment(segment, now, false)).join('')}</div>`
    : ''

  return `<article class="card card-${esc(lineage.state || 'unknown')}">
    <header class="card-head">
      <span class="dot dot-${esc(lineage.state || 'unknown')}"></span>
      <span class="agent">${esc(lineage.agent || '子代理')}</span>
      ${statePill(lineage.state)}
      <span class="spacer"></span>
      <span class="muted">${esc(segmentTiming(last, now))}</span>
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

/** 动作结果横幅：只读预览能不能打开，用户必须当场知道，不能一闪就没 */
function renderActionResult() {
  if (!actionResult) return ''
  return `<div class="result result-${esc(actionResult.tone)}">${esc(actionResult.text)}</div>`
}

/* ---------- 干预坞（steer / stop） ---------- */

/**
 * 干预坞状态。**整个面板只有这一个**：打开插话就替换现有的。
 * `busy` 期间的输入不做拦截——用户可能会继续打字，重绘时用 dock.message 回填。
 */
let dock = /** @type {any} */ (null)

/** @param {string} runId */
function findRun(runId) {
  for (const lineage of snapshot?.lineages || []) {
    for (const segment of lineage.segments || []) {
      if (segment.runId === runId) return { segment, agent: lineage.agent }
    }
  }
  return null
}

/**
 * @param {'steer' | 'stop'} kind
 * @param {string} runId
 */
function openDock(kind, runId) {
  const found = findRun(runId)
  dock = {
    kind,
    runId,
    // ownerSessionKey 而不是 sessionKey：预览子会话时链属于父会话，
    // 命令必须发给「跑着这条链的那个进程」，否则永远等不到回执
    sessionKey: String(snapshot?.ownerSessionKey || ''),
    agent: found?.agent || found?.segment?.agent || '',
    message: '',
    mode: 'steer',
    busy: false,
    result: null,
  }
  renderDock()
  if (kind === 'steer') {
    const input = dockEl.querySelector('textarea')
    if (input) input.focus()
  }
}

function closeDock() {
  dock = null
  renderDock()
}

/** 回执文案：`delivered` 与 `queued` 必须分开说（计划 §5.7） */
function describeIntervention(action, result) {
  if (!result?.ok) {
    return { text: result?.error?.message || '没能送到，请重试', tone: 'error' }
  }
  const receipt = result.receipt || {}
  if (action === 'stop') {
    return receipt.state === 'stopping'
      ? { text: '已受理停止：正在等它收尾，状态会自己收敛（不是立刻变「已停止」）', tone: 'ok' }
      : { text: '已受理停止', tone: 'ok' }
  }
  if (receipt.deliveryStatus === 'delivered') return { text: '已送达：子代理这一轮就能看到', tone: 'ok' }
  if (receipt.deliveryStatus === 'queued') return { text: '已排队：子代理这一轮结束后才会看到', tone: 'warn' }
  return { text: '已受理（扩展没给送达状态，别当作它已经看到）', tone: 'warn' }
}

function renderDock() {
  if (!dock) {
    dockEl.hidden = true
    dockEl.innerHTML = ''
    return
  }
  const who = `<span class="who">${esc(dock.agent || '子代理')}</span>`
  const result = dock.result
    ? `<div class="dock-result dock-result-${esc(dock.result.tone)}">${esc(dock.result.text)}</div>`
    : ''

  if (dock.kind === 'steer') {
    dockEl.innerHTML = `
      <div class="dock-head">${who}<span class="muted">插话</span><span class="spacer"></span></div>
      <textarea data-dock-message placeholder="说一句，子代理会照着调整方向" ${dock.busy ? 'disabled' : ''}>${esc(dock.message)}</textarea>
      <div class="dock-row">
        <select data-dock-mode ${dock.busy ? 'disabled' : ''}>
          <option value="steer"${dock.mode === 'steer' ? ' selected' : ''}>立刻插话</option>
          <option value="follow_up"${dock.mode === 'follow_up' ? ' selected' : ''}>本轮结束后再说</option>
        </select>
        <span class="spacer"></span>
        <button class="act" data-dock-cancel>取消</button>
        <button class="act act-primary" data-dock-send ${dock.busy ? 'disabled' : ''}>${dock.busy ? '发送中…' : '发送'}</button>
      </div>
      ${result}`
  } else {
    dockEl.innerHTML = `
      <div class="dock-head">${who}<span class="muted">停止</span><span class="spacer"></span></div>
      <p class="dock-note">停止后这一段不能继续（扩展明确：stopped 不能 resume），只能重新派一个。</p>
      <div class="dock-row">
        <span class="spacer"></span>
        <button class="act" data-dock-cancel>取消</button>
        <button class="act act-danger" data-dock-confirm ${dock.busy ? 'disabled' : ''}>${dock.busy ? '停止中…' : '确认停止'}</button>
      </div>
      ${result}`
  }
  dockEl.hidden = false
}

async function submitDock() {
  if (!dock || dock.busy) return
  const action = dock.kind === 'steer' ? 'steer' : 'stop'
  if (action === 'steer' && !dock.message.trim()) {
    dock.result = { text: '说点什么再发', tone: 'warn' }
    renderDock()
    return
  }
  if (!dock.sessionKey) {
    dock.result = { text: '拿不到会话标识，先切回主会话再试', tone: 'error' }
    renderDock()
    return
  }
  dock.busy = true
  dock.result = { text: '发送中…', tone: 'info' }
  renderDock()
  try {
    /** @type {any} */
    const payload = { sessionKey: dock.sessionKey, runId: dock.runId }
    if (action === 'steer') {
      payload.message = dock.message.trim()
      payload.mode = dock.mode
    }
    const result = await bridge.invoke(action, payload)
    dock.busy = false
    dock.result = describeIntervention(action, result)
    if (result?.ok && action === 'steer') dock.message = ''
  } catch (error) {
    dock.busy = false
    dock.result = { text: `发送失败：${error instanceof Error ? error.message : String(error)}`, tone: 'error' }
  }
  renderDock()
  // 干预后立刻拉一次：stop 的「stopping」到终态要靠 status 收敛，别让用户盯着不动的卡
  void tick()
}

// 坞自己的监听器挂一次：它不重绘 innerHTML 之外的东西，所以不会丢。
dockEl.addEventListener('input', (/** @type {InputEvent} */ event) => {
  const target = /** @type {HTMLTextAreaElement} */ (event.target)
  if (dock && target.matches?.('[data-dock-message]')) dock.message = target.value
})
dockEl.addEventListener('change', (/** @type {Event} */ event) => {
  const target = /** @type {HTMLSelectElement} */ (event.target)
  if (dock && target.matches?.('[data-dock-mode]')) dock.mode = target.value
})
dockEl.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void submitDock()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDock()
  }
})
dockEl.addEventListener('click', (/** @type {MouseEvent} */ event) => {
  const target = /** @type {HTMLElement} */ (event.target)
  if (!target?.closest) return
  if (target.closest('[data-dock-cancel]')) {
    closeDock()
    return
  }
  if (target.closest('[data-dock-send]') || target.closest('[data-dock-confirm]')) void submitDock()
})

/**
 * 打开一段会话（宿主二分：主会话激活、子会话只读预览）。
 *
 * 走宿主 `sessions.activate`：目标在当前工作区侧栏就正常激活——「返回主会话」
 * 时用户拿到的是可写对话；子会话不在侧栏，退化为只读预览（观测层不指挥会话）。
 * 失败是常态（一次性 run 的会话会被清理），所以文案说清原因，而不是静默。
 * @param {string} sessionFile
 */
async function openSession(sessionFile) {
  setActionResult({ text: '正在打开…', tone: 'info' })
  render()
  try {
    const result = await bridge.invoke('openSession', { sessionFile })
    if (result?.ok) setActionResult({ text: '已打开', tone: 'ok' }, 6_000)
    else setActionResult({ text: '会话文件已不存在，可能已被清理', tone: 'warn' })
  } catch (error) {
    setActionResult({ text: `打开失败：${error instanceof Error ? error.message : String(error)}`, tone: 'error' })
  }
  render()
}

function render() {
  const now = Date.now()
  const scrollTop = el.scrollTop
  const data = snapshot

  if (lastError) {
    el.innerHTML = `<div class="banner banner-error"><strong>面板读取失败</strong><p>${esc(lastError)}</p></div>`
    return
  }
  if (!data) {
    el.innerHTML = '<p class="muted pad">正在读取…</p>'
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

  el.innerHTML = `
    <div class="head">
      <span class="title">子代理</span>
      ${active ? `<span class="count">${active} 个在跑</span>` : ''}
      <span class="spacer"></span>
      <span class="muted" title="数据源">${esc(modeText)}</span>
    </div>
    ${back}
    ${renderBanner(data.degrade)}
    ${renderActionResult()}
    ${lineages.length ? lineages.map((lineage) => renderLineage(lineage, now)).join('') : data.degrade?.kind === 'ok' ? '<p class="muted pad">这个会话最近没有子代理运行。</p>' : ''}
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
  el.scrollTop = scrollTop
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
el.addEventListener('click', (/** @type {MouseEvent} */ event) => {
  const target = /** @type {HTMLElement} */ (event.target)
  const steerButton = /** @type {HTMLElement | null} */ (target?.closest?.('[data-steer]'))
  if (steerButton) {
    const runId = steerButton.getAttribute('data-steer')
    if (runId) openDock('steer', runId)
    return
  }
  const stopButton = /** @type {HTMLElement | null} */ (target?.closest?.('[data-stop]'))
  if (stopButton) {
    const runId = stopButton.getAttribute('data-stop')
    if (runId) openDock('stop', runId)
    return
  }
  const sessionButton = /** @type {HTMLElement | null} */ (target?.closest?.('[data-open-session]'))
  if (sessionButton) {
    const file = sessionButton.getAttribute('data-open-session')
    if (file) void openSession(file)
    return
  }
  const button = /** @type {HTMLElement | null} */ (target?.closest?.('[data-open]'))
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
  // 换会话了，坞里那条命令指向的 run 已经不在这个会话里——留着只会发错地方
  closeDock()
  void tick()
})
bridge.on('dispose', () => {
  if (timer) clearInterval(timer)
  if (actionTimer) clearTimeout(actionTimer)
  dock = null
})

let timer = null
timer = setInterval(() => void tick(), 1000)
void tick()
