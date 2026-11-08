import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ARCHIVE_IDLE_MS,
  STALE_MS,
  archiveFileOf,
  archiveSessions,
  ensureLiveDir,
  indexFileOf,
  isUnknownLiveFile,
  latestForSession,
  liveDirOf,
  liveFileOf,
  livenessOf,
  parseLiveName,
  partitionStamp,
  pruneLiveFiles,
  readIndex,
  readLiveFiles,
  sessionDirOf,
  writeIndex,
  writeJsonAtomic,
} from '../lib/live-store.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'board-live-'))
}

/** 造一份最小可合并的状态：一条链、一个终态段 */
function stateOf(sessionKey, startedAt, runId, extra = {}) {
  return {
    schema: 1,
    sessionKey,
    sessionFile: `C:/sessions/${sessionKey}.jsonl`,
    pid: 100,
    startedAt,
    updatedAt: Date.now(),
    lineages: [
      {
        lineageRoot: runId,
        agent: 'delegate',
        segments: [{ runId, agent: 'delegate', state: 'complete', startedAt, endedAt: startedAt + 10, ...extra }],
      },
    ],
  }
}

test('路径规则：分区在会话目录里，unknown 单独一个目录', () => {
  assert.equal(sessionDirOf('/data', 'k1'), path.join('/data', 'live', 'k1'))
  assert.equal(sessionDirOf('/data', ''), path.join('/data', 'live', 'unknown'))

  const file = liveFileOf('/data', { sessionKey: 'k1', pid: 123, startedAt: 456 })
  assert.equal(file, path.join('/data', 'live', 'k1', '123-456.json'))
  assert.deepEqual(parseLiveName('123-456.json'), { pid: 123, startedAt: 456 })
  // 旧布局的文件名（带 sessionKey 前缀）不再被认成合法分区
  assert.equal(parseLiveName('k1-123-456.json'), null)
  assert.equal(parseLiveName('archive.json'), null)

  const unknown = liveFileOf('/data', { sessionKey: 'unknown', pid: 7, startedAt: 8 })
  assert.equal(isUnknownLiveFile(unknown), true)
  assert.equal(isUnknownLiveFile(file), false)
})

test('writeJsonAtomic: 会话目录不存在时自己建出来，且不留 .tmp', () => {
  const dir = tmpDir()
  ensureLiveDir(dir)
  const file = archiveFileOf(dir, 'k1')
  writeJsonAtomic(file, { hello: 'world' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hello: 'world' })
  assert.deepEqual(
    fs.readdirSync(sessionDirOf(dir, 'k1')).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('readLiveFiles: 只读本会话目录，跳过索引，坏 JSON 不影响其它文件', () => {
  const dir = tmpDir()
  writeJsonAtomic(liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 }), stateOf('k1', 100, 'run-1'))
  writeJsonAtomic(liveFileOf(dir, { sessionKey: 'k2', pid: 2, startedAt: 200 }), stateOf('k2', 200, 'run-2'))
  writeIndex(dir, 'k1', { version: 2, sessionKey: 'k1', segments: [] })
  fs.writeFileSync(path.join(sessionDirOf(dir, 'k1'), 'broken.json'), '{"half":')

  const files = readLiveFiles(dir, 'k1')
  assert.equal(files.length, 1, '别的会话与坏文件都不该出现')
  assert.equal(files[0].state.sessionKey, 'k1')
  assert.equal(files[0].kind, 'partition')
  assert.deepEqual(readLiveFiles(dir, 'nope'), [])
})

test('partitionStamp: 不含索引（否则写完索引就自激），但含归档', () => {
  const dir = tmpDir()
  writeJsonAtomic(liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 }), stateOf('k1', 100, 'run-1'))
  const before = partitionStamp(dir, 'k1')
  writeIndex(dir, 'k1', { version: 2, sessionKey: 'k1', segments: [] })
  assert.equal(partitionStamp(dir, 'k1'), before, '写索引不该改变版本戳')

  writeJsonAtomic(archiveFileOf(dir, 'k1'), { version: 2, sessionKey: 'k1', startedAt: 0, lineages: [] })
  assert.notEqual(partitionStamp(dir, 'k1'), before, '装订归档是一次真实变化')
})

