// @ts-check
/**
 * live 状态的落盘与读取（有 IO，但只碰 `<dataDir>/live/`）。
 *
 * 布局（0.11.0 起）：
 *
 * ```
 * live/<sessionKey>/<pid>-<startedAt>.json   每个扩展实例自己的一份（分区）
 * live/<sessionKey>/archive.json             不再更新的分区装订成一份（main 写）
 * live/<sessionKey>/index.json               索引：段摘要 + 反查用的会话路径（main 写）
 * live/unknown/<pid>-<startedAt>.json        sessionFile 还没就位时的临时落点
 * ```
 *
 * 为什么还是「一人一份」而不是写同一个文件：扩展实例会随会话切换换代，新实例的 `state`
 * 是空的、写盘是**整份覆盖**。共用文件的话第一次保存就把上一代清空（0.8.5 之前实测踩到）；
 * 两个实例同时活着时还会互相盖。所以各写各的，读的时候合并（`mergeLiveStates`）。
 *
 * 目录化买到的是**读的范围**：以前每次要列 `live/` 下所有会话的所有代（实测 33 个文件、
 * 20 个会话），再按文件名前缀过滤；现在只列本会话目录（常态 3 个文件）。归档保证这个
 * 数字不随天数增长——一个会话一天能换 9 代实例。
 *
 * 写者约束（硬）：worker 只写自己的分区；`archive.json` / `index.json` 只有 main 写。
 * worker 会换代、会死，只有 main 的生命周期与面板一致。
 */

import fs from 'node:fs'
import path from 'node:path'

import { mergeLiveStates } from './lineage.mjs'

export const LIVE_DIR = 'live'
/** 超过这个时间没更新就算陈旧：worker 可能已经退出或换代 */
export const STALE_MS = 30_000
/** 分区「多久没动」才可以装订：实例已换代或退出，且里面的段都是终态 */
export const ARCHIVE_IDLE_MS = 60 * 60 * 1000
/** 归档里保留多久（按段的结束时间） */
export const ARCHIVE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

const ARCHIVE_FILE = 'archive.json'
const INDEX_FILE = 'index.json'
const ARCHIVE_VERSION = 2
/** 分区文件的格式版本，对应 `createState()` 写的 `schema` */
const STATE_SCHEMA = 1
const UNKNOWN_KEY = 'unknown'

/**
 * 读侧版本校验：认得这个版本才读，不认得就跳过这个文件。
 *
 * 为什么要校验：格式改了以后，旧文件被当新格式解析**不会报错**，只会得到半对半错的
 * 一张卡——字段没了、状态值不认识于是被渲染成原始字符串。这种错误没有任何人会发现。
 * 跳过比乱读安全：面板少一张卡，胜过显示一张错卡。
 *
 * **缺省视为当前版本**：`schema` / `version` 是后来才写的字段，早期文件没有它们，
 * 不能因此把人家的历史全判死。
 *
 * @param {'partition' | 'archive'} kind
 * @param {any} value
 */
function versionAccepted(kind, value) {
  const declared = kind === 'archive' ? value?.version : value?.schema
  const version = Number(declared)
  if (!Number.isFinite(version)) return true
  return version === (kind === 'archive' ? ARCHIVE_VERSION : STATE_SCHEMA)
}

/** 这些状态的段不能进归档：还在跑、还在停、或者只是排队 */
const NOT_ARCHIVABLE = new Set(['running', 'queued', 'stopping', 'paused', 'pending'])

/** 解析缓存：文件路径 → { mtimeMs, size, state, kind }。合并要读全部文件，不能每次 JSON.parse */
const fileCache = new Map()
/** 索引缓存：文件路径 → { mtimeMs, size, value } */
const indexCache = new Map()
const MAX_CACHE = 256

/** @param {string} dataDir */
export function liveDirOf(dataDir) {
  return path.join(dataDir, LIVE_DIR)
}

/**
 * 一个会话的目录。`sessionKey` 是十六进制串（见 lib/session-key.mjs），可以直接当目录名。
 * @param {string} dataDir
 * @param {unknown} sessionKey
 */
