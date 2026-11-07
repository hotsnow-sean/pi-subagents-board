// @ts-check
/// <reference path="../../pi-app/plugins/plugin-sdk.d.ts" />
/**
 * subagents-board — main 侧服务（入口）。
 *
 * P2-a 阶段只做**数据打通**：把 agent.mjs 落盘的 live 状态读出来，附带一份
 * 「这份数据能不能信」的判定，交给面板。不做 steer/stop（P2-c），不发信箱。
 *
 * 契约：
 *   invoke('getState', { sessionFile }) →
 *     { ok, sessionFile, sessionKey, liveness, degrade, source, lineages, activeCount, now }
 *   invoke('getDiagnostics', { sessionFile }) → 原始 live 状态（面板的「诊断」折叠区用）
 *
 * ── 多文件结构与热重载 ─────────────────────────────────────────────────────
 *
 * lib/ 的模块引用一律走 imp() 动态加载并透传 `?v=`：宿主热重载把版本号编进入口
 * URL（按插件目录最大 mtime），静态 import 会丢掉 query、命中旧模块缓存。
 * ⚠️ lib/ 里禁止出现指向插件内文件的静态 import。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, 'lib', `${name}.mjs`)).href + Q)

const { latestForSession, livenessOf, pruneLiveFiles, LIVE_DIR } = await imp('live-store')
const { sessionKeyOf } = await imp('session-key')
const { listLineages, activeCount } = await imp('lineage')
const { describeDegrade } = await imp('degrade')

/** @type {{ ctx: any } | null} */
let rt = null

/**
 * 会话上下文里拿不到 sessionFile 时也返回一份可渲染的结果：
 * 面板空白是最糟的默认值，用户会以为是插件坏了。
 * @param {any} degrade
 */
function emptyState(degrade) {
  return {
    ok: true,
    sessionFile: '',
    sessionKey: '',
    liveness: { alive: false, ageMs: null, updatedAt: 0 },
    degrade,
    source: null,
    lineages: [],
    activeCount: 0,
    now: Date.now(),
  }
}

/** @param {string} sessionFile */
function stateFor(sessionFile) {
  const file = String(sessionFile ?? '').trim()
  if (!file) {
    return emptyState({
      kind: 'no-session',
      tone: 'info',
      title: '没有打开会话',
      detail: '子代理记录跟着会话走。先在左侧打开一个会话，这里会显示它的子代理。',
    })
  }
  const sessionKey = sessionKeyOf(file)
  const latest = latestForSession(rt.ctx.dataDir, sessionKey)
  const state = latest?.state ?? null
  const liveness = livenessOf(state)
  const degrade = describeDegrade(state, liveness)
  const lineages = state ? listLineages(state) : []
  return {
    ok: true,
    sessionFile: file,
    sessionKey,
    liveness,
    degrade,
    source: state?.source ?? null,
    lineages,
    activeCount: state ? activeCount(state) : 0,
    now: Date.now(),
    /** 数据文件路径：诊断折叠区显示，用户排查「为什么没数据」时最有用 */
    dataFile: latest?.file ?? '',
  }
}

/** @param {any} pluginContext */
export async function activate(pluginContext) {
  rt = { ctx: pluginContext }
  const removed = pruneLiveFiles(pluginContext.dataDir)
  pluginContext.log(`subagents-board active, dataDir=${pluginContext.dataDir}${removed ? `, pruned ${removed} stale file(s)` : ''}`)
  return {
    /**
     * @param {string} method
     * @param {any} params
     */
    async invoke(method, params) {
      switch (method) {
        case 'getState':
          return stateFor(params?.sessionFile)
        case 'getDiagnostics': {
          const file = String(params?.sessionFile ?? '').trim()
          if (!file) return { ok: false, error: 'no sessionFile' }
          const latest = latestForSession(rt.ctx.dataDir, sessionKeyOf(file))
          return {
            ok: true,
            liveDir: path.join(rt.ctx.dataDir, LIVE_DIR),
            dataFile: latest?.file ?? '',
            mtimeMs: latest?.mtimeMs ?? null,
            state: latest?.state ?? null,
          }
        }
        default:
          throw new Error(`unknown method: ${method}`)
      }
    },
  }
}

export async function deactivate() {
  rt = null
}
