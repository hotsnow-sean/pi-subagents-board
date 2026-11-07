import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_MESSAGE,
  NOTE_TTL_MS,
  STEER_MODES,
  buildNote,
  isFresh,
  noteFileOf,
  noteId,
  parseNoteFileName,
  pruneMail,
  receiptFileOf,
} from '../lib/note-queue.mjs'

const NOW = 1_700_000_000_000

test('note-queue: 留言要带会话、目标与正文，空白正文直接拒', () => {
  const ok = buildNote({ kind: 'note', sessionKey: 'k1', runId: 'run-1', agent: 'worker', message: ' 继续 ' }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.note.message, '继续', '两端空白要修掉')
  assert.equal(ok.note.kind, 'note')
  assert.equal(ok.note.createdAt, NOW)

  assert.equal(buildNote({ kind: 'note', sessionKey: 'k1', runId: 'run-1', message: '   ' }, NOW).ok, false)
  assert.equal(buildNote({ kind: 'note', sessionKey: '', runId: 'run-1', message: 'x' }, NOW).ok, false)
  assert.equal(buildNote({ kind: 'note', sessionKey: 'k1', message: 'x' }, NOW).ok, false, '没有 runId 就没有投递目标')
  assert.equal(
    buildNote({ kind: 'note', sessionKey: 'k1', runId: 'run-1', message: 'x'.repeat(MAX_MESSAGE + 1) }, NOW).ok,
    false,
  )
})

test('note-queue: mode 只认扩展支持的三种，缺省 steer；index 只收非负整数', () => {
  for (const mode of STEER_MODES) {
    assert.equal(buildNote({ kind: 'note', sessionKey: 'k1', runId: 'r', message: 'x', mode }, NOW).note.mode, mode)
  }
  assert.equal(buildNote({ kind: 'note', sessionKey: 'k1', runId: 'r', message: 'x', mode: 'later' }, NOW).ok, false)
  assert.equal(
    buildNote({ kind: 'note', sessionKey: 'k1', runId: 'r', message: 'x', index: 2 }, NOW).note.index,
    2,
  )
  assert.equal(
    buildNote({ kind: 'note', sessionKey: 'k1', runId: 'r', message: 'x', index: -1 }, NOW).note.index,
    undefined,
  )
  assert.equal(
    buildNote({ kind: 'note', sessionKey: 'k1', runId: 'r', message: 'x', index: 'two' }, NOW).note.index,
    undefined,
  )
})

test('note-queue: stop 必须有 runId（没有就无从停起），且不需要正文', () => {
  const ok = buildNote({ kind: 'stop', sessionKey: 'k1', runId: 'run-2' }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.note.kind, 'stop')
  assert.equal(ok.note.message, undefined)

  const noRun = buildNote({ kind: 'stop', sessionKey: 'k1' }, NOW)
  assert.equal(noRun.ok, false)
  assert.match(noRun.error, /runId/)
})

test('note-queue: kind 只认 note / stop，别的值不会被当成任何命令', () => {
  assert.equal(buildNote({ kind: 'shout', sessionKey: 'k1', message: 'x' }, NOW).ok, false)
  assert.equal(buildNote({ sessionKey: 'k1', message: 'x' }, NOW).ok, false)
})

test('note-queue: 文件名解析只认 <id>.json（tmp 与目录里其它东西一律忽略）', () => {
  assert.equal(parseNoteFileName('abc-123.json'), 'abc-123')
  assert.equal(parseNoteFileName('n1.json'), 'n1')
  assert.equal(parseNoteFileName('n1.json.tmp'), null)
  assert.equal(parseNoteFileName('README.md'), null)
  assert.equal(parseNoteFileName(''), null)
  assert.equal(parseNoteFileName(undefined), null)
})

test('note-queue: id 唯一（同一毫秒两次也不要撞）', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i += 1) ids.add(noteId(NOW))
  assert.equal(ids.size, 200)
})

test('note-queue: 路径按会话分目录（多会话各读各的，不需要前缀认领）', () => {
  assert.equal(noteFileOf('/d', 'k1', 'x1'), '/d/inbox/k1/x1.json')
  assert.equal(receiptFileOf('/d', 'x1'), '/d/receipts/x1.json')
})

test('note-queue: 过期只由单端判断，越界与坏值都算过期', () => {
  assert.equal(isFresh({ createdAt: NOW - 1_000 }, NOW), true)
  assert.equal(isFresh({ createdAt: NOW - NOTE_TTL_MS - 1 }, NOW), false)
  assert.equal(isFresh({ createdAt: NOW - NOTE_TTL_MS + 1 }, NOW), true)
  assert.equal(isFresh({ createdAt: 'x' }, NOW), false, '坏时间戳宁可不投')
  assert.equal(isFresh({}, NOW), false)
})

test('note-queue: 正文原样投递，不加「来自面板」前缀（steer 直达子代理，不经过主代理翻译）', () => {
  const ok = buildNote({ kind: 'note', sessionKey: 'k1', runId: 'run-1', agent: 'code-reviewer', message: ' 换个方向 ' }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.note.message, '换个方向')
  assert.equal(ok.note.mode, 'steer', '默认打断它当前这一轮')
  assert.equal(ok.note.runId, 'run-1', 'runId 现在是投递地址，不是上下文备注')
})

test('note-queue: 清理只删过期的，没到期的留着', () => {
  const files = {
    '/d/inbox/k1/a.json': NOW - 25 * 60 * 60 * 1000,
    '/d/inbox/k1/b.json': NOW - 1_000,
    '/d/receipts/r.json': NOW - 25 * 60 * 60 * 1000,
    '/d/receipts/s.json': NOW - 1_000,
  }
  const removed = []
  pruneMail(
    '/d',
    NOW,
    (dir) => {
      if (dir === '/d/inbox') return ['k1']
      return Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1))
    },
    (file) => files[file] ?? NOW,
    (file) => removed.push(file),
  )
  assert.deepEqual(removed.sort(), ['/d/inbox/k1/a.json', '/d/receipts/r.json'])
})

test('note-queue: 目录还不存在时不炸（首次启动就是这种状态）', () => {
  const removed = pruneMail(
    '/d',
    NOW,
    () => {
      throw new Error('ENOENT')
    },
    () => NOW,
    () => {},
  )
  assert.equal(removed, 0)
})