test('archiveSessions: 闲置且全终态的分区装订成一份，活跃分区留着', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = new Date(now - ARCHIVE_IDLE_MS - 60_000)
  // 两代已经下班的实例
  const a = liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 })
  const b = liveFileOf(dir, { sessionKey: 'k1', pid: 2, startedAt: 200 })
  writeJsonAtomic(a, stateOf('k1', 100, 'run-a', { pendingSteps: [{ index: 1 }], steering: { state: 'queued' } }))
  writeJsonAtomic(b, stateOf('k1', 200, 'run-b'))
  fs.utimesSync(a, old, old)
  fs.utimesSync(b, old, old)
  // 还在写的那一份：不能动
  const live = liveFileOf(dir, { sessionKey: 'k1', pid: 3, startedAt: 300 })
  writeJsonAtomic(live, stateOf('k1', 300, 'run-c', { state: 'running' }))

  const result = archiveSessions(dir, { now })
  assert.deepEqual(result, { archived: 2, files: 2 })

  const left = readLiveFiles(dir, 'k1')
  assert.equal(left.length, 2, '活跃分区 + 归档')
  const archive = left.find((item) => item.kind === 'archive')
  assert.ok(archive, '应当写出 archive.json')
  const runIds = archive.state.lineages.flatMap((lineage) => lineage.segments.map((segment) => segment.runId)).sort()
  assert.deepEqual(runIds, ['run-a', 'run-b'])
  // 过程态被裁掉，摘要与子代理明细保留
  const segment = archive.state.lineages.find((lineage) => lineage.segments[0].runId === 'run-a').segments[0]
  assert.equal(segment.pendingSteps, undefined)
  assert.equal(segment.steering, undefined)
  assert.ok(left.some((item) => item.kind === 'partition' && item.state.lineages[0].segments[0].runId === 'run-c'))
})

test('archiveSessions: 有 running 段的分区不动；刚写过的也不动', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = new Date(now - ARCHIVE_IDLE_MS - 60_000)
  const running = liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 })
  writeJsonAtomic(running, stateOf('k1', 100, 'run-a', { state: 'running' }))
  fs.utimesSync(running, old, old)
  const fresh = liveFileOf(dir, { sessionKey: 'k1', pid: 2, startedAt: 200 })
  writeJsonAtomic(fresh, stateOf('k1', 200, 'run-b'))

  assert.deepEqual(archiveSessions(dir, { now }), { archived: 0, files: 0 })
  assert.equal(readLiveFiles(dir, 'k1').length, 2)
})

test('archiveSessions: 闲置但 pid 还活着的分区不搬（安静的长会话不能「断代」）', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = new Date(now - ARCHIVE_IDLE_MS - 60_000)
  // 文件名里的 pid 就是判断依据：用测试进程自己的 pid 保证「活着」
  const idle = liveFileOf(dir, { sessionKey: 'k1', pid: process.pid, startedAt: 100 })
  writeJsonAtomic(idle, stateOf('k1', 100, 'run-a'))
  fs.utimesSync(idle, old, old)

  assert.deepEqual(archiveSessions(dir, { now, isAlive: () => true }), { archived: 0, files: 0 })
  assert.equal(readLiveFiles(dir, 'k1').length, 1, '活实例的分区要留着：它下次 flush 还得往这儿写')

  // 同一份文件，一旦那个进程没了，就该照常装订
  assert.deepEqual(archiveSessions(dir, { now, isAlive: () => false }), { archived: 1, files: 1 })
})

test('archiveSessions: 归档记住 sessionFile——装订后「返回主会话」还得有落点', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = new Date(now - ARCHIVE_IDLE_MS - 60_000)
  const main = 'C:/sessions/parent-main.jsonl'
  const a = liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 })
  writeJsonAtomic(a, { ...stateOf('k1', 100, 'run-a'), sessionFile: main })
  fs.utimesSync(a, old, old)
  archiveSessions(dir, { now })
  const archived = () => readLiveFiles(dir, 'k1').find((item) => item.kind === 'archive')?.state
  assert.equal(archived()?.sessionFile, main)

  // 第二次装订：新那份分区没带 sessionFile（老版本写的），已有的不能丢
  const b = liveFileOf(dir, { sessionKey: 'k1', pid: 2, startedAt: 200 })
  const noPath = stateOf('k1', 200, 'run-b')
  delete noPath.sessionFile
  writeJsonAtomic(b, noPath)
  fs.utimesSync(b, old, old)
  archiveSessions(dir, { now })
  assert.equal(archived()?.sessionFile, main, '后写的分区没路径时沿用归档里那份')
})

