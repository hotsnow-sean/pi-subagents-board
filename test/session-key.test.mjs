import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { childSessionFile, normalizeSessionPath, sessionKeyOf } from '../lib/session-key.mjs'

test('normalizeSessionPath: Windows 路径统一斜杠并小写', () => {
  assert.equal(normalizeSessionPath('C:\\Users\\A\\x.jsonl'), 'c:/users/a/x.jsonl')
})

test('normalizeSessionPath: POSIX 路径保持大小写', () => {
  assert.equal(normalizeSessionPath('/Users/A/x.jsonl'), '/Users/A/x.jsonl')
})

test('sessionKeyOf: 同一文件的大小写/分隔符变体得到同一个 key', () => {
  const a = sessionKeyOf('C:\\Users\\A\\x.jsonl')
  const b = sessionKeyOf('c:/users/a/x.jsonl')
  assert.equal(a, b)
  assert.equal(a.length, 12)
})

test('sessionKeyOf: 不同会话不同 key，空值退化为 unknown', () => {
  assert.notEqual(sessionKeyOf('C:/a.jsonl'), sessionKeyOf('C:/b.jsonl'))
  assert.equal(sessionKeyOf(''), 'unknown')
})

test('childSessionFile: 按实测形状推导 <父目录>/<stem>/<runId>/run-<i>/session.jsonl', () => {
  const parent = path.join('C:', 'sessions', '--w--', '2026-01-01_abc.jsonl')
  const root = path.join('C:', 'sessions', '--w--', '2026-01-01_abc')
  assert.equal(childSessionFile(parent, 'run-1', 0), path.join(root, 'run-1', 'run-0', 'session.jsonl'))
  assert.equal(childSessionFile(parent, 'run-1', 2), path.join(root, 'run-1', 'run-2', 'session.jsonl'))
})

test('childSessionFile: 缺参数返回空串，非法 index 归零', () => {
  assert.equal(childSessionFile('', 'run-1'), '')
  assert.equal(childSessionFile('C:/a.jsonl', ''), '')
  assert.equal(childSessionFile(path.join('C:', 'a.jsonl'), 'r'), path.join('C:', 'a', 'r', 'run-0', 'session.jsonl'))
  assert.equal(childSessionFile(path.join('C:', 'a.jsonl'), 'r', -3), path.join('C:', 'a', 'r', 'run-0', 'session.jsonl'))
})
