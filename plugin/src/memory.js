// 记忆 v0：事实 / 画像 / 纪事，带来源与时效；可纠正、可遗忘。
// 存储在同一 SQLite；检索先用 FTS5，不可用时退化为 LIKE。
import { randomUUID } from 'node:crypto'
import { appendEvent } from './events.js'
import { EVENT_TYPE } from './types.js'

const ALLOWED_TYPES = new Set(['profile', 'fact', 'episode', 'artifact'])

function newId() {
  return 'mem_' + Date.now().toString(36) + randomUUID().replace(/-/g, '').slice(0, 8)
}

export function remember(db, {
  ownerId = 'owner',
  type = 'fact',
  key = null,
  text,
  tags = '',
  sourceEvent = null,
  sourceWi = null,
  confidence = 1,
} = {}) {
  if (!ALLOWED_TYPES.has(type)) throw new Error('未知记忆类型：' + type)
  const body = String(text || '').trim()
  if (!body) throw new Error('记忆内容不能为空')

  const id = newId()
  const now = Date.now()

  // 同一 (type,key) 的新事实 supersede 旧的（不物理删，留痕可审计）
  let superseded = null
  if (key) {
    const prev = db.prepare(
      `SELECT id FROM memories WHERE owner_id = ? AND type = ? AND key = ? AND deleted_at IS NULL AND superseded_by IS NULL`,
    ).get(ownerId, type, key)
    if (prev) {
      superseded = prev.id
      db.prepare('UPDATE memories SET superseded_by = ?, valid_to = ? WHERE id = ?').run(id, now, prev.id)
    }
  }

  db.prepare(
    `INSERT INTO memories (id, owner_id, type, key, text, tags, source_event, source_wi, confidence, valid_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, type, key, body, String(tags || ''), sourceEvent, sourceWi, Number(confidence) || 1, now, now)

  appendEvent(db, {
    type: EVENT_TYPE.MEMORY_REMEMBER,
    ownerId,
    channel: null,
    actor: 'agent',
    payload: { id, type, key, text: body.slice(0, 200), tags: String(tags || ''), superseded },
  })

  return { id, superseded, type, key, text: body }
}

export function forget(db, { ownerId = 'owner', query } = {}) {
  const q = String(query || '').trim()
  if (!q) throw new Error('忘掉什么？query 不能为空')
  const like = '%' + q + '%'
  const rows = db.prepare(
    `SELECT id FROM memories WHERE owner_id = ? AND deleted_at IS NULL AND (text LIKE ? OR key LIKE ? OR tags LIKE ?)`,
  ).all(ownerId, like, like, like)
  const now = Date.now()
  for (const row of rows) {
    db.prepare('UPDATE memories SET deleted_at = ?, valid_to = ? WHERE id = ?').run(now, now, row.id)
  }
  const ids = rows.map((r) => r.id)
  appendEvent(db, {
    type: EVENT_TYPE.MEMORY_FORGET,
    ownerId,
    channel: null,
    actor: 'agent',
    payload: { query: q, count: ids.length, ids },
  })
  return { forgotten: rows.length, ids }
}

export function recall(db, { ownerId = 'owner', query = '', limit = 5 } = {}) {
  const max = Math.max(1, Math.min(20, Number(limit) || 5))
  const q = String(query || '').trim()
  if (!q) {
    return db.prepare(
      `SELECT * FROM memories WHERE owner_id = ? AND deleted_at IS NULL AND superseded_by IS NULL
        ORDER BY created_at DESC LIMIT ?`,
    ).all(ownerId, max).map(snapshot)
  }
  try {
    const rows = db.prepare(
      `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ? AND m.owner_id = ? AND m.deleted_at IS NULL AND m.superseded_by IS NULL
        ORDER BY rank LIMIT ?`,
    ).all(q, ownerId, max)
    if (rows.length) return rows.map(snapshot)
  } catch {
    /* FTS 语法不认就退化 */
  }
  const like = '%' + q + '%'
  return db.prepare(
    `SELECT * FROM memories WHERE owner_id = ? AND deleted_at IS NULL AND superseded_by IS NULL
      AND (text LIKE ? OR key LIKE ? OR tags LIKE ?) ORDER BY created_at DESC LIMIT ?`,
  ).all(ownerId, like, like, like, max).map(snapshot)
}

/** 注入用：profile 全量（受字数限制）+ 最近的 fact。注入不是真相，只是提示。 */
export function injectionFacts(db, { ownerId = 'owner', limit = 5, maxChars = 1200 } = {}) {
  const out = []
  const profiles = db.prepare(
    `SELECT * FROM memories WHERE owner_id = ? AND type = 'profile' AND deleted_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC`,
  ).all(ownerId)
  let used = 0
  for (const row of profiles) {
    const line = '画像：' + row.text
    if (used + line.length > maxChars) break
    out.push(line)
    used += line.length + 1
  }
  const facts = db.prepare(
    `SELECT * FROM memories WHERE owner_id = ? AND type = 'fact' AND deleted_at IS NULL AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT ?`,
  ).all(ownerId, Math.max(1, Math.min(20, Number(limit) || 5)))
  for (const row of facts) {
    const line = '- ' + row.text
    if (used + line.length > maxChars) break
    out.push(line)
    used += line.length + 1
  }
  return out
}

export function stats(db, { ownerId = 'owner' } = {}) {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN deleted_at IS NULL AND superseded_by IS NULL THEN 1 ELSE 0 END) AS active
       FROM memories WHERE owner_id = ?`,
  ).get(ownerId)
  return { total: Number(row.total || 0), active: Number(row.active || 0) }
}

function snapshot(row) {
  if (!row) return null
  return {
    id: row.id,
    type: row.type,
    key: row.key,
    text: row.text,
    tags: row.tags,
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
    supersededBy: row.superseded_by,
    deletedAt: row.deleted_at,
  }
}
