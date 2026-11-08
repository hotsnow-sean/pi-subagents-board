// @ts-check
/**
 * 降级判定（纯函数）。
 *
 * 面板最怕的不是「没有数据」，而是**有数据但不知道它是死的**：用户盯着一张
 * 永远停在 3 分钟前的卡，会以为子代理卡住了。所以「能不能信这份数据」必须
 * 单独算出来、单独显示，而且文案要说清下一步能做什么。
 *
 * 六种状态（计划 §5.8，0.11.1 加 archived）：
 *   ok             RPC 推送模式，数据新鲜
 *   poll           握手超时后的轮询模式（能看，但慢）
 *   rpc-unavailable 握手一直没成功：pi-subagents 没装 / 版本不对 / 还没就绪
 *   stale          数据超过 30s 没更新：worker 已退出或换代。**不提示**（见下）
 *   no-data        这个会话还没有 live 文件（没派过子代理，或 worker 还没起来）
 *   archived       只剩归档分区（实例都已退出）：历史可看，不报警
 *
 * 只有「要用户做点什么」的两种才占一行横幅（rpc-unavailable / poll）；
 * 其余靠空态与诊断区表达。
 */

/**
 * @param {any} state live 状态（可为 null）
 * @param {{ alive: boolean, ageMs: number | null }} liveness
 * @param {number} [now]
 * @param {{ livePartitions?: number }} [options]
 *   `livePartitions` 是这个会话**还在写**的分区数（0 = 只剩归档）。
 *   归档没有 `source`、也没有心跳——那是实例的运行时能力，不该为「历史」伪造一份。
 *   不传按 1 处理（老调用方的行为不变）。
 */
export function describeDegrade(state, liveness, now = Date.now(), options = {}) {
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
  // 只有归档 = 写过这个会话的实例都已经不在了。归档里必然没有 source（那是实例的运行时
  // 能力，装订时不会伪造），也只有一个「装订时刻」而不是心跳——拿它判「连没连上
  // pi-subagents」会得到一句假警报：用户只是打开旧会话看历史，横幅却在喊扩展没装。
  // 归档段全是终态，不存在「盯着停在 3 分钟前的卡」那种误导，所以这里静默。
  const livePartitions = options.livePartitions ?? 1
  if (!livePartitions) return { kind: 'archived', tone: 'ok', title: '', detail: '' }

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

  // 心跳过期：**不弹横幅**。曾经这里有一条 `warn` 级的「数据已停止更新」，2026-11-08 去掉：
  //   1. 它说不了什么。用户面对的自始至终是同一个会话，重启几次都一样，看到这句话也没有
  //      可执行的动作——「进程退出了」是宿主的正常生命周期，不是这个面板能处理的事。
  //   2. 它会自己消失。会话一旦重新绑上 worker（哪怕这次会话根本没用到 subagents），横幅
  //      立刻不见、卡片整体上移，看上去像界面在跳。
  // 保留 `kind: 'stale'` 是因为调用方仍需要「这份数据是旧的」这个事实（诊断区也还显示心跳
  // 年龄）；`title` 为空 = 渲染层按约定不画横幅。
  //
  // 放在 poll 之前：实例都退了还说「正在每 2 秒轮询」是假话。
  if (!liveness.alive) return { kind: 'stale', tone: 'ok', title: '', detail: '' }

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
