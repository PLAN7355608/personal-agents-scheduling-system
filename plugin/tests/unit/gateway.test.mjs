import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { countEvents, readEvents } from '../../src/events.js'
import { getWorkItem, listWorkItems } from '../../src/workitems.js'
import { getPolicy, inbound, upsertPolicy } from '../../src/gateway.js'

function dbWithMock() {
  const db = openDb()
  // migration 里已 seed mock 通道（allowed_peers=["tester"]）
  return db
}

test('未知通道直接拒绝', () => {
  const db = dbWithMock()
  const r = inbound(db, { channel: 'nope', peer: 'tester', msgId: 'm1', text: 'hi' })
  assert.equal(r.accepted, false)
  assert.match(r.reason, /unknown channel/)
  db.close()
})

test('白名单外的人拒绝（fail-closed）', () => {
  const db = dbWithMock()
  const r = inbound(db, { channel: 'mock', peer: 'stranger', msgId: 'm2', text: 'hi' })
  assert.equal(r.accepted, false)
  assert.match(r.reason, /peer not allowed/)
  db.close()
})

test('超长文本拒绝（按通道 maxChars）', () => {
  const db = dbWithMock()
  upsertPolicy(db, { channel: 'mock', maxChars: 5 })
  const r = inbound(db, { channel: 'mock', peer: 'tester', msgId: 'm3', text: '这段文字明显超过五个字的限制' })
  assert.equal(r.accepted, false)
  assert.match(r.reason, /too long/)
  db.close()
})

test('限流：超过每分钟上限拒绝', () => {
  const db = dbWithMock()
  upsertPolicy(db, { channel: 'mock', ratePerMin: 2 })
  assert.equal(inbound(db, { channel: 'mock', peer: 'tester', msgId: 'r1', text: 'a' }).accepted, true)
  assert.equal(inbound(db, { channel: 'mock', peer: 'tester', msgId: 'r2', text: 'b' }).accepted, true)
  const third = inbound(db, { channel: 'mock', peer: 'tester', msgId: 'r3', text: 'c' })
  assert.equal(third.accepted, false)
  assert.match(third.reason, /rate limited/)
  db.close()
})

test('正常入站：写 msg.received、建任务、返回 workitemId', () => {
  const db = dbWithMock()
  const r = inbound(db, { channel: 'mock', peer: 'tester', msgId: 'ok-1', text: '把测试文件复制一份' })
  assert.equal(r.accepted, true)
  assert.equal(r.duplicate, false)
  assert.ok(r.workitemId)
  const item = getWorkItem(db, r.workitemId)
  assert.equal(item.sourceChannel, 'mock')
  assert.equal(item.sourcePeer, 'tester')
  assert.equal(item.sourceMsgId, 'ok-1')
  const evs = readEvents(db, { type: 'msg.received' })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].payload.msgId, 'ok-1')
  db.close()
})

test('幂等：同一 msgId 重复投递不产生第二个任务', () => {
  const db = dbWithMock()
  const a = inbound(db, { channel: 'mock', peer: 'tester', msgId: 'dup-1', text: '同一件事' })
  const b = inbound(db, { channel: 'mock', peer: 'tester', msgId: 'dup-1', text: '同一件事' })
  assert.equal(a.accepted, true)
  assert.equal(b.duplicate, true)
  assert.equal(a.workitemId, b.workitemId)
  assert.equal(listWorkItems(db).length, 1)
  db.close()
})

test('策略读取：mock 通道 seed 正确', () => {
  const db = dbWithMock()
  const p = getPolicy(db, 'mock')
  assert.equal(p.mode, 'direct')
  assert.deepEqual(p.allowedPeers, ['tester'])
  db.close()
})
