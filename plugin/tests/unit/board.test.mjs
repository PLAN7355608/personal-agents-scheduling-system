import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { listBoard, normalizeKind, postBoard, removeBoard } from '../../src/board.js'

const T0 = Date.parse('2026-11-27T10:00:00Z')

test('黑板：贴一条能读回来，空文本被拒', () => {
  const db = openDb()
  const bad = postBoard(db, { text: '   ', now: T0 })
  assert.equal(bad.ok, false)
  const r = postBoard(db, { laneId: 'lane_a', workitemId: 'wi_a', kind: 'decision', text: '名单用 xlsx', now: T0 })
  assert.equal(r.ok, true)
  assert.equal(r.post.kind, 'decision')
  const posts = listBoard(db, { laneId: 'lane_a' })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].text, '名单用 xlsx')
  db.close()
})

test('黑板：按线隔离，钉住的全局条对所有线可见', () => {
  const db = openDb()
  postBoard(db, { laneId: 'lane_a', text: '这是 A 线的', now: T0 })
  postBoard(db, { laneId: 'lane_b', text: '这是 B 线的', now: T0 + 1 })
  postBoard(db, { text: '全局约定', pinned: true, now: T0 + 2 })
  const a = listBoard(db, { laneId: 'lane_a' })
  const texts = a.map((p) => p.text)
  assert.ok(texts.includes('这是 A 线的'))
  assert.ok(texts.includes('全局约定'))
  assert.ok(!texts.includes('这是 B 线的'))
  const all = listBoard(db, {})
  assert.equal(all.length, 3)
  db.close()
})

test('黑板：kind 归一化与过滤，删除生效', () => {
  const db = openDb()
  assert.equal(normalizeKind('TODO'), 'todo')
  assert.equal(normalizeKind('乱写'), 'note')
  postBoard(db, { laneId: 'lane_a', kind: 'todo', text: 't1', now: T0 })
  postBoard(db, { laneId: 'lane_a', kind: 'fact', text: 'f1', now: T0 + 1 })
  const todos = listBoard(db, { laneId: 'lane_a', kinds: ['todo'] })
  assert.equal(todos.length, 1)
  assert.equal(todos[0].text, 't1')
  const del = removeBoard(db, todos[0].id)
  assert.equal(del.ok, true)
  assert.equal(listBoard(db, { laneId: 'lane_a' }).length, 1)
  db.close()
})
