import test from 'node:test'
import assert from 'node:assert/strict'
import { describeCron, localParts, nextCronAt, parseCron } from '../../src/cron.js'
import { applyHysteresis, decideAdmission, isOverloaded, planConcurrency } from '../../src/resources.js'

test('cron：解析 5 段与常用写法', () => {
  const spec = parseCron('30 20 * * 1-5')
  assert.deepEqual(spec.minutes, [30])
  assert.deepEqual(spec.hours, [20])
  assert.deepEqual(spec.weekdays, [1, 2, 3, 4, 5])
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45])
  assert.deepEqual(parseCron('0 9,18 * * *').hours, [9, 18])
})

test('cron：坏表达式要报错', () => {
  assert.throws(() => parseCron('* * * *'), /5 段/)
  assert.throws(() => parseCron('60 * * * *'), /范围不合法/)
  assert.throws(() => parseCron('* 24 * * *'), /范围不合法/)
  assert.throws(() => parseCron('*/0 * * * *'), /步长/)
  assert.throws(() => parseCron('0 0 0 * *'), /范围不合法/)
})

test('cron：每日 20:00（Asia/Shanghai）', () => {
  // 2026-11-27 18:00 +08:00 = 10:00Z
  const from = Date.parse('2026-11-27T10:00:00Z')
  const next = nextCronAt({ cron: '0 20 * * *', tz: 'Asia/Shanghai', from })
  assert.equal(new Date(next).toISOString(), '2026-11-27T12:00:00.000Z')
  // 20:01 之后就是第二天
  const later = nextCronAt({ cron: '0 20 * * *', tz: 'Asia/Shanghai', from: next })
  assert.equal(new Date(later).toISOString(), '2026-11-28T12:00:00.000Z')
})

test('cron：每 30 分钟', () => {
  const from = Date.parse('2026-11-27T10:05:00Z')
  const next = nextCronAt({ cron: '*/30 * * * *', tz: 'UTC', from })
  assert.equal(new Date(next).toISOString(), '2026-11-27T10:30:00.000Z')
})

test('cron：工作日 09:00 只在周一到周五', () => {
  // 2026-11-28 是周六
  const from = Date.parse('2026-11-28T00:00:00Z')
  const next = nextCronAt({ cron: '0 9 * * 1-5', tz: 'Asia/Shanghai', from })
  const local = localParts(next, 'Asia/Shanghai')
  assert.equal(local.weekday, 1) // 周一
  assert.equal(local.H, 9)
})

test('cron：DST 跳过的本地时间不触发（America/New_York 2026-03-08 02:30 不存在）', () => {
  const from = Date.parse('2026-03-07T12:00:00Z')
  const next = nextCronAt({ cron: '30 2 * * *', tz: 'America/New_York', from })
  assert.equal(new Date(next).toISOString(), '2026-03-09T06:30:00.000Z')
})

test('cron：人话描述', () => {
  assert.equal(describeCron('0 20 * * *'), '每天 20:00')
  assert.equal(describeCron('*/30 * * * *'), '每 30 分钟')
  assert.equal(describeCron('30 6 * * 0'), '每周 Sun 06:30')
})

test('资源：4G 以下一律单并发；内存不够也压到 1', () => {
  const small = planConcurrency({ hardware: { cores: 8, totalMB: 3900, freeMB: 1200 } })
  assert.equal(small.desired, 1)
  const big = planConcurrency({ hardware: { cores: 8, totalMB: 16000, freeMB: 12000 } })
  assert.ok(big.desired >= 2)
  const tight = planConcurrency({ hardware: { cores: 16, totalMB: 32000, freeMB: 900 } })
  assert.equal(tight.desired, 1)
})

test('资源：滞回——升要连续确认，降立刻生效', () => {
  let r = applyHysteresis({ current: 1, desired: 3, streak: 0, confirmRounds: 3 })
  assert.equal(r.next, 1)
  assert.equal(r.streak, 1)
  r = applyHysteresis({ current: 1, desired: 3, streak: r.streak, confirmRounds: 3 })
  assert.equal(r.next, 1)
  r = applyHysteresis({ current: 1, desired: 3, streak: r.streak, confirmRounds: 3 })
  assert.equal(r.next, 3)
  const down = applyHysteresis({ current: 3, desired: 1, streak: 2 })
  assert.equal(down.next, 1)
  assert.equal(down.streak, 0)
})

test('资源：准入判断按 plan.desired', () => {
  const plan = { desired: 2, reason: 'test' }
  assert.equal(decideAdmission({ plan, running: 1 }).allow, true)
  assert.equal(decideAdmission({ plan, running: 2 }).allow, false)
})

test('资源：过载判定要两项以上', () => {
  const sample = { availMB: 300, totalMB: 8000, load1: 20, loadKnown: true, cores: 4 }
  assert.equal(isOverloaded(sample).overloaded, true)
  const mild = { availMB: 300, totalMB: 8000, load1: 1, loadKnown: true, cores: 4 }
  assert.equal(isOverloaded(mild).overloaded, false)
})
