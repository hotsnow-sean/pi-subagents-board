// @ts-check
/**
 * live 状态的落盘与读取（有 IO，但只碰 `<dataDir>/live/`）。
 *
 * 为什么一个会话一份文件、文件名还带实例后缀：插件的 agent 扩展会随会话切换
 * **换代**——工厂被重新调用一次，新实例的 `state` 是空的；共用文件名会把上一代
 * 的结果覆盖成空白（P0 实测踩到，整轮数据丢失）。所以：
 *
 *   live/<sessionKey>-<pid>-<startedAt>.json
 *
 * main 侧按 sessionKey 取「最新的一份」，再看 `updatedAt` 判活。
 */

import fs from 'node:fs'
import path from 'node:path'

export const LIVE_DIR = 'live'
/** 超过这个时间没更新就算陈旧：worker 可能已经退出或换代 */
export const STALE_MS = 30_000
/** 清理阈值：正常一天也用不到这么多份，留一周足够回看 */
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000

/** @param {string} dataDir */
export function liveDirOf(dataDir) {
  return path.join(dataDir, LIVE_DIR)
}

/**
 * 原子写：`.tmp` + `renameSync`。
 *
 * 直接 writeFileSync 会被 main 侧读到半截 JSON（它按 mtime 轮询，撞上写入窗口的
 * 概率不低）。rename 在同一分区上是原子的。
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * 本实例的 live 文件路径。
 * @param {string} dataDir
 * @param {{ sessionKey: string, pid: number, startedAt: number }} instance
 */
export function liveFileOf(dataDir, instance) {
  return path.join(liveDirOf(dataDir), `${instance.sessionKey}-${instance.pid}-${instance.startedAt}.json`)
}

/** @param {string} name 形如 `<key>-<pid>-<startedAt>.json` */
export function parseLiveName(name) {
  const match = /^(.+)-(\d+)-(\d+)\.json$/.exec(name)
  if (!match) return null
  return { sessionKey: match[1], pid: Number(match[2]), startedAt: Number(match[3]) }
}

/** @param {string} dataDir */
export function ensureLiveDir(dataDir) {
  const dir = liveDirOf(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 读全部 live 文件；坏文件（半截 / 格式升级）直接跳过——一个坏文件不该让面板整体空白。
 * @param {string} dataDir
 * @returns {Array<{ file: string, mtimeMs: number, state: any }>}
 */
export function readLiveFiles(dataDir) {
  const dir = liveDirOf(dataDir)
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!state || typeof state !== 'object') continue
      out.push({ file, mtimeMs: stat.mtimeMs, state })
    } catch {
      continue
    }
  }
  return out
}

/**
 * 同一段会话取最新的一份。
 *
 * 排序键用文件里的 `startedAt`（实例启动时间）而不是 mtime：mtime 会因为一次
 * 迟到的 flush 把旧实例顶到前面，而实例的先后关系是确定的。
 * @param {string} dataDir
 * @param {string} sessionKey
 */
export function latestForSession(dataDir, sessionKey) {
  const candidates = readLiveFiles(dataDir).filter((item) => item.state.sessionKey === sessionKey)
  if (!candidates.length) return null
  candidates.sort((a, b) => (Number(b.state.startedAt) || 0) - (Number(a.state.startedAt) || 0))
  return candidates[0]
}

/**
 * 清理陈旧文件（超过一周）。顺手把残留的 `.tmp` 也删掉——那是写到一半崩掉留下的。
 * @param {string} dataDir
 * @param {number} [now]
 */
export function pruneLiveFiles(dataDir, now = Date.now()) {
  const dir = liveDirOf(dataDir)
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      if (name.endsWith('.tmp')) {
        fs.rmSync(file, { force: true })
        removed += 1
        continue
      }
      const stat = fs.statSync(file)
      if (now - stat.mtimeMs > PRUNE_MS) {
        fs.rmSync(file, { force: true })
        removed += 1
      }
    } catch {
      continue
    }
  }
  return removed
}

/**
 * 判活：`updatedAt` 是心跳，每次 flush 刷新。超过 30s = 陈旧。
 * @param {any} state
 * @param {number} [now]
 */
export function livenessOf(state, now = Date.now()) {
  const updatedAt = Number(state?.updatedAt) || 0
  const ageMs = updatedAt ? now - updatedAt : null
  return { alive: ageMs !== null && ageMs < STALE_MS, ageMs, updatedAt }
}