test('archiveSessions: 二次装订会并进已有的归档，不会丢前一次的段', () => {
  const dir = tmpDir()
  const now = Date.now()
  const old = new Date(now - ARCHIVE_IDLE_MS - 60_000)
  const first = liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 })
  writeJsonAtomic(first, stateOf('k1', 100, 'run-a'))
  fs.utimesSync(first, old, old)
  archiveSessions(dir, { now })

  const second = liveFileOf(dir, { sessionKey: 'k1', pid: 2, startedAt: 200 })
  writeJsonAtomic(second, stateOf('k1', 200, 'run-b'))
  fs.utimesSync(second, old, old)
  archiveSessions(dir, { now })

  const archive = readLiveFiles(dir, 'k1').find((item) => item.kind === 'archive')
  const runIds = archive.state.lineages.flatMap((lineage) => lineage.segments.map((segment) => segment.runId)).sort()
  assert.deepEqual(runIds, ['run-a', 'run-b'])
})

test('readIndex / writeIndex: 能读回来，坏文件与旧版本一律当不存在', () => {
  const dir = tmpDir()
  writeIndex(dir, 'k1', { version: 2, sessionKey: 'k1', startedAt: 9, segments: [{ runId: 'r1' }] })
  assert.equal(readIndex(dir, 'k1').startedAt, 9)
  assert.equal(readIndex(dir, 'nope'), null)

  fs.writeFileSync(indexFileOf(dir, 'k1'), '{oops')
  assert.equal(readIndex(dir, 'k1'), null)

  writeJsonAtomic(indexFileOf(dir, 'k1'), { version: 1, segments: [] })
  assert.equal(readIndex(dir, 'k1'), null, '版本不对就当没有，从分区重建')
})

test('latestForSession: 按实例启动时间取最新分区（不看 mtime），只剩归档时返回归档', () => {
  const dir = tmpDir()
  const oldFile = liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 })
  writeJsonAtomic(oldFile, stateOf('k1', 100, 'run-a'))
  writeJsonAtomic(liveFileOf(dir, { sessionKey: 'k1', pid: 2, startedAt: 200 }), stateOf('k1', 200, 'run-b'))
  // 旧实例一次迟到的 flush 让它的 mtime 更新
  const now = new Date()
  fs.utimesSync(oldFile, now, now)

  assert.equal(latestForSession(dir, 'k1').state.startedAt, 200)
  assert.equal(latestForSession(dir, 'nope'), null)

  const only = tmpDir()
  writeJsonAtomic(archiveFileOf(only, 'k1'), { version: 2, sessionKey: 'k1', startedAt: 0, lineages: [] })
  assert.equal(latestForSession(only, 'k1').kind, 'archive')
})

