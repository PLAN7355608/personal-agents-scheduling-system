// 出站队列：内核写 outbox，adapter 来拉、发完 ack。
// 这样通道挂掉不丢消息，重试有据；内核不直接碰任何通道协议。
import { randomUUID } from 'node:crypto'

function newId() {
  return 'obx_' + Date.now().toString(36) + randomUUID().replace(/-/g, '').slice(0, 8)
}

export function enqueue(db, {
  channel, peer, threadId = null, workitemId = null,
  content, files = [], level = 'L2',
} = {}) {
  const text = String(content || '').trim()
  if (!channel || !peer) throw new Error('enqueue 需要 channel 与 peer')
  if (!text) throw new Error('enqueue 内容不能为空')
  const id = newId()
  db.prepare(
    `INSERT INTO outbox (id, channel, peer, thread_id, workitem_id, content, files, level, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, String(channel), String(peer), threadId, workitemId, text,
    JSON.stringify(Array.isArray(files) ? files : []), String(level), Date.now())
  return db.prepare('SELECT * FROM outbox WHERE id = ?').get(id)
}

export function listPending(db, { channel, afterSeq = 0, limit = 50 } = {}) {
  const where = ["status = 'pending'", 'seq > ?']
  const args = [Number(afterSeq) || 0]
  if (channel) { where.push('channel = ?'); args.push(String(channel)) }
  args.push(Math.max(1, Math.min(200, Number(limit) || 50)))
  return db.prepare(
    `SELECT * FROM outbox WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
  ).all(...args).map(hydrate)
}

const MAX_ATTEMPTS = 5

export function ack(db, id, { ok = true, receipt = null, error = null } = {}) {
  const row = db.prepare('SELECT * FROM outbox WHERE id = ?').get(String(id))
  if (!row) return { ok: false, reason: 'not found' }
  const attempts = Number(row.attempts || 0) + 1
  // 失败先回到 pending 重试；超过上限才进 failed 终态（防止一次网络抖动就丢消息）
  const status = ok ? 'sent' : (attempts >= MAX_ATTEMPTS ? 'failed' : 'pending')
  db.prepare(
    'UPDATE outbox SET status = ?, attempts = ?, sent_at = ?, last_error = ? WHERE id = ?',
  ).run(status, attempts, ok ? Date.now() : null, ok ? null : String(error || 'adapter failed'), String(id))
  return { ok: true, status, attempts }
}

export function stats(db, { channel } = {}) {
  const rows = db.prepare(
    `SELECT channel, status, COUNT(*) AS n FROM outbox ${channel ? 'WHERE channel = ?' : ''} GROUP BY channel, status`,
  ).all(...(channel ? [channel] : []))
  const out = {}
  for (const r of rows) {
    out[r.channel] = out[r.channel] || {}
    out[r.channel][r.status] = Number(r.n)
  }
  return out
}

function hydrate(row) {
  if (!row) return null
  let files = []
  try { files = JSON.parse(row.files || '[]') } catch { files = [] }
  return {
    seq: Number(row.seq),
    id: row.id,
    channel: row.channel,
    peer: row.peer,
    threadId: row.thread_id,
    workitemId: row.workitem_id,
    content: row.content,
    files,
    level: row.level,
    status: row.status,
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
    lastError: row.last_error,
  }
}