export function sessionDirOf(dataDir, sessionKey) {
  const key = String(sessionKey ?? '').trim() || UNKNOWN_KEY
  return path.join(liveDirOf(dataDir), key)
}

/**
 * 本实例的分区文件。`unknown` 走 `live/unknown/`，真 sessionKey 到了之后由 worker 搬家。
 * @param {string} dataDir
 * @param {{ sessionKey: string, pid: number, startedAt: number }} instance
 */
export function liveFileOf(dataDir, instance) {
  return path.join(sessionDirOf(dataDir, instance.sessionKey), `${instance.pid}-${instance.startedAt}.json`)
}

/** @param {string} dataDir @param {unknown} sessionKey */
export function archiveFileOf(dataDir, sessionKey) {
  return path.join(sessionDirOf(dataDir, sessionKey), ARCHIVE_FILE)
}

/** @param {string} dataDir @param {unknown} sessionKey */
export function indexFileOf(dataDir, sessionKey) {
  return path.join(sessionDirOf(dataDir, sessionKey), INDEX_FILE)
}

/**
 * 这个分区文件是不是「还没拿到 sessionKey」时写的临时文件。
 * worker 用它判断「真 key 到了要不要把旧文件删掉」。
 * @param {unknown} file
 */
export function isUnknownLiveFile(file) {
  return path.basename(path.dirname(String(file ?? ''))) === UNKNOWN_KEY
}

/** @param {string} name 形如 `<pid>-<startedAt>.json` */
export function parseLiveName(name) {
  const match = /^(\d+)-(\d+)\.json$/.exec(String(name ?? ''))
  if (!match) return null
  return { pid: Number(match[1]), startedAt: Number(match[2]) }
}

/** @param {string} dataDir */
export function ensureLiveDir(dataDir) {
  const dir = liveDirOf(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** @param {string} dataDir @param {unknown} sessionKey */
export function ensureSessionDir(dataDir, sessionKey) {
  const dir = sessionDirOf(dataDir, sessionKey)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 原子写：`.tmp` + `renameSync`（同目录，同分区，原子）。
 *
 * 直接 writeFileSync 会被 main 侧读到半截 JSON（它按 mtime 轮询，撞上写入窗口的概率不低）。
 * 顺手 `mkdir -p` 父目录：会话目录是第一次写的时候才出现的。
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * 读一个会话的全部状态文件（分区 + 归档，**不含索引**）。
 *
 * 坏文件（半截 / 格式升级）直接跳过——一个坏文件不该让面板整体空白。
 * 带 mtime+size 缓存：合并每轮都要读，没变的那几份不该重复解析。
 *
 * @param {string} dataDir
 * @param {unknown} sessionKey
 * @returns {Array<{ file: string, mtimeMs: number, size: number, state: any, kind: 'partition' | 'archive' }>}
 */
export function readLiveFiles(dataDir, sessionKey) {
  const dir = sessionDirOf(dataDir, sessionKey)
  /** @type {string[]} */
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json') || name === INDEX_FILE) continue
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      const hit = fileCache.get(file)
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        out.push(hit)
        continue
      }
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!state || typeof state !== 'object') continue
      /** @type {'partition' | 'archive'} */
      const kind = name === ARCHIVE_FILE ? 'archive' : 'partition'
      // 不认的版本整份跳过（也不进缓存）：可能是更新版本插件写的，等它自己升上来
      if (!versionAccepted(kind, state)) continue
      const entry = { file, mtimeMs: stat.mtimeMs, size: stat.size, state, kind }
      if (fileCache.size >= MAX_CACHE) {
        const oldest = fileCache.keys().next().value
        if (oldest !== undefined) fileCache.delete(oldest)
      }
      fileCache.set(file, entry)
      out.push(entry)
    } catch {
      continue
    }
  }
  return out
}

/**
 * 目录里所有会话的 key（排除 `unknown`）。
 * 后台巡检要覆盖没打开的会话，只能按目录遍历。
 * @param {string} dataDir
 */
