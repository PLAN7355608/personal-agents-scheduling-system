import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import {
  armAfterTask, claimOccurrence, createSchedule, dueSchedules, getSchedule,
  listSchedules, occurrenceCount, removeSchedule, setScheduleStatus,
} from '../../src/scheduler.js'

const T0 = Date.parse('2026-11-27T10:00:00Z') // 18:00 Asia/Shanghai

function fresh() {
  return openDb()
}

const tpl = { text: '每天跑一次研究', workspace: '/w', topic: 'research' }

test('计划：every 建好后有 next_run_at，dueSchedules 只到点返回', () => {
  const db = fresh()
  const s = createSchedule(db, { title: '每日研究', kind: 'every', cron: '0 20 * * *', tz: 'Asia/Shanghai', template: tpl, now: T0 })
  assert.equal(new Date(s.nextRunAt).toISOString(), '2026-11-27T12:00:00.000Z')
  assert.equal(dueSchedules(db, { now: T0 }).length, 0)
  assert.equal(dueSchedules(db, { now: s.nextRunAt }).length, 1)
  db.close()
})

test('计划：坏参数直接拒', () => {
  const db = fresh()
  assert.throws(() => createSchedule(db, { title: 'x', kind: 'every', cron: '61 * * * *', template: tpl }), /范围不合法/)
  assert.throws(() => createSchedule(db, { title: 'x', kind: 'every', template: tpl }), /必须给 cron/)
  assert.throws(() => createSchedule(db, { title: 'x', kind: 'at', at: T0 - 1000, template: tpl }), /未来的绝对时间/)
  assert.throws(() => createSchedule(db, { title: 'x', kind: 'after_task', template: tpl }), /anchorTaskId/)
  assert.throws(() => createSchedule(db, { title: 'x', kind: 'every', cron: '0 20 * * *', template: {} }), /template\.text/)
  db.close()
})

test('计划：认领是幂等的（重复 claim 不再触发，occurrence 唯一）', () => {
  const db = fresh()
  const s = createSchedule(db, { title: '每日', kind: 'every', cron: '0 20 * * *', tz: 'Asia/Shanghai', template: tpl, now: T0 })
  const first = claimOccurrence(db, s, { now: s.nextRunAt })
  assert.equal(first.claimed, true)
  assert.equal(first.occurrenceKey, s.id + ':' + s.nextRunAt)

  // 用旧快照再认领一次：version 不匹配 → 拒绝（这正是重启/多进程竞态的防线）
  const again = claimOccurrence(db, s, { now: s.nextRunAt + 1000 })
  assert.equal(again.claimed, false)
  assert.match(again.reason, /version/)
  assert.equal(occurrenceCount(db, s.id), 1)

  // 下一次触发时间应该被推到第二天 20:00
  const after = getSchedule(db, s.id)
  assert.equal(new Date(after.nextRunAt).toISOString(), '2026-11-28T12:00:00.000Z')
  db.close()
})

test('计划：暂停后不再到期；删除后查不到', () => {
  const db = fresh()
  const s = createSchedule(db, { title: '每日', kind: 'every', cron: '0 20 * * *', template: tpl, now: T0 })
  setScheduleStatus(db, s.id, 'paused')
  assert.equal(dueSchedules(db, { now: s.nextRunAt + 1000 }).length, 0)
  assert.equal(listSchedules(db, { status: 'paused' }).length, 1)
  assert.equal(removeSchedule(db, s.id), true)
  assert.equal(getSchedule(db, s.id), null)
  db.close()
})

test('计划：一次性 at 触发后 next_run_at 置空（不重复）', () => {
  const db = fresh()
  const at = T0 + 3600 * 1000
  const s = createSchedule(db, { title: '一次性', kind: 'at', at, template: tpl, now: T0 })
  assert.equal(s.nextRunAt, at)
  const r = claimOccurrence(db, s, { now: at })
  assert.equal(r.claimed, true)
  assert.equal(getSchedule(db, s.id).nextRunAt, null)
  assert.equal(dueSchedules(db, { now: at + 1000 }).length, 0)
  db.close()
})

test('计划：after_task 等锚点任务完成才产生 next_run_at', () => {
  const db = fresh()
  const s = createSchedule(db, { title: '收尾', kind: 'after_task', anchorTaskId: 'wi_parent', delayS: 300, template: tpl, now: T0 })
  assert.equal(s.nextRunAt, null)
  const n = armAfterTask(db, 'wi_parent', { now: T0 })
  assert.equal(n, 1)
  const armed = getSchedule(db, s.id)
  assert.equal(armed.nextRunAt, T0 + 300 * 1000)
  db.close()
})
