// 清理 v0：只删「投影里的终态旧任务」，事件账本永远保留（可审计）。
// 默认 dry-run：先列清单，主人确认后才真删。
import { withTransaction } from './db.js'
import { appendEvent } from './events.js'
import { EVENT_TYPE } from './types.js'

const DEFAULT_STATUSES = ['done', 'failed', 'cancelled']

export function previewPrune(db, { ownerId = 'owner', days = 30, statuses = DEFAULT_STATUSES } = {}) {
  const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 86400000
  const marks = statuses.map(() => '?').join(', ')
  const rows = db.prepare(
    `SELECT id, status, intent, created_at, updated_at
       FROM workitems
      WHERE owner_id = ? AND updated_at < ? AND status IN (${marks})
      ORDER BY updated_at ASC`,
  ).all(ownerId, cutoff, ...statuses)
  return {
    days: Number(days) || 30,
    cutoff,
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      intent: String(r.intent || '').slice(0, 80),
      updatedAt: Number(r.updated_at),
    })),
  }
}

export function runPrune(db, { ownerId = 'owner', days = 30, statuses = DEFAULT_STATUSES } = {}) {
  const preview = previewPrune(db, { ownerId, days, statuses })
  if (preview.count === 0) return { deleted: 0, ids: [] }
  return withTransaction(db, () => {
    const ids = preview.items.map((i) => i.id)
    const marks = ids.map(() => '?').join(', ')
    appendEvent(db, { type: EVENT_TYPE.WORKITEM_PRUNED, ownerId, actor: 'owner', payload: { ids, days } })
    db.prepare(`DELETE FROM merge_members WHERE merged_workitem_id IN (${marks}) OR member_workitem_id IN (${marks})`)
      .run(...ids, ...ids)
    db.prepare(`DELETE FROM workitems WHERE id IN (${marks})`).run(...ids)
    return { deleted: ids.length, ids }
  })
}