export function listSessionKeys(dataDir) {
  try {
    return fs
      .readdirSync(liveDirOf(dataDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== UNKNOWN_KEY)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 版本戳：文件数 + 最大 mtime + 总字节（**不含 index.json**）。
 *
 * 不含索引是为了避免自激：main 写完索引后戳一变，长轮询醒来又把索引写一遍。
 * 含归档：装订这件事对面板是「历史变了」，必须能让挂起的请求醒过来。
 *
 * 为什么不用目录 mtime：文件内容是原子写（rename）替换的，目录 mtime 只反映
 * 「多了/少了文件」，同一份文件反复覆盖它不动。用 max(mtime) 才看得见内容更新。
 * @param {string} dataDir @param {unknown} sessionKey
 */
export function partitionStamp(dataDir, sessionKey) {
  const dir = sessionDirOf(dataDir, sessionKey)
  let count = 0
  let newest = 0
  let bytes = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === INDEX_FILE) continue
      try {
        const stat = fs.statSync(path.join(dir, name))
        count += 1
        if (stat.mtimeMs > newest) newest = stat.mtimeMs
        bytes += stat.size
      } catch {
        // 文件正好被 rename 掉：这一次不计入，下一次 stat 会补上
      }
    }
  } catch {
    // 目录还不存在（一个 run 都没跑过）
  }
  return `${count}-${Math.round(newest)}-${bytes}`
}

/**
 * 写索引（main 专用）。派生数据：坏了/没有都行，从分区重建。
 * @param {string} dataDir @param {unknown} sessionKey @param {unknown} value
 */
export function writeIndex(dataDir, sessionKey, value) {
  writeJsonAtomic(indexFileOf(dataDir, sessionKey), value)
}

/**
 * 读索引。只服务「反查这段子会话属于谁」与诊断——`getState` 要完整段，读分区更准。
 * @param {string} dataDir @param {unknown} sessionKey
 */
export function readIndex(dataDir, sessionKey) {
  const file = indexFileOf(dataDir, sessionKey)
  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const hit = indexCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value
  /** @type {any} */
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!value || value.version !== ARCHIVE_VERSION || !Array.isArray(value.segments)) return null
  if (indexCache.size >= MAX_CACHE) {
    const oldest = indexCache.keys().next().value
    if (oldest !== undefined) indexCache.delete(oldest)
  }
  indexCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

/**
 * 现有的 `archive.json` 能不能被本版本重写。
 *
 * 不能省这一步：`readLiveFiles` 会把不认版本的归档过滤掉，于是 `archiveSessions`
 * 看不见 `existing`，合并结果里就没有它——接着 `writeJsonAtomic` 直接把整份归档
 * 换成 v2 结构，新版数据等于被销毁。所以装订前必须看一次原始文件。
 *
 * 没有文件 / 文件坏了 → true（坏了本来也只能重建）。
 * @param {string} dataDir @param {string} sessionKey
 */
function archiveWritable(dataDir, sessionKey) {
  try {
    const value = JSON.parse(fs.readFileSync(archiveFileOf(dataDir, sessionKey), 'utf8'))
    return versionAccepted('archive', value)
  } catch {
    return true
  }
}

/**
 * 装订：把「已经下班、卡都结束」的分区并进 `archive.json`，然后删掉分区文件。
 *
 * 判据是**文件 mtime 闲置超过 `idleMs`**（实例已换代或退出）且段全是终态——不看 `updatedAt`，
 * 那个字段是 worker 写的，实例死了就不再刷新，两者其实等价，但 mtime 连「写了一半崩掉」
 * 也能覆盖。
 *
 * 还要再过一道 `isAlive(pid)`：闲置一小时的实例可能**只是安静**（长时间没事件的会话），
 * 搬走它正在写的分区，它下次 flush 会把整份历史再写回来——白搬一趟，中间那一帧面板还
 * 只剩归档（看着像数据突然断代）。pid 从分区文件名里取（`<pid>-<startedAt>.json`）。
 *
 * 合并复用 `mergeLiveStates`：同一条链跨代对齐、同 runId 后写覆盖，与读路径完全一致。
 * 归档段的裁剪只去**过程态**（排队占位、插话、提问留痕），摘要与子代理明细全部保留——
 * 历史卡还能展开、还能点「打开」。
 *
 * @param {string} dataDir
 * @param {{ now?: number, idleMs?: number, isAlive?: (pid: number) => boolean }} [options]
 * @returns {{ archived: number, files: number }}
 */
