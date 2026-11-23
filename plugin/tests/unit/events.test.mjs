import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { appendEvent, countEvents, latestSeq, readEvents } from '../../src/events.js'

function fresh() {
  return openDb() // :memory:
}

test('appendEvent：写入、seq 递增、payload 往返', () => {
  const db = fresh()
  const e1 = appendEvent(db, { type: 'msg.received', actor: 'owner', channel: 'gui', payload: { text: '你好' } })
  const e2 = appendEvent(db, { type: 'msg.received', actor: 'owner', channel: 'gui', payload: { text: '再来' } })
  assert.equal(e1.seq, 1)
  assert.equal(e2.seq, 2)
  assert.equal(e1.payload.text, '你好')
  assert.equal(latestSeq(db), 2)
  assert.equal(countEvents(db), 2)
  db.close()
})

test('appendEvent：未知事件类型直接拒绝', () => {
  const db = fresh()
  assert.throws(() => appendEvent(db, { type: 'made.up', actor: 'kernel' }), /未知事件类型/)
  db.close()
})

test('appendEvent：必须有 actor、payload 必须是对象', () => {
  const db = fresh()
  assert.throws(() => appendEvent(db, { type: 'error', payload: {} }), /actor/)
  assert.throws(() => appendEvent(db, { type: 'error', actor: 'kernel', payload: 'x' }), /payload/)
  db.close()
})

test('readEvents：按任务/类型过滤，按 seq 升序', () => {
  const db = fresh()
  appendEvent(db, { type: 'item.created', actor: 'kernel', workitemId: 'wi_1', payload: { a: 1 } })
  appendEvent(db, { type: 'item.state', actor: 'kernel', workitemId: 'wi_1', payload: { b: 2 } })
  appendEvent(db, { type: 'item.created', actor: 'kernel', workitemId: 'wi_2', payload: { c: 3 } })

  const forWi1 = readEvents(db, { workitemId: 'wi_1' })
  assert.equal(forWi1.length, 2)
  assert.deepEqual(forWi1.map((e) => e.seq), [1, 2])

  const created = readEvents(db, { type: 'item.created' })
  assert.equal(created.length, 2)

  const after = readEvents(db, { sinceSeq: 2 })
  assert.equal(after.length, 1)
  assert.equal(after[0].workitemId, 'wi_2')
  db.close()
})
