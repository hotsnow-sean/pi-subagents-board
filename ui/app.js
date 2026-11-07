/*
 * 子代理面板（P2-a：只读）。
 *
 * 这一版只证明「数据通了」：谁在跑、跑到哪、什么时候结束、这份数据能不能信。
 * 干预（steer/stop）与信箱是 P2-c。
 *
 * 两条硬约束来自 P0 的实测教训：
 *   1. 面板每秒轮询，整块 DOM 会重建——**所有操作结果都必须存成变量**再渲染，
 *      只写一次 DOM 的东西会在下一帧消失（探针那次「点了没结果框」就是这么来的）。
 *   2. 看不到数据时不能只显示空白：降级原因（未连上 / 陈旧 / 无记录）必须写出来，
 *      否则用户分不清「没跑」和「插件坏了」。
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
  if (!children.length) return ''
  return `<ul class="children">${children
    .map(
      (child) => `<li>
        <span class="dot dot-${esc(child.state || 'unknown')}"></span>
        <span class="child-agent">${esc(child.agent || '子代理')}</span>
        ${child.model ? `<span class="muted">${esc(child.model)}</span>` : ''}
        ${child.thinking ? `<span class="muted">thinking·${esc(child.thinking)}</span>` : ''}
        <span class="muted">${esc(STATE_TEXT[child.state] || child.state || '')}</span>
        ${child.lastActivityAt ? `<span class="muted">${esc(fmtAge(now - child.lastActivityAt))}</span>` : ''}
      </li>`,
    )
    .join('')}</ul>`
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

  el.innerHTML = `
    <div class="head">
      <span class="title">子代理</span>
      ${active ? `<span class="count">${active} 个在跑</span>` : ''}
      <span class="spacer"></span>
      <span class="muted" title="数据源">${esc(modeText)}</span>
    </div>
    ${renderBanner(data.degrade)}
    ${lineages.length ? lineages.map((lineage) => renderLineage(lineage, now)).join('') : data.degrade?.kind === 'ok' ? '<p class="muted pad">这个会话最近没有子代理运行。</p>' : ''}
    <details class="diag">
      <summary>诊断</summary>
      <dl>
        <dt>会话</dt><dd>${esc(data.sessionFile || '—')}</dd>
        <dt>数据文件</dt><dd>${esc(data.dataFile || '—')}</dd>
        <dt>心跳</dt><dd>${data.liveness?.ageMs == null ? '—' : esc(fmtAge(data.liveness.ageMs))}</dd>
        <dt>能力</dt><dd>${esc((data.source?.capabilities || []).join(', ') || '—')}</dd>
        <dt>事件</dt><dd>${esc((data.source?.events || []).join(', ') || '—')}</dd>
        <dt>最近错误</dt><dd>${esc(data.source?.lastError || '—')}</dd>
      </dl>
    </details>
  `
  el.scrollTop = scrollTop

  for (const button of el.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => {
      const root = button.getAttribute('data-open')
      if (!root) return
      if (expanded.has(root)) expanded.delete(root)
      else expanded.add(root)
      render()
    })
  }
}

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
  void tick()
})
bridge.on('dispose', () => {
  if (timer) clearInterval(timer)
})

let timer = null
timer = setInterval(() => void tick(), 1000)
void tick()
