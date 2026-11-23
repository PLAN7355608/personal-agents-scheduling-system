import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { ack, enqueue, listPending, stats } from '../../src/outbox.js'

test('enqueue / listPending：按 seq 升序、可按通道过滤', () => {
  const db = openDb()
  enqueue(db, { channel: 'mock', peer: 'tester', content: '第一条' })
  enqueue(db, { channel: 'mock', peer: 'tester', content: '第二条' })
  enqueue(db, { channel: 'other', peer: 'x', content: '别的通道' })
  const mockItems = listPending(db, { channel: 'mock' })
  assert.equal(mockItems.length, 2)
  assert.deepEqual(mockItems.map((i) => i.content), ['第一条', '第二条'])
  assert.equal(listPending(db, { afterSeq: mockItems[1].seq }).length, 1)
  db.close()
})

test('ack：成功 → sent；失败先重试，5 次后 failed', () => {
  const db = openDb()
  const a = enqueue(db, { channel: 'mock', peer: 'tester', content: '成功' })
  const b = enqueue(db, { channel: 'mock', peer: 'tester', content: '失败' })
  assert.deepEqual(ack(db, a.id, { ok: true, receipt: 'r1' }), { ok: true, status: 'sent', attempts: 1 })
  const first = ack(db, b.id, { ok: false, error: 'network' })
  assert.deepEqual(first, { ok: true, status: 'pending', attempts: 1 })
  assert.equal(listPending(db, { channel: 'mock' }).length, 1) // 还在 pending 等重试
  let last = first
  for (let i = 0; i < 4; i += 1) last = ack(db, b.id, { ok: false, error: 'network' })
  assert.deepEqual(last, { ok: true, status: 'failed', attempts: 5 })
  assert.equal(listPending(db, { channel: 'mock' }).length, 0)
  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(b.id)
  assert.equal(row.last_error, 'network')
  assert.equal(Number(row.attempts), 5)
  db.close()
})

test('enqueue：缺 channel/内容直接拒绝', () => {
  const db = openDb()
  assert.throws(() => enqueue(db, { peer: 'x', content: 'y' }), /channel/)
  assert.throws(() => enqueue(db, { channel: 'mock', peer: 'x', content: '' }), /内容不能为空/)
  db.close()
})

test('stats：按通道与状态汇总', () => {
  const db = openDb()
  const a = enqueue(db, { channel: 'mock', peer: 'tester', content: 'x' })
  enqueue(db, { channel: 'mock', peer: 'tester', content: 'y' })
  ack(db, a.id, { ok: true })
  const s = stats(db)
  assert.equal(s.mock.pending, 1)
  assert.equal(s.mock.sent, 1)
  db.close()
})
