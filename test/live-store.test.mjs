import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  STALE_MS,
  ensureLiveDir,
  latestForSession,
  liveDirOf,
  liveFileOf,
  livenessOf,
  parseLiveName,
  pruneLiveFiles,
  readLiveFiles,
  writeJsonAtomic,
} from '../lib/live-store.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'board-live-'))
}

test('liveFileOf / parseLiveName: 文件名带实例后缀，且能解析回来', () => {
  const file = liveFileOf('/data', { sessionKey: 'k1', pid: 123, startedAt: 456 })
  assert.equal(path.basename(file), 'k1-123-456.json')
  assert.deepEqual(parseLiveName('k1-123-456.json'), { sessionKey: 'k1', pid: 123, startedAt: 456 })
  assert.equal(parseLiveName('nope.json'), null)
})

test('writeJsonAtomic: 写得进来、读得出去，不留 .tmp', () => {
  const dir = tmpDir()
  ensureLiveDir(dir)
  const file = path.join(liveDirOf(dir), 'x.json')
  writeJsonAtomic(file, { hello: 'world' })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hello: 'world' })
  assert.deepEqual(
    fs.readdirSync(liveDirOf(dir)).filter((n) => n.endsWith('.tmp')),
    [],
  )
})

test('latestForSession: 按实例启动时间取最新，而不是文件 mtime', () => {
  const dir = tmpDir()
  const live = ensureLiveDir(dir)
  // 旧实例：startedAt 小，但 mtime 更新（一次迟到的 flush）
  writeJsonAtomic(path.join(live, 'k1-1-100.json'), { sessionKey: 'k1', startedAt: 100 })
  writeJsonAtomic(path.join(live, 'k1-2-200.json'), { sessionKey: 'k1', startedAt: 200 })
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(path.join(live, 'k1-1-100.json'), old, old)
  const latest = latestForSession(dir, 'k1')
  assert.equal(latest.state.startedAt, 200)
  assert.equal(latestForSession(dir, 'nope'), null)
})

test('readLiveFiles: 坏 JSON 跳过，不影响其它文件', () => {
  const dir = tmpDir()
  const live = ensureLiveDir(dir)
  fs.writeFileSync(path.join(live, 'broken.json'), '{"half":')
  writeJsonAtomic(path.join(live, 'good.json'), { sessionKey: 'k1', startedAt: 1 })
  const files = readLiveFiles(dir)
  assert.equal(files.length, 1)
  assert.equal(files[0].state.sessionKey, 'k1')
})

test('pruneLiveFiles: 清掉超期文件与残留 .tmp', () => {
  const dir = tmpDir()
  const live = ensureLiveDir(dir)
  writeJsonAtomic(path.join(live, 'old.json'), { sessionKey: 'k1' })
  writeJsonAtomic(path.join(live, 'new.json'), { sessionKey: 'k2' })
  fs.writeFileSync(path.join(live, 'dead.json.tmp'), 'x')
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  fs.utimesSync(path.join(live, 'old.json'), old, old)
  const removed = pruneLiveFiles(dir)
  const left = fs.readdirSync(live).sort()
  assert.equal(removed, 2)
  assert.deepEqual(left, ['new.json'])
})

test('livenessOf: 30s 内有心跳算活，超时算陈旧', () => {
  const now = 1_700_000_000_000
  assert.equal(livenessOf({ updatedAt: now - 1_000 }, now).alive, true)
  assert.equal(livenessOf({ updatedAt: now - STALE_MS - 1 }, now).alive, false)
  assert.equal(livenessOf({}, now).alive, false)
  assert.equal(livenessOf({}, now).ageMs, null)
})
