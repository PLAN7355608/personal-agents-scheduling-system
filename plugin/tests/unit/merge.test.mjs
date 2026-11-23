import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import {
  createWorkItem, getWorkItem, listMergeMembers, mergeWorkItems, rebuildProjection, splitMerged, transition,
} from '../../src/workitems.js'

function queued(db, text, extra = {}) {
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: text, ...extra })
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  return item
}

test('归并：两个 queued 任务合成一个，成员标 merged，成员表留痕', () => {
  const db = openDb()
  const a = queued(db, '把 A 转成 PDF')
  const b = queued(db, '转完发我邮箱')
  const r = mergeWorkItems(db, { memberIds: [a.id, b.id], title: '把 A 转 PDF 并发邮箱', reason: '同一件事分两条说', confidence: 0.9 })
  assert.equal(r.merged.status, 'queued')
  assert.match(r.merged.intent, /转 PDF/)
  assert.equal(getWorkItem(db, a.id).status, 'merged')
  assert.equal(getWorkItem(db, b.id).status, 'merged')
  assert.equal(listMergeMembers(db, r.merged.id).length, 2)
  db.close()
})

test('归并：少于 2 个直接拒绝', () => {
  const db = openDb()
  const a = queued(db, '单独一件事')
  assert.throws(() => mergeWorkItems(db, { memberIds: [a.id] }), /至少需要 2 个/)
  db.close()
})

test('归并：跨人不许合', () => {
  const db = openDb()
  const a = queued(db, '主人 A 的活', { peer: 'owner' })
  const b = queued(db, '别人 B 的活', { peer: 'other' })
  assert.throws(() => mergeWorkItems(db, { memberIds: [a.id, b.id] }), /跨人不许/)
  db.close()
})

test('归并：已经在跑的任务不许合', () => {
  const db = openDb()
  const a = queued(db, '还在排队')
  const b = queued(db, '已经开跑')
  transition(db, b.id, 'running', { reason: 'r' })
  assert.throws(() => mergeWorkItems(db, { memberIds: [a.id, b.id] }), /不能归并/)
  db.close()
})

test('拆回：合并任务取消，成员原文各建一个新任务', () => {
  const db = openDb()
  const a = queued(db, '把 A 转成 PDF')
  const b = queued(db, '转完发我邮箱')
  const r = mergeWorkItems(db, { memberIds: [a.id, b.id], reason: '同一件事', confidence: 0.9 })
  const s = splitMerged(db, r.merged.id)
  assert.equal(getWorkItem(db, r.merged.id).status, 'cancelled')
  assert.equal(s.created.length, 2)
  assert.deepEqual(s.created.map((w) => w.intent).sort(), ['把 A 转成 PDF', '转完发我邮箱'].sort())
  assert.equal(s.created[0].status, 'queued')
  db.close()
})

test('归并后投影可重建（workitems 与事件一致）', () => {
  const db = openDb()
  const a = queued(db, 'x')
  const b = queued(db, 'y')
  mergeWorkItems(db, { memberIds: [a.id, b.id], reason: 'r', confidence: 1 })
  const before = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM workitems ORDER BY id').all()))
  rebuildProjection(db)
  const after = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM workitems ORDER BY id').all()))
  assert.deepEqual(after, before)
  db.close()
})