export function archiveSessions(dataDir, options = {}) {
  const now = Number(options.now) || Date.now()
  const idleMs = Number(options.idleMs) || ARCHIVE_IDLE_MS
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : () => false
  let archived = 0
  let files = 0
  for (const key of listSessionKeys(dataDir)) {
    if (!archiveWritable(dataDir, key)) continue
    const items = readLiveFiles(dataDir, key)
    const idle = items.filter((item) => {
      if (item.kind !== 'partition') return false
      if (now - item.mtimeMs < idleMs) return false
      if (!isArchivable(item.state)) return false
      const pid = parseLiveName(path.basename(item.file))?.pid ?? 0
      return !(pid && isAlive(pid))
    })
    if (!idle.length) continue
    const existing = items.find((item) => item.kind === 'archive')
    const states = [existing?.state, ...idle.map((item) => item.state)].filter(Boolean)
    // 按实例启动时间排：mergeLiveStates 把**最后一个**当最新一代取顶层字段，
    // 而这里的 idle 顺序是 readdir 给的（随机）。不排就会拿到随机某一代的 sessionFile。
    states.sort((a, b) => (Number(a?.startedAt) || 0) - (Number(b?.startedAt) || 0))
    /** @type {any} */
    const merged = states.length > 1 ? mergeLiveStates(states) : states[0]
    if (!merged) continue
    writeJsonAtomic(archiveFileOf(dataDir, key), {
      version: ARCHIVE_VERSION,
      sessionKey: key,
      // 归档也得记住自己的会话路径：打开子会话预览时，反查出父会话后「返回主会话」
      // 就靠它定落点。分区在的时候由分区带，装订后不留就永久丢了。
      sessionFile: String(merged.sessionFile || existing?.state?.sessionFile || ''),
      // 排序键：合并时活跃分区（startedAt 更大）会覆盖归档里的同 runId 段
      startedAt: 0,
      updatedAt: now,
      lineages: (merged.lineages ?? []).map(slimLineage),
    })
    for (const item of idle) {
      try {
        fs.rmSync(item.file, { force: true })
        files += 1
      } catch {
        /* 删不掉就留到下次 */
      }
      fileCache.delete(item.file)
    }
    archived += idle.length
  }
  return { archived, files }
}

/** 分区里所有段都已结束（没有在跑/在停/排队的）才配装订 */
function isArchivable(/** @type {any} */ state) {
  /** @type {any[]} */
  const segments = []
  for (const lineage of state?.lineages ?? []) {
    for (const segment of lineage?.segments ?? []) segments.push(segment)
  }
  if (!segments.length) return false
  return segments.every((segment) => !NOT_ARCHIVABLE.has(String(segment?.state ?? '')))
}

/** @param {any} lineage */
function slimLineage(lineage) {
  return {
    ...lineage,
    segments: (lineage?.segments ?? []).map(slimSegment),
  }
}

/**
 * 归档段的字段裁剪：只去**过程态**。
 * 摘要（summary）、错误、子代理明细（children）全部保留——历史卡还要能展开、能点打开。
 * @param {any} segment
 */
function slimSegment(segment) {
  if (!segment || typeof segment !== 'object') return segment
  const out = { ...segment }
  delete out.pendingSteps
  delete out.steering
  delete out.asklog
  delete out.waitText
  delete out.openCandidates
  return out
}

/**
 * 同一段会话取最新的一份分区（按实例启动时间，不看 mtime——迟到的 flush 会把旧实例
 * 顶到前面）。只有归档时为 null。
 * @param {string} dataDir
 * @param {unknown} sessionKey
 */
