// 工具治理 M1：申请 → 人工审批 → 按范围生效（once/lane/global），全程留痕。
import { randomUUID } from 'node:crypto'

export const TOOL_REQUEST_STATUS = ['pending', 'allowed', 'denied', 'forbidden', 'escalated', 'expired']
export const TOOL_SCOPES = ['once', 'lane', 'global']

// 黑名单：逃生口 / 改运行时 / 对外发消息 / 物理设备 / 再开子代理 —— 申请也不给
const FORBIDDEN = [
  /^ego_/,
  /^plugin_manager$/,
  /^plugin_market$/,
  /^dsh_im_/,
  /^printer_/,
  /^scanner_/,
  /^ksp_/,
  /^subagent/,
]

export function toolRequestForbidden(tool) {
  const n = String(tool || '')
  return FORBIDDEN.some((re) => re.test(n))
}

function newId() {
  return 'treq_' + Date.now().toString(36) + randomUUID().replace(/-/g, '').slice(0, 6)
}

export function getToolRequest(db, id) {
  const row = db.prepare('SELECT * FROM tool_requests WHERE id = ?').get(id)
  if (!row) return null
  return {
    id: row.id,
    ownerId: row.owner_id,
    laneId: row.lane_id,
    workitemId: row.workitem_id,
    sessionId: row.session_id,
    tool: row.tool,
    reason: row.reason,
    wantScope: row.want_scope,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    scopeGranted: row.scope_granted,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

/** 建申请：黑名单直接 forbidden；同一任务/工具已有 pending 就复用。 */
export function createToolRequest(db, {
  ownerId = 'owner',
  laneId = null,
  workitemId = null,
  sessionId = null,
  tool,
  reason = '',
  wantScope = 'once',
  now = Date.now(),
} = {}) {
  const name = String(tool || '').trim()
  if (!name) throw new Error('tool 不能为空')
  const scope = TOOL_SCOPES.includes(wantScope) ? wantScope : 'once'
  const existing = db.prepare(
    "SELECT * FROM tool_requests WHERE owner_id = ? AND workitem_id IS ? AND tool = ? AND status IN ('pending','escalated') ORDER BY created_at DESC LIMIT 1",
  ).get(ownerId, workitemId, name)
  if (existing) return getToolRequest(db, existing.id)

  const status = toolRequestForbidden(name) ? 'forbidden' : 'pending'
  const id = newId()
  db.prepare(
    `INSERT INTO tool_requests (id, owner_id, lane_id, workitem_id, session_id, tool, reason, want_scope, status, decided_by, decided_at, scope_granted, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(id, ownerId, laneId, workitemId, sessionId, name, String(reason || ''), scope, status,
    status === 'forbidden' ? 'rule' : null, status === 'forbidden' ? now : null, now)
  return getToolRequest(db, id)
}

/** 主人/Relay 决定：批准或拒绝。批准会按范围写 expires_at。 */
export function decideToolRequest(db, id, {
  approve,
  scope = null,
  decidedBy = 'owner',
  now = Date.now(),
  laneTtlMs = 24 * 60 * 60 * 1000,
} = {}) {
  const req = getToolRequest(db, id)
  if (!req) throw new Error('申请不存在：' + id)
  if (req.status === 'forbidden') throw new Error('黑名单工具不能批准：' + req.tool)
  if (req.status !== 'pending' && req.status !== 'escalated') throw new Error('这个申请已经处理过了：' + req.status)

  if (!approve) {
    db.prepare("UPDATE tool_requests SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ?")
      .run(decidedBy, now, id)
    return getToolRequest(db, id)
  }
  let granted = TOOL_SCOPES.includes(scope) ? scope : (req.wantScope || 'once')
  // global 只给低危只读工具；写入/终端等即使申请 global 也降为 lane（避免一次长期免审）
  const SAFE_GLOBAL = /^(read|glob|grep|list_|office_status|univer_lint|univer_inspect)$/
  if (granted === 'global' && !SAFE_GLOBAL.test(String(req.tool || ''))) granted = 'lane'
  const expires = granted === 'once' ? now + 60 * 60 * 1000
    : granted === 'lane' ? now + Math.max(60000, Number(laneTtlMs) || laneTtlMs)
      : now + 90 * 24 * 60 * 60 * 1000
  db.prepare("UPDATE tool_requests SET status = 'allowed', decided_by = ?, decided_at = ?, scope_granted = ?, expires_at = ? WHERE id = ?")
    .run(decidedBy, now, granted, expires, id)
  return getToolRequest(db, id)
}

/** 该工具在当前任务/线上是否有有效授权。 */
export function hasToolGrant(db, { tool, workitemId = null, laneId = null, now = Date.now() } = {}) {
  const name = String(tool || '')
  if (!name) return false
  const rows = db.prepare(
    "SELECT * FROM tool_requests WHERE tool = ? AND status = 'allowed' AND (expires_at IS NULL OR expires_at > ?)",
  ).all(name, now)
  for (const r of rows) {
    if (r.scope_granted === 'global') return true
    if (r.scope_granted === 'lane' && laneId && r.lane_id === laneId) return true
    if (r.scope_granted === 'once' && workitemId && r.workitem_id === workitemId) return true
  }
  return false
}

/** judge 拿不准：标 escalated，等主人拍板。 */
export function escalateToolRequest(db, id, { decidedBy = 'judge', now = Date.now() } = {}) {
  const req = getToolRequest(db, id)
  if (!req) throw new Error('申请不存在：' + id)
  if (req.status !== 'pending') return req
  db.prepare("UPDATE tool_requests SET status = 'escalated', decided_by = ?, decided_at = ? WHERE id = ?")
    .run(decidedBy, now, id)
  return getToolRequest(db, id)
}

/** M3 策略学习：这条线/全局以前批准过同一个工具 → 直接放行（不再打扰主人）。 */
export function learnedToolGrant(db, { tool, laneId = null, ownerId = 'owner' } = {}) {
  const name = String(tool || '')
  if (!name) return null
  const now = Date.now()
  const global = db.prepare(
    "SELECT 1 FROM tool_requests WHERE owner_id = ? AND tool = ? AND status = 'allowed' AND scope_granted = 'global' AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
  ).get(ownerId, name, now)
  if (global) return { allow: true, source: 'global' }
  if (laneId) {
    const lane = db.prepare(
      "SELECT 1 FROM tool_requests WHERE owner_id = ? AND tool = ? AND status = 'allowed' AND scope_granted = 'lane' AND lane_id = ? LIMIT 1",
    ).get(ownerId, name, laneId)
    if (lane) return { allow: true, source: 'lane' }
  }
  return null
}

export function listToolRequests(db, { ownerId = 'owner', status = null, limit = 20 } = {}) {
  const rows = status
    ? db.prepare('SELECT id FROM tool_requests WHERE owner_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(ownerId, status, limit)
    : db.prepare('SELECT id FROM tool_requests WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?').all(ownerId, limit)
  return rows.map((r) => getToolRequest(db, r.id))
}

export function countPendingToolRequests(db, { ownerId = 'owner' } = {}) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_requests WHERE owner_id = ? AND status IN ('pending','escalated')").get(ownerId)
  return Number(row.n || 0)
}