test('pruneLiveFiles: 清残留 .tmp、超期归档段、空会话目录，以及老布局留在根上的文件', () => {
  const dir = tmpDir()
  const live = ensureLiveDir(dir)
  const now = Date.now()

  // 老布局残留：根目录直接一个 json
  writeJsonAtomic(path.join(live, 'k9-1-2.json'), stateOf('k9', 1, 'run-old'))
  fs.writeFileSync(path.join(live, 'dead.json.tmp'), 'x')

  // 新布局：一个会话，归档里一段超期、一段还新
  writeJsonAtomic(liveFileOf(dir, { sessionKey: 'k1', pid: 1, startedAt: 100 }), stateOf('k1', 100, 'run-new'))
  const longAgo = now - 40 * 24 * 60 * 60 * 1000
  writeJsonAtomic(archiveFileOf(dir, 'k1'), {
    version: 2,
    sessionKey: 'k1',
    startedAt: 0,
    updatedAt: longAgo,
    lineages: [
      { lineageRoot: 'run-old', segments: [{ runId: 'run-old', state: 'complete', startedAt: longAgo, endedAt: longAgo }] },
      { lineageRoot: 'run-keep', segments: [{ runId: 'run-keep', state: 'complete', startedAt: now, endedAt: now }] },
    ],
  })
  // 一个只剩索引的空会话
  fs.mkdirSync(sessionDirOf(dir, 'k-empty'), { recursive: true })
  writeIndex(dir, 'k-empty', { version: 2, sessionKey: 'k-empty', segments: [] })

  const removed = pruneLiveFiles(dir, now)
  assert.ok(removed >= 3, `应当清掉老布局文件、tmp、空目录（实际 ${removed}）`)
  assert.equal(fs.existsSync(path.join(live, 'k9-1-2.json')), false)
  assert.equal(fs.existsSync(path.join(live, 'dead.json.tmp')), false)
  assert.equal(fs.existsSync(sessionDirOf(dir, 'k-empty')), false)

  const archive = JSON.parse(fs.readFileSync(archiveFileOf(dir, 'k1'), 'utf8'))
  const runIds = archive.lineages.flatMap((lineage) => lineage.segments.map((segment) => segment.runId))
  assert.deepEqual(runIds, ['run-keep'], '40 天前的段该被丢掉')
  assert.equal(readLiveFiles(dir, 'k1').length, 2, '分区与归档都还在')
})

test('livenessOf: 30s 内有心跳算活，超时算陈旧', () => {
  const now = 1_700_000_000_000
  assert.equal(livenessOf({ updatedAt: now - 1_000 }, now).alive, true)
  assert.equal(livenessOf({ updatedAt: now - STALE_MS - 1 }, now).alive, false)
  assert.equal(livenessOf({}, now).alive, false)
  assert.equal(livenessOf({}, now).ageMs, null)
})

test('读侧版本校验：不认的 schema 跳过，缺省（老文件）仍读', () => {
  const dir = tmpDir()
  const key = 'k1'
  const sessionDir = sessionDirOf(dir, key)
  fs.mkdirSync(sessionDir, { recursive: true })

  fs.writeFileSync(path.join(sessionDir, '100-1.json'), JSON.stringify({ ...stateOf(key, 1, 'from-future'), schema: 99 }))
  // schema: undefined 会被 JSON.stringify 丢掉 —— 正好等于「0.9 之前写的文件」
  fs.writeFileSync(path.join(sessionDir, '101-2.json'), JSON.stringify({ ...stateOf(key, 2, 'legacy'), schema: undefined }))
  fs.writeFileSync(path.join(sessionDir, '102-3.json'), JSON.stringify(stateOf(key, 3, 'current')))

  const runIds = readLiveFiles(dir, key)
    .map((item) => item.state.lineages[0].segments[0].runId)
    .sort()
  assert.deepEqual(runIds, ['current', 'legacy'], '未来版本跳过，没有版本号的照读')
})

test('archiveSessions / pruneLiveFiles: 不认版本的归档原样保留，分区也搬不走', () => {
  const dir = tmpDir()
  const key = 'k1'
  ensureLiveDir(dir)
  const archiveFile = archiveFileOf(dir, key)
  writeJsonAtomic(archiveFile, { version: 99, sessionKey: key, lineages: [{ segments: [{ runId: 'future' }] }] })
  const partition = liveFileOf(dir, { sessionKey: key, pid: 424242, startedAt: 1 })
  writeJsonAtomic(partition, { ...stateOf(key, 1, 'r1'), schema: 99 })

  const archived = archiveSessions(dir, { now: Date.now() + ARCHIVE_IDLE_MS + 60_000 })
  assert.equal(archived.archived, 0, '归档认不得就不该装订')
  assert.equal(JSON.parse(fs.readFileSync(archiveFile, 'utf8')).version, 99, '新版归档必须一个字都不动')
  assert.ok(fs.existsSync(partition), '分区也不该被搬走')

  // 再把两者都做成「超期」，确认清理路径同样不碰
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  fs.utimesSync(archiveFile, old, old)
  fs.utimesSync(partition, old, old)
  pruneLiveFiles(dir, Date.now())
  assert.ok(fs.existsSync(archiveFile), '超期但版本不认的归档留着')
  assert.ok(fs.existsSync(partition), '超期但版本不认的分区留着')
})
