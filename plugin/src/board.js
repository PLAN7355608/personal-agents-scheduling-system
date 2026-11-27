// 共享黑板：同一条线上的工人把结论/待办/决定贴上来，后来的工人（以及主人）能读到。
// 只做「贴条 + 读条」，不做消息推送——黑板是共享状态，不是聊天。
import { newId } from './events.js'

export const BOARD_KINDS = ['note', 'fact', 'todo', 'decision', 'blocked']

export function normalizeKind(kind) {
  const k = String(kind || '').trim().toLowerCase()
  return BOARD_KINDS.includes(k) ? k : 'note'
}

export function postBoard(db, { ownerId = 'owner', laneId = null, workitemId = null, kind = 'note', text, pinned = false, now = Date.now() } = {}) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, reason: 'text 不能为空' }
  if (body.length > 4000) return { ok: false, reason: '一条最多 4000 字，太长的内容请放文件再贴路径' }
  const id = newId('bp_')
  db.prepare(
    `INSERT INTO board_posts (id, owner_id, lane_id, workitem_id, kind, text, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, laneId, workitemId, normalizeKind(kind), body, pinned ? 1 : 0, now, now)
  return { ok: true, post: toPost(db.prepare('SELECT * FROM board_posts WHERE id = ?').get(id)) }
}

function toPost(row) {
  if (!row) return null
  return {
    id: row.id,
    laneId: row.lane_id,
    workitemId: row.workitem_id,
    kind: row.kind,
    text: row.text,
    pinned: !!row.pinned,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 读黑板：给了 laneId 只读这条线（pinned 的全局条也带上），不给就读最近的全量。 */
export function listBoard(db, { ownerId = 'owner', laneId = null, kinds = null, limit = 50, since = null } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50))
  const where = ['owner_id = ?']
  const args = [ownerId]
  if (laneId) {
    where.push('(lane_id = ? OR pinned = 1 OR lane_id IS NULL)')
    args.push(laneId)
  }
  if (kinds && kinds.length) {
    where.push('kind IN (' + kinds.map(() => '?').join(',') + ')')
    args.push(...kinds)
  }
  if (since) {
    where.push('created_at > ?')
    args.push(Number(since))
  }
  const rows = db.prepare(
    `SELECT * FROM board_posts WHERE ${where.join(' AND ')} ORDER BY pinned DESC, created_at DESC LIMIT ?`,
  ).all(...args, lim)
  return rows.map(toPost)
}

export function removeBoard(db, id, { ownerId = 'owner' } = {}) {
  const r = db.prepare('DELETE FROM board_posts WHERE id = ? AND owner_id = ?').run(String(id), ownerId)
  return { ok: Number(r.changes || 0) > 0 }
}
