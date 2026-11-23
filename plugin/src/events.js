// 事件账本：append-only。写事件是唯一记录真相的方式；状态表只是投影。
import { randomUUID } from 'node:crypto'
import { EVENT_TYPES, OWNER_DEFAULT } from './types.js'

let seqFallback = 0

export function newId(prefix) {
  const t = Date.now().toString(36)
  const r = randomUUID().replace(/-/g, '').slice(0, 10)
  return `${prefix}_${t}${r}`
}

export function appendEvent(db, evt) {
  const {
    type,
    ownerId = OWNER_DEFAULT,
    workitemId = null,
    sessionId = null,
    channel = null,
    peer = null,
    actor,
    payload = {},
    ts = Date.now(),
    schemaVersion = 1,
  } = evt

  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`未知事件类型：${type}（只允许 types.js 里的白名单）`)
  }
  if (!actor || typeof actor !== 'string') throw new Error('事件必须有 actor')
  if (payload === null || typeof payload !== 'object') throw new Error('payload 必须是对象')

  const id = newId('evt')
  db.prepare(
    `INSERT INTO events (id, ts, owner_id, type, schema_version, workitem_id, session_id, channel, peer, actor, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ts, ownerId, type, schemaVersion, workitemId, sessionId, channel, peer, actor, JSON.stringify(payload))

  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id)
  return hydrateEvent(row)
}

export function readEvents(db, { workitemId, type, sinceSeq = 0, limit = 1000 } = {}) {
  const where = ['seq > ?']
  const args = [sinceSeq]
  if (workitemId) { where.push('workitem_id = ?'); args.push(workitemId) }
  if (type) { where.push('type = ?'); args.push(type) }
  args.push(Math.max(1, Math.min(10000, limit)))
  const rows = db.prepare(
    `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
  ).all(...args)
  return rows.map(hydrateEvent)
}

export function latestSeq(db) {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get()
  return Number(row.s)
}

export function countEvents(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM events').get()
  return Number(row.n)
}

function hydrateEvent(row) {
  if (!row) return null
  let payload = {}
  try { payload = JSON.parse(row.payload) } catch { payload = { _parseError: true } }
  return {
    seq: Number(row.seq),
    id: row.id,
    ts: Number(row.ts),
    ownerId: row.owner_id,
    type: row.type,
    schemaVersion: Number(row.schema_version),
    workitemId: row.workitem_id,
    sessionId: row.session_id,
    channel: row.channel,
    peer: row.peer || null,
    actor: row.actor,
    payload,
  }
}
