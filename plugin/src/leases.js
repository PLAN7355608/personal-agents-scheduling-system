// 文件写租约：同路径同一时间只允许一个任务写（读不限制）。
// 目的：两条线的工人同时改同一个文件时，后一个直接被拦下来，而不是互相覆盖后才发现。
import { resolve } from 'node:path'

export function normalizeLeasePath(p, platform = process.platform) {
  const abs = resolve(String(p || ''))
  return platform === 'win32' ? abs.replace(/\//g, '\\').toLowerCase() : abs
}

/** 申请（或续约）写租约。被别的任务占用且未过期 → { ok:false, holder }。 */
export function acquireLease(db, { path, workitemId, ttlMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const key = normalizeLeasePath(path)
  if (!key || !workitemId) throw new Error('租约需要 path 与 workitemId')
  const row = db.prepare('SELECT * FROM file_leases WHERE path = ?').get(key)
  if (row) {
    if (row.workitem_id === workitemId) {
      db.prepare('UPDATE file_leases SET expires_at = ? WHERE path = ?').run(now + ttlMs, key)
      return { ok: true, renewed: true, holder: workitemId, path: key }
    }
    if (Number(row.expires_at) > now) {
      return { ok: false, holder: row.workitem_id, expiresAt: Number(row.expires_at), path: key }
    }
  }
  db.prepare(
    `INSERT INTO file_leases (path, workitem_id, mode, acquired_at, expires_at) VALUES (?, ?, 'write', ?, ?)
     ON CONFLICT(path) DO UPDATE SET workitem_id = excluded.workitem_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
  ).run(key, workitemId, now, now + ttlMs)
  return { ok: true, holder: workitemId, path: key, takenFrom: row ? row.workitem_id : null }
}

export function releaseLease(db, { path, workitemId } = {}) {
  const key = normalizeLeasePath(path)
  const row = db.prepare('SELECT workitem_id FROM file_leases WHERE path = ?').get(key)
  if (!row || (workitemId && row.workitem_id !== workitemId)) return false
  db.prepare('DELETE FROM file_leases WHERE path = ?').run(key)
  return true
}

export function releaseItemLeases(db, workitemId) {
  return Number(db.prepare('DELETE FROM file_leases WHERE workitem_id = ?').run(String(workitemId)).changes || 0)
}

export function listLeases(db, { now = Date.now() } = {}) {
  return db.prepare('SELECT * FROM file_leases ORDER BY acquired_at DESC').all().map((r) => ({
    path: r.path,
    workitemId: r.workitem_id,
    acquiredAt: Number(r.acquired_at),
    expiresAt: Number(r.expires_at),
    expired: Number(r.expires_at) <= now,
  }))
}

/** 清掉过期租约；给 watchdog 每轮调用。 */
export function expireLeases(db, { now = Date.now() } = {}) {
  return Number(db.prepare('DELETE FROM file_leases WHERE expires_at <= ?').run(now).changes || 0)
}
