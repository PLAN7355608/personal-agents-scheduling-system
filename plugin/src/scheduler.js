// 定时计划：表里只存「下次触发时间 + 表达式」，触发本身是一次幂等认领。
// 关键约束：
//   - next_run_at 是唯一调度依据；
//   - occurrence_key = schedule_id + ':' + scheduled_for，唯一索引防重复触发；
//   - 认领用 CAS（version）推进 next_run_at，多进程/重启都安全。
import { withTransaction } from './db.js'
import { appendEvent } from './events.js'
import { EVENT_TYPE } from './types.js'
import { nextCronAt, parseCron } from './cron.js'

export const SCHEDULE_KINDS = ['at', 'every', 'after_task']
export const SCHEDULE_STATUS = ['active', 'paused', 'expired', 'suspended']

function idOf() {
  return 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 建计划。template 是「建任务参数」的 JSON（text/workspace/topic/model/lane/permission）。 */
export function createSchedule(db, {
  title,
  kind = 'every',
  cron = null,
  tz = 'Asia/Shanghai',
  at = null,
  anchorTaskId = null,
  delayS = 0,
  template = null,
  catchup = 'skip',
  maxPerDay = null,
  cooldownS = null,
  ownerId = 'owner',
  now = Date.now(),
} = {}) {
  const k = String(kind)
  if (!SCHEDULE_KINDS.includes(k)) throw new Error('kind 只能是 ' + SCHEDULE_KINDS.join('/'))
  if (!title || !String(title).trim()) throw new Error('计划要有标题')
  if (!template || !template.text) throw new Error('template.text 不能为空（不然触发时不知道派什么活）')

  let nextRunAt = null
  if (k === 'every') {
    if (!cron) throw new Error('every 计划必须给 cron（5 段，如 "0 20 * * *"）')
    parseCron(cron) // 早失败：表达式不合法直接拒
    nextRunAt = nextCronAt({ cron, tz, from: now })
  } else if (k === 'at') {
    const atMs = Number(at)
    if (!Number.isFinite(atMs) || atMs <= now) throw new Error('at 计划要给未来的绝对时间（epoch ms）')
    nextRunAt = atMs
  } else if (k === 'after_task') {
    if (!anchorTaskId) throw new Error('after_task 必须给 anchorTaskId')
    if (!Number.isFinite(Number(delayS)) || Number(delayS) < 0) throw new Error('delayS 必须是非负数')
    nextRunAt = null // 等锚点任务完成事件来写
  }

  const id = idOf()
  db.prepare(
    `INSERT INTO schedules (id, title, kind, cron, tz, at_ms, anchor_task_id, delay_s, next_run_at,
       last_fired_at, last_evaluated_at, status, catchup, max_per_day, cooldown_until, template_json, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, NULL, ?, 0, ?, ?)`,
  ).run(
    id, String(title).trim(), k, cron, tz, k === 'at' ? Number(at) : null, anchorTaskId,
    k === 'after_task' ? Number(delayS) : null, nextRunAt, now, catchup, maxPerDay ? Number(maxPerDay) : null,
    JSON.stringify(template), now, now,
  )
  try {
    appendEvent(db, {
      type: EVENT_TYPE.SCHEDULE_FIRED,
      ownerId,
      actor: 'owner',
      payload: { action: 'created', scheduleId: id, kind: k, cron, tz, nextRunAt },
    })
  } catch { /* 事件失败不影响计划本身 */ }
  return getSchedule(db, id)
}

export function getSchedule(db, id) {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
  return row ? toSchedule(row) : null
}

function toSchedule(row) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    cron: row.cron,
    tz: row.tz,
    atMs: row.at_ms,
    anchorTaskId: row.anchor_task_id,
    delayS: row.delay_s,
    nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at),
    lastFiredAt: row.last_fired_at === null ? null : Number(row.last_fired_at),
    status: row.status,
    catchup: row.catchup,
    maxPerDay: row.max_per_day === null ? null : Number(row.max_per_day),
    cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
    template: row.template_json ? JSON.parse(row.template_json) : null,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function listSchedules(db, { status = null, limit = 20 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM schedules WHERE status = ? ORDER BY next_run_at IS NULL, next_run_at LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM schedules ORDER BY next_run_at IS NULL, next_run_at LIMIT ?').all(limit)
  return rows.map(toSchedule)
}

export function setScheduleStatus(db, id, status, now = Date.now()) {
  if (!SCHEDULE_STATUS.includes(String(status))) throw new Error('状态不合法：' + status)
  db.prepare('UPDATE schedules SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now, id)
  return getSchedule(db, id)
}

export function removeSchedule(db, id) {
  const n = db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes
  return Number(n) > 0
}

/** 到期计划（按 next_run_at 升序）。 */
export function dueSchedules(db, { now = Date.now(), limit = 5 } = {}) {
  return db.prepare(
    "SELECT * FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
  ).all(now, limit).map(toSchedule)
}

/**
 * 幂等认领一次触发：CAS 推进 next_run_at + 插 occurrence（唯一键），两步同一事务。
 * 返回 { claimed, occurrenceKey, scheduledFor }；已被认领过返回 claimed=false。
 */
export function claimOccurrence(db, schedule, { now = Date.now(), tz = null } = {}) {
  const sched = schedule && schedule.id ? schedule : getSchedule(db, schedule)
  if (!sched) throw new Error('计划不存在')
  const scheduledFor = Number(sched.nextRunAt)
  if (!Number.isFinite(scheduledFor)) return { claimed: false, reason: '没有下次触发时间' }
  const occurrenceKey = sched.id + ':' + scheduledFor

  return withTransaction(db, () => {
    const updated = db.prepare(
      'UPDATE schedules SET next_run_at = ?, last_fired_at = ?, last_evaluated_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
    ).run(computeNext(sched, scheduledFor, tz), now, now, now, sched.id, sched.version)
    if (!Number(updated.changes)) return { claimed: false, reason: '被别的进程认领了（version 不匹配）' }
    try {
      db.prepare(
        'INSERT INTO occurrences (id, schedule_id, occurrence_key, scheduled_for, fired_at, latency_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('occ_' + scheduledFor.toString(36) + Math.random().toString(36).slice(2, 6), sched.id, occurrenceKey, scheduledFor, now, Math.max(0, now - scheduledFor), 'fired')
    } catch (err) {
      // 唯一键冲突：这一格已经被触发过（重启/重复 tick），回滚即可
      if (/UNIQUE/i.test(String(err && err.message))) return { claimed: false, reason: '这一格已触发过' }
      throw err
    }
    return { claimed: true, occurrenceKey, scheduledFor }
  })
}

/** 算下一次：every 用 cron；at 只跑一次（跑完过期）；after_task 由锚点事件再写。 */
export function computeNext(sched, firedAt, tz = null) {
  if (sched.kind === 'every') {
    try {
      return nextCronAt({ cron: sched.cron, tz: tz || sched.tz || 'Asia/Shanghai', from: firedAt })
    } catch {
      return null // 算不出来 → 置空，由 tick 发现并 suspended
    }
  }
  return null // at / after_task 都是一次性
}

/** 触发后把 occurrence 指到建出来的任务。 */
export function attachOccurrence(db, occurrenceKey, workitemId) {
  db.prepare('UPDATE occurrences SET workitem_id = ? WHERE occurrence_key = ?').run(String(workitemId), occurrenceKey)
  return true
}

/** 锚点任务完成后，给 after_task 计划写 next_run_at。 */
export function armAfterTask(db, anchorTaskId, { now = Date.now() } = {}) {
  const rows = db.prepare("SELECT * FROM schedules WHERE kind = 'after_task' AND anchor_task_id = ? AND status = 'active'").all(anchorTaskId)
  for (const row of rows) {
    const sched = toSchedule(row)
    const next = now + Math.max(0, Number(sched.delayS) || 0) * 1000
    db.prepare('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(next, now, sched.id)
  }
  return rows.length
}

export function occurrenceCount(db, scheduleId) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM occurrences WHERE schedule_id = ?').get(scheduleId).c || 0)
}
