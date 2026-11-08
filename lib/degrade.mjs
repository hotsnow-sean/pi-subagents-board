// @ts-check
/**
 * 降级判定（纯函数）。
 *
 * 面板最怕的不是「没有数据」，而是**有数据但不知道它是死的**：用户盯着一张
 * 永远停在 3 分钟前的卡，会以为子代理卡住了。所以「能不能信这份数据」必须
 * 单独算出来、单独显示，而且文案要说清下一步能做什么。
 *
 * 五种状态（计划 §5.8）：
 *   ok             RPC 推送模式，数据新鲜
 *   poll           握手超时后的轮询模式（能看，但慢）
 *   rpc-unavailable 握手一直没成功：pi-subagents 没装 / 版本不对 / 还没就绪
 *   stale          数据超过 30s 没更新：worker 已退出或换代
 *   no-data        这个会话还没有 live 文件（没派过子代理，或 worker 还没起来）
 */

/**
 * @param {any} state live 状态（可为 null）
 * @param {{ alive: boolean, ageMs: number | null }} liveness
 * @param {number} [now]
 */
export function describeDegrade(state, liveness, now = Date.now()) {
  if (!state) {
    return {
      kind: 'no-data',
      tone: 'info',
      // 空态而不是警示：没数据是**正常状态**（还没派过子代理），不该用横幅去喊。
      // 渲染层据此画虚线空态框，与「后台任务」面板的空列表同一套语言。
      asEmpty: true,
      title: '还没有子代理运行记录',
      detail: '派过子代理之后，这里会显示它们的状态。',
      // 第二行更淡的小字：不是「该怎么用」，而是「看着不对时可能是什么原因」。
      // 拆开写是为了断行自然——挤成一句会在窄面板里从中间断掉。
      hint: '刚派过仍为空，可能是这个会话的 worker 还没起来。',
    }
  }

  const source = state.source ?? {}
  const handshake = source.handshake ?? {}
  const mode = String(source.mode ?? 'none')

  if (mode === 'none' && !source.rpc) {
    const attempts = Number(handshake.attempts) || 0
    const error = handshake.lastError ? String(handshake.lastError) : ''
    return {
      kind: 'rpc-unavailable',
      tone: 'warn',
      title: '未连上 pi-subagents',
      detail: error
        ? `已尝试 ${attempts} 次握手：${error}。请确认宿主里已安装并启用 pi-subagents；扩展未就绪时这里会一直重试。`
        : `已尝试 ${attempts} 次握手但没收到回复。请确认宿主里已安装并启用 pi-subagents；扩展未就绪时这里会一直重试。`,
    }
  }

  if (!liveness.alive) {
    const age = liveness.ageMs
    return {
      kind: 'stale',
      tone: 'warn',
      title: '数据已停止更新',
      detail:
        age === null
          ? '这份快照没有心跳时间，可能来自旧版本的插件。'
          : `最后一次更新在 ${formatAge(age)} 前，写这份数据的会话进程可能已退出。下面是它退出前的样子。`,
    }
  }

  if (mode === 'poll') {
    return {
      kind: 'poll',
      tone: 'info',
      title: '轮询模式',
      detail: '实时推送不可用，正在每 2 秒读一次状态。数据会稍慢一拍，但内容完整。',
    }
  }

  return { kind: 'ok', tone: 'ok', title: '', detail: '' }
}

/** @param {number} ms */
export function formatAge(ms) {
  const value = Number(ms) || 0
  if (value < 1000) return '刚刚'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}
