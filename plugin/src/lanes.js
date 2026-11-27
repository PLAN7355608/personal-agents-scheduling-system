// 会话泳道（lane）：一条线一个工人，线内串行、线间并行。
// 线身份 = 来源会话（GUI/Relay）或 频道+对方（外部通道）。
import { randomUUID } from 'node:crypto'

export const LANE_STATUS = { IDLE: 'idle', ACTIVE: 'active', CLOSED: 'closed' }
export const SCOPE_MODES = ['auto', 'suggest', 'manual']

export function laneKeyFor({ sessionId, channel, peer, workspace = null, baseWorkspace = null, focus = null, unique = null }) {
  let key = sessionId ? 'session:' + sessionId : 'peer:' + String(channel || 'gui') + ':' + String(peer || 'owner')
  const ws = workspace ? String(workspace).replace(/[\\\\/]+$/, '') : null
  const base = baseWorkspace ? String(baseWorkspace).replace(/[\\\\/]+$/, '') : null
  if (ws && ws !== base) key += '@' + ws
  if (focus) key += '#' + String(focus).replace(/[\\\\/]+$/, '')
  if (unique) key += '~' + unique
  return key
}

function newLaneId() {
  return 'lane_' + Date.now().toString(36) + randomUUID().replace(/-/g, '').slice(0, 6)
}

function toLane(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerId: row.owner_id,
    key: row.key,
    label: row.label,
    scopeMode: row.scope_mode,
    projectRoot: row.project_root,
    scope: row.scope,
    sessionId: row.session_id,
    workspace: row.workspace || null,
    workerType: row.worker_type,
    status: row.status,
    currentWorkitemId: row.current_workitem_id,
    permission: row.permission,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    meta: row.meta ? JSON.parse(row.meta) : null,
    reviewMode: row.review_mode || null,
    lastRevisionId: row.last_revision_id || null,
  }
}

export function getLaneById(db, id) {
  return toLane(db.prepare('SELECT * FROM lanes WHERE id = ?').get(id))
}

export function getLaneByKey(db, ownerId, key) {
  return toLane(db.prepare('SELECT * FROM lanes WHERE owner_id = ? AND key = ?').get(ownerId, key))
}