export function latestForSession(dataDir, sessionKey) {
  const items = readLiveFiles(dataDir, sessionKey)
  const partitions = items.filter((item) => item.kind === 'partition')
  if (!partitions.length) return items.find((item) => item.kind === 'archive') ?? null
  partitions.sort((a, b) => (Number(b.state.startedAt) || 0) - (Number(a.state.startedAt) || 0))
  return partitions[0]
}

/**
 * 清理：残留 `.tmp`、超期的归档段、长期不动的分区、空掉的会话目录。
 * @param {string} dataDir
 * @param {number} [now]
 */
export function pruneLiveFiles(dataDir, now = Date.now()) {
  const root = liveDirOf(dataDir)
  /** @type {fs.Dirent[]} */
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      // 老布局（0.10.x 及以前）留在 `live/` 根目录的文件。
      //
      // ⚠️ 这里是**销毁，不是迁移**。插件还在初步开发阶段，升级路径不写进源码（见
      // 0.11.0 的决定），所以老文件一律当垃圾清掉。两个后果必须记住：
      //   1. 从 0.10.x 升上来的数据会在第一次巡检时消失——迁移只能靠工作区的一次性脚本；
      //   2. 根目录将来不能放任何需要保留的文件（这条判断会把它们一起删掉）。
      if (entry.name.endsWith('.tmp') || entry.name.endsWith('.json')) {
        try {
          fs.rmSync(path.join(root, entry.name), { force: true })
          removed += 1
        } catch {
          /* 下次再清 */
        }
      }
      continue
    }
    const dir = path.join(root, entry.name)
    /** @type {string[]} */
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(dir, name)
      try {
        if (name.endsWith('.tmp')) {
          fs.rmSync(file, { force: true })
          removed += 1
          continue
        }
        const stat = fs.statSync(file)
        if (name === ARCHIVE_FILE) {
          if (pruneArchive(file, now)) removed += 1
          continue
        }
        if (name === INDEX_FILE) continue
        if (now - stat.mtimeMs > ARCHIVE_KEEP_MS) {
          // 不认的版本留着：可能是更新版本的插件写的，宁可在磁盘上多占几 KB
          let value
          try {
            value = JSON.parse(fs.readFileSync(file, 'utf8'))
          } catch {
            value = null // 坏文件更要清
          }
          if (value && !versionAccepted('partition', value)) continue
          fs.rmSync(file, { force: true })
          fileCache.delete(file)
          removed += 1
        }
      } catch {
        continue
      }
    }
    // 目录里只剩索引（或什么都没有）→ 整个会话已经没有记录可看
    try {
      const left = fs.readdirSync(dir).filter((name) => name !== INDEX_FILE)
      if (!left.length) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      /* 目录正好被删掉 */
    }
  }
  return removed
}

/**
 * 丢归档里太老的段。删空了就把 `archive.json` 也去掉。
 * @param {string} file @param {number} now
 */
function pruneArchive(file, now) {
  /** @type {any} */
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  // 不认的版本不碰：下面的裁剪按 v2 的 `segments[].endedAt` 走，对新版结构可能把还在的段
  // 当过期删掉——那是真删数据，比留一份旧文件糟得多
  if (!versionAccepted('archive', value)) return false
  const cutoff = now - ARCHIVE_KEEP_MS
  let changed = false
  const lineages = []
  for (const lineage of value?.lineages ?? []) {
    const segments = (lineage?.segments ?? []).filter((/** @type {any} */ segment) => {
      const at = Number(segment?.endedAt) || Number(segment?.startedAt) || 0
      return at === 0 || at >= cutoff
    })
    if (segments.length !== (lineage?.segments ?? []).length) changed = true
    if (segments.length) lineages.push({ ...lineage, segments })
  }
  if (!changed) return false
  if (!lineages.length) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      return false
    }
  } else {
    writeJsonAtomic(file, { ...value, lineages, updatedAt: now })
  }
  fileCache.delete(file)
  return true
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
