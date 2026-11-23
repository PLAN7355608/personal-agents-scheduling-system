import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { appendEvent } from '../../src/events.js'
import { countL3Today, decideDelivery, deliveryBudget, isQuietHour } from '../../src/reporter.js'

test('isQuietHour：跨午夜区间正确判断', () => {
  assert.equal(isQuietHour(23, [23, 8]), true)
  assert.equal(isQuietHour(3, [23, 8]), true)
  assert.equal(isQuietHour(8, [23, 8]), false)
  assert.equal(isQuietHour(12, [23, 8]), false)
  assert.equal(isQuietHour(10, [10, 12]), true)
  assert.equal(isQuietHour(12, [10, 12]), false)
})

test('完成 → L2；需要人且预算充足 → L3', () => {
  assert.equal(decideDelivery({ kind: 'done' }).level, 'L2')
  const d = decideDelivery({ kind: 'blocked', needsHuman: true, ownerHour: 14, quietHours: [23, 8], l3Used: 0, l3Budget: 6 })
  assert.equal(d.level, 'L3')
  assert.match(d.reason, /需要主人处理/)
})

test('出错但不需要人 → 只回对话（L2）', () => {
  assert.equal(decideDelivery({ kind: 'failed', needsHuman: false }).level, 'L2')
})

test('静音时段：L3 降为 L2，并说明原因', () => {
  const d = decideDelivery({ kind: 'blocked', needsHuman: true, ownerHour: 2, quietHours: [23, 8], l3Used: 0, l3Budget: 6 })
  assert.equal(d.level, 'L2')
  assert.match(d.reason, /静音时段/)
})

test('预算用完：L3 降为 L2，并说明原因', () => {
  const d = decideDelivery({ kind: 'blocked', needsHuman: true, ownerHour: 14, quietHours: [23, 8], l3Used: 6, l3Budget: 6 })
  assert.equal(d.level, 'L2')
  assert.match(d.reason, /预算已用完/)
})

test('countL3Today / deliveryBudget：只数今天已发出的 L3', () => {
  const db = openDb()
  const now = Date.now()
  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  appendEvent(db, { type: 'delivery.decided', actor: 'kernel', ts: today.getTime(), payload: { level: 'L3', reason: 'x' } })
  appendEvent(db, { type: 'delivery.decided', actor: 'kernel', ts: today.getTime(), payload: { level: 'L3', reason: 'y' } })
  appendEvent(db, { type: 'delivery.decided', actor: 'kernel', ts: today.getTime(), payload: { level: 'L2', reason: 'z' } })
  assert.equal(countL3Today(db, { now }), 2)
  const b = deliveryBudget(db, { now, budget: 6 })
  assert.deepEqual({ used: b.l3Used, remaining: b.remaining }, { used: 2, remaining: 4 })
  db.close()
})