export function listLanes(db, { ownerId = 'owner', status = null, limit = 20 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM lanes WHERE owner_id = ? AND status = ? ORDER BY last_used_at DESC LIMIT ?').all(ownerId, status, limit)
    : db.prepare('SELECT * FROM lanes WHERE owner_id = ? ORDER BY last_used_at DESC LIMIT ?').all(ownerId, limit)
  return rows.map(toLane)
}

/** 找或建线。scopeMode 只在新建时生效；已有线保留自己的档位。 */
export function ensureLane(db, {
  ownerId = 'owner',
  key,
  label = null,
  scopeMode = 'suggest',
  workerType = null,
  workspace = null,
  now = Date.now(),
} = {}) {
  const existing = getLaneByKey(db, ownerId, key)
  if (existing) {
    if (workspace && !existing.workspace) {
      db.prepare('UPDATE lanes SET workspace = ?, last_used_at = ? WHERE id = ?').run(workspace, now, existing.id)
      return { ...existing, workspace, lastUsedAt: now }
    }
    db.prepare('UPDATE lanes SET last_used_at = ? WHERE id = ?').run(now, existing.id)
    return { ...existing, lastUsedAt: now }
  }
  const id = newLaneId()
  const mode = SCOPE_MODES.includes(scopeMode) ? scopeMode : 'suggest'
  db.prepare(
    `INSERT INTO lanes (id, owner_id, key, label, scope_mode, worker_type, status, workspace, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, key, label, mode, workerType, LANE_STATUS.IDLE, workspace, now, now)
  return getLaneById(db, id)
}

export function setLaneScope(db, laneId, { projectRoot = null, scope = null, scopeMode = null } = {}) {
  const sets = []
  const args = []
  if (projectRoot !== undefined) { sets.push('project_root = ?'); args.push(projectRoot) }
  if (scope !== undefined) { sets.push('scope = ?'); args.push(scope) }
  if (scopeMode && SCOPE_MODES.includes(scopeMode)) { sets.push('scope_mode = ?'); args.push(scopeMode) }
  if (!sets.length) return getLaneById(db, laneId)
  db.prepare(`UPDATE lanes SET ${sets.join(', ')} WHERE id = ?`).run(...args, laneId)
  return getLaneById(db, laneId)
}

export function setLaneMeta(db, laneId, patch = {}) {
  const lane = getLaneById(db, laneId)
  if (!lane) return null
  const meta = { ...(lane.meta || {}), ...patch }
  db.prepare('UPDATE lanes SET meta = ? WHERE id = ?').run(JSON.stringify(meta), laneId)
  return getLaneById(db, laneId)
}

/** 把已有会话登记为某条线的工人（任何预设的会话都行）。 */
export function adoptSession(db, laneId, sessionId, { label = null, permission = null, backfill = false } = {}) {
  const lane = getLaneById(db, laneId)
  if (!lane) throw new Error('线不存在：' + laneId)
  const meta = { ...(lane.meta || {}), adopted: true, adoptedAt: Date.now(), backfill: backfill === true }
  db.prepare(
    'UPDATE lanes SET session_id = ?, permission = COALESCE(?, permission), label = COALESCE(?, label), meta = ?, last_used_at = ? WHERE id = ?',
  ).run(sessionId, permission, label, JSON.stringify(meta), Date.now(), laneId)
  return getLaneById(db, laneId)
}

export function setLaneReview(db, laneId, mode) {
  const v = ['self', 'auto', 'owner', 'model'].includes(String(mode || '')) ? String(mode) : null
  db.prepare('UPDATE lanes SET review_mode = ? WHERE id = ?').run(v, laneId)
  return getLaneById(db, laneId)
}

export function setLaneSession(db, laneId, sessionId, permission = null) {
  db.prepare('UPDATE lanes SET session_id = ?, permission = COALESCE(?, permission), last_used_at = ? WHERE id = ?')
    .run(sessionId, permission, Date.now(), laneId)
}

/** 占用线：同一时刻只允许一个任务（线内串行）。返回 false 表示线忙。 */
export function claimLane(db, laneId, workitemId, now = Date.now()) {
  const lane = getLaneById(db, laneId)
  if (!lane) return false
  if (lane.status === LANE_STATUS.ACTIVE && lane.currentWorkitemId && lane.currentWorkitemId !== workitemId) return false
  db.prepare('UPDATE lanes SET status = ?, current_workitem_id = ?, last_used_at = ? WHERE id = ?')
    .run(LANE_STATUS.ACTIVE, workitemId, now, laneId)
  return true
}

export function releaseLane(db, laneId, { keepSession = true, now = Date.now() } = {}) {
  const lane = getLaneById(db, laneId)
  if (!lane) return null
  db.prepare(
    'UPDATE lanes SET status = ?, current_workitem_id = NULL, session_id = ?, last_used_at = ? WHERE id = ?',
  ).run(LANE_STATUS.IDLE, keepSession ? lane.sessionId : null, now, laneId)
  return getLaneById(db, laneId)
}

/** 线上排队的下一个任务（FIFO）。 */
export function nextQueuedOnLane(db, laneId) {
  return db.prepare(
    "SELECT * FROM workitems WHERE lane_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1",
  ).get(laneId) || null
}

/** 最近完成的同线任务：给新任务注入「上一件事」的上下文。 */
export function laneContext(db, laneId, limit = 2) {
  if (!laneId) return []
  const rows = db.prepare(
    "SELECT id, intent, result FROM workitems WHERE lane_id = ? AND status IN ('done','failed') ORDER BY updated_at DESC LIMIT ?",
  ).all(laneId, limit)
  return rows.map((r) => ({
    intent: r.intent,
    result: r.result,
    artifacts: (() => {
      try {
        return db.prepare('SELECT path FROM artifacts WHERE workitem_id = ?').all(r.id).map((a) => a.path)
      } catch { return [] }
    })(),
  }))
}

/** 空闲太久的线：关会话、置 idle（线本身保留，下次可重建会话）。 */
export function sweepIdleLanes(db, { ttlMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  // 身份不随空闲丢失：只记录"该卸载了"，不清 session_id。
  // 下次派单会尝试 resume 原会话；resume 失败才新建。
  const rows = db.prepare(
    "SELECT * FROM lanes WHERE status = 'idle' AND session_id IS NOT NULL AND last_used_at < ?",
  ).all(now - ttlMs)
  return rows.map(toLane) // 交给调用方决定是否卸载 agent；line 保留 session_id
}

/** 线卡住（当前任务已终态但线没释放）时自动释放。 */
export function repairStuckLanes(db, now = Date.now()) {
  const rows = db.prepare(
    "SELECT l.* FROM lanes l JOIN workitems w ON w.id = l.current_workitem_id WHERE l.status = 'active' AND w.status IN ('done','failed','cancelled','blocked','merged')",
  ).all()
  for (const row of rows) releaseLane(db, row.id, { now })
  return rows.length
}

/** 从任务文本里提取「工作流焦点」：第一个绝对路径的父目录。 */
export function focusFromText(text) {
  const m = String(text || '').match(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?\r\n]+/g) || []
  for (const raw of m) {
    const p = raw.replace(/[),.;:!?]+$/, '').replace(/\\/g, '/')
    const idx = p.lastIndexOf('/')
    if (idx > 0) return p.slice(0, idx)
  }
  return null
}
/** 按「lane_xxx」或「上一单 wi_xxx」找线。给 create_task 的 lane 参数用；找不到返回 null。 */
export function findLaneRef(db, raw) {
  const ref = String(raw || '').trim()
  if (!ref) return null
  if (ref.startsWith('lane_')) return getLaneById(db, ref)
  if (ref.startsWith('wi_')) {
    const row = db.prepare('SELECT lane_id FROM workitems WHERE id = ?').get(ref)
    return row && row.lane_id ? getLaneById(db, row.lane_id) : null
  }
  return null
}

/** 线的摘要（带最近一单），给 secretary_lanes 用。 */
export function laneSummary(db, lane, { limit = 1 } = {}) {
  if (!lane) return null
  let last = null
  try {
    last = db.prepare(
      'SELECT id, status, topic, substr(intent, 1, 80) AS intent, updated_at FROM workitems WHERE lane_id = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(lane.id) || null
  } catch { last = null }
  let tasks = 0
  try { tasks = db.prepare('SELECT COUNT(*) AS c FROM workitems WHERE lane_id = ?').get(lane.id).c } catch { tasks = 0 }
  return {
    id: lane.id,
    label: lane.label,
    workspace: lane.workspace,
    status: lane.status,
    workerSessionId: lane.sessionId,
    permission: lane.permission,
    tasks,
    lastUsedAt: lane.lastUsedAt,
    lastTask: last ? { id: last.id, status: last.status, topic: last.topic, intent: last.intent, updatedAt: last.updated_at } : null,
  }
}
