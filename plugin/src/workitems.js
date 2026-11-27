// WorkItem 状态机：全系统唯一允许改任务状态的地方。
// 规则：先写事件、再改投影，同一事务；每次转移必须带 reason；done 只能经 finish()。
import { appendEvent } from './events.js'
import { withTransaction } from './db.js'
import { ACTOR, EVENT_TYPE, ITEM_STATUS, OWNER_DEFAULT, TERMINAL_STATUS, TRANSITIONS } from './types.js'

const COLUMNS = [
  'id', 'created_at', 'updated_at', 'owner_id', 'source_channel', 'source_peer', 'source_msg_id',
  'kind', 'intent', 'topic', 'status', 'priority', 'needs_human', 'deadline', 'budget',
  'parent_id', 'worker_type', 'session_id', 'inputs', 'permission', 'lane_id', 'workspace', 'origin', 'project_root', 'scope', 'scope_source', 'scope_confidence', 'result', 'error', 'attempts', 'metrics', 'model', 'source_session_id', 'notify', 'acceptance', 'evidence', 'submitted_at', 'review_mode',
]

function snapshot(row) {
  if (!row) return null
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ownerId: row.owner_id,
    sourceChannel: row.source_channel,
    sourcePeer: row.source_peer,
    sourceMsgId: row.source_msg_id,
    kind: row.kind,
    intent: row.intent,
    topic: row.topic,
    status: row.status,
    priority: Number(row.priority),
    needsHuman: !!row.needs_human,
    deadline: row.deadline === null ? null : Number(row.deadline),
    budget: row.budget ? safeJson(row.budget) : null,
    parentId: row.parent_id,
    workerType: row.worker_type,
    sessionId: row.session_id,
    inputs: row.inputs ? safeJson(row.inputs) : null,
    permission: row.permission || null,
    laneId: row.lane_id || null,
    workspace: row.workspace || null,
    origin: row.origin || null,
    projectRoot: row.project_root || null,
    scope: row.scope || null,
    scopeSource: row.scope_source || null,
    scopeConfidence: row.scope_confidence ?? null,
    result: row.result,
    error: row.error,
    attempts: Number(row.attempts),
    metrics: row.metrics ? safeJson(row.metrics) : null,
    model: row.model || null,
    sourceSessionId: row.source_session_id || null,
    notify: !!row.notify,
    acceptance: row.acceptance ? safeJson(row.acceptance) : [],
    evidence: row.evidence ? safeJson(row.evidence) : [],
    submittedAt: row.submitted_at === null || row.submitted_at === undefined ? null : Number(row.submitted_at),
    reviewMode: row.review_mode || null,
  }
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function toRow(w) {
  return {
    id: w.id,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
    owner_id: w.ownerId ?? OWNER_DEFAULT,
    source_channel: w.sourceChannel,
    source_peer: w.sourcePeer,
    source_msg_id: w.sourceMsgId ?? null,
    kind: w.kind,
    intent: w.intent ?? null,
    topic: w.topic ?? null,
    status: w.status,
    priority: w.priority ?? 50,
    needs_human: w.needsHuman ? 1 : 0,
    deadline: w.deadline ?? null,
    budget: w.budget ? JSON.stringify(w.budget) : null,
    parent_id: w.parentId ?? null,
    worker_type: w.workerType ?? null,
    session_id: w.sessionId ?? null,
    inputs: w.inputs ? JSON.stringify(w.inputs) : null,
    permission: w.permission ?? null,
    lane_id: w.laneId ?? null,
    workspace: w.workspace ?? null,
    origin: w.origin ?? null,
    project_root: w.projectRoot ?? null,
    scope: w.scope ?? null,
    scope_source: w.scopeSource ?? null,
    scope_confidence: w.scopeConfidence ?? null,
    result: w.result ?? null,
    error: w.error ?? null,
    attempts: w.attempts ?? 0,
    metrics: w.metrics ? JSON.stringify(w.metrics) : null,
    model: w.model ?? null,
    source_session_id: w.sourceSessionId ?? null,
    notify: w.notify ? 1 : 0,
    acceptance: w.acceptance ? JSON.stringify(w.acceptance) : null,
    evidence: w.evidence ? JSON.stringify(w.evidence) : null,
    submitted_at: w.submittedAt ?? null,
    review_mode: w.reviewMode ?? null,
  }
}

function insertWorkItemRow(db, w) {
  const row = toRow(w)
  const sql = `INSERT INTO workitems (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`
  db.prepare(sql).run(...COLUMNS.map((c) => row[c]))
}

function loadRow(db, id) {
  return db.prepare('SELECT * FROM workitems WHERE id = ?').get(id)
}

export function getWorkItem(db, id) {
  return snapshot(loadRow(db, id))
}

/**
 * 建任务。带 msgId 时幂等：同一 (owner, channel, msgId) 只建一个。
 */
export function createWorkItem(db, opts) {
  const {
    ownerId = OWNER_DEFAULT,
    channel,
    peer,
    msgId = null,
    kind = 'task',
    intent = null,
    topic = null,
    priority = 50,
    budget = null,
    ts = Date.now(),
  } = opts ?? {}

  if (!channel) throw new Error('createWorkItem 缺少 channel')
  if (!peer) throw new Error('createWorkItem 缺少 peer')

  if (msgId) {
    const existing = db.prepare(
      'SELECT * FROM workitems WHERE owner_id = ? AND source_channel = ? AND source_msg_id = ?',
    ).get(ownerId, channel, msgId)
    if (existing) return { item: snapshot(existing), created: false, event: null }
  }

  return withTransaction(db, () => {
    const item = insertItemNoTx(db, opts)
    return { item: getWorkItem(db, item.id), created: true, event: null }
  })
}

/** 内部：在已有事务里插入任务（不自己开事务）。 */
function insertItemNoTx(db, opts) {
  const {
    ownerId = OWNER_DEFAULT,
    channel,
    peer,
    msgId = null,
    kind = 'task',
    intent = null,
    topic = null,
    priority = 50,
    budget = null,
    ts = Date.now(),
  } = opts ?? {}
  {
    const id = `wi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const item = {
      id,
      createdAt: ts,
      updatedAt: ts,
      ownerId,
      sourceChannel: channel,
      sourcePeer: peer,
      sourceMsgId: msgId,
      kind,
      intent,
      topic,
      status: ITEM_STATUS.INTAKE,
      priority,
      needsHuman: false,
      deadline: null,
      budget,
      parentId: opts.parentId ?? null,
      reviewMode: opts.reviewMode ?? null,
      acceptance: opts.acceptance ?? null,
      evidence: null,
      submittedAt: null,
      workerType: null,
      sessionId: null,
      inputs: opts.inputs ?? null,
      permission: opts.permission ?? null,
      laneId: opts.laneId ?? null,
      model: opts.model ?? null,
      sourceSessionId: opts.sourceSessionId ?? null,
      notify: opts.notify ? true : false,
      workspace: opts.workspace ?? null,
      origin: opts.origin ?? null,
      projectRoot: opts.projectRoot ?? null,
      scope: opts.scope ?? null,
      scopeSource: opts.scopeSource ?? null,
      scopeConfidence: opts.scopeConfidence ?? null,
      result: null,
      error: null,
      attempts: 0,
      metrics: null,
    }
    insertWorkItemRow(db, item)
    appendEvent(db, {
      type: EVENT_TYPE.ITEM_CREATED,
      ownerId,
      workitemId: id,
      channel,
      actor: ACTOR.KERNEL,
      ts,
      payload: { workitem: item },
    })
    return item
  }
}

/** 内部：不做事务包装，便于 finish() 把 state + finished 两条事件放同一事务。 */
function applyTransition(db, id, to, opts = {}) {
  const row = loadRow(db, id)
  if (!row) throw new Error(`任务不存在：${id}`)
  const from = row.status
  const allowed = TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(`非法状态转移：${from} → ${to}（允许：${allowed.join(', ') || '无'}）`)
  }
  const reason = opts.reason && String(opts.reason).trim()
  if (!reason) throw new Error(`状态转移 ${from}→${to} 必须带 reason`)
  if (to === ITEM_STATUS.DONE && opts.viaFinish !== true) {
    throw new Error('done 只能由 finish() 写入（完成 = 一次成功写入的事件）')
  }

  const ts = opts.ts ?? Date.now()
  const needsHuman = to === ITEM_STATUS.WAITING_HUMAN
    ? 1
    : (opts.payload?.needsHuman !== undefined ? (opts.payload.needsHuman ? 1 : 0) : row.needs_human)
  const result = to === ITEM_STATUS.DONE ? (opts.payload?.result ?? row.result) : row.result
  const error = to === ITEM_STATUS.FAILED
    ? (opts.payload?.error ?? opts.payload?.reason ?? row.error)
    : row.error
  const attempts = opts.payload?.attempts ?? row.attempts
  const sessionId = opts.payload?.sessionId ?? row.session_id

  db.prepare(
    `UPDATE workitems
        SET status = ?, updated_at = ?, needs_human = ?, result = ?, error = ?, attempts = ?, session_id = ?
      WHERE id = ?`,
  ).run(to, ts, needsHuman, result, error, attempts, sessionId, id)

  const columns = {
    lane_id: row.lane_id,
    workspace: row.workspace,
    permission: row.permission,
    project_root: row.project_root,
    scope: row.scope,
    scope_source: row.scope_source,
    scope_confidence: row.scope_confidence,
    origin: row.origin,
    topic: row.topic,
    model: row.model,
  }
  appendEvent(db, {
    type: EVENT_TYPE.ITEM_STATE,
    ownerId: row.owner_id,
    workitemId: id,
    channel: row.source_channel,
    actor: opts.actor ?? ACTOR.KERNEL,
    ts,
    payload: { from, to, reason, ...opts.payload, columns },
  })

  return getWorkItem(db, id)
}

export function transition(db, id, to, opts = {}) {
  return withTransaction(db, () => applyTransition(db, id, to, opts))
}

/** 完成契约：唯一能把任务置 done 的入口。 */
function stampMetrics(db, id, success) {
  try {
    const row = loadRow(db, id)
    if (!row) return
    let prev = {}
    try { prev = row.metrics ? JSON.parse(row.metrics) : {} } catch { prev = {} }
    const metrics = {
      ...prev,
      durationMs: Number(row.updated_at) - Number(row.created_at),
      attempts: Number(row.attempts),
      firstTrySuccess: !!success && Number(row.attempts) === 0,
      finishedAt: Number(row.updated_at),
    }
    db.prepare('UPDATE workitems SET metrics = ? WHERE id = ?').run(JSON.stringify(metrics), id)
    return metrics
  } catch {
    return null
  }
}

/** 验收模式：self（提交即完成）| auto（另起只读工人核对）| owner（等主人点）| model（模型验收，接口预留） */
export const REVIEW_MODES = ['self', 'auto', 'owner', 'model']

export function normalizeReviewMode(value, fallback = 'self') {
  const v = String(value || '').trim().toLowerCase()
  return REVIEW_MODES.includes(v) ? v : fallback
}

/**
 * 提交校验：必须有证据；验收项不得留未勾选。
 * 目的：把「完成」从一句话变成可核对的结构，空证据 = 无效提交。
 */
export function validateSubmission({ acceptance = [], evidence = [] } = {}) {
  const evidenceList = Array.isArray(evidence) ? evidence.filter((e) => e && (e.ref || e.summary)) : []
  if (!evidenceList.length) {
    return { ok: false, reason: '提交必须带 evidence（产物路径 / 命令输出摘要 / 文本证据），空证据不算完成' }
  }
  const open = (Array.isArray(acceptance) ? acceptance : []).filter((a) => a && a.done !== true)
  if (open.length) {
    return { ok: false, reason: '还有未勾选的验收项：' + open.map((a) => a.text || a.id).join('；') }
  }
  return { ok: true }
}

/**
 * 提交。review_mode=self 直接完成；其余进 submitted 等验收。
 * 返回 { item, submitted: boolean, reason? }
 */
export function submitWorkItem(db, id, {
  result = '',
  artifacts = [],
  evidence = [],
  acceptance = null,
  reviewMode = 'self',
  actor = ACTOR.WORKER,
} = {}) {
  const mode = normalizeReviewMode(reviewMode, 'self')
  const item0 = getWorkItem(db, id)
  if (!item0) throw new Error(`任务不存在：${id}`)
  const accs = acceptance !== null ? acceptance : item0.acceptance
  const check = validateSubmission({ acceptance: accs, evidence })
  if (!check.ok) return { item: item0, submitted: false, reason: check.reason }

  if (mode === 'self') {
    const item = finishWorkItem(db, id, { result, artifacts, evidence, acceptance: accs, reviewMode: mode })
    return { item, submitted: true, reviewMode: mode }
  }

  return withTransaction(db, () => {
    db.prepare('UPDATE workitems SET acceptance = ?, evidence = ?, review_mode = ?, submitted_at = ?, result = ? WHERE id = ?')
      .run(JSON.stringify(accs || []), JSON.stringify(evidence || []), mode, Date.now(), String(result || ''), id)
    const item = applyTransition(db, id, ITEM_STATUS.SUBMITTED, {
      actor,
      reason: 'worker submit（待验收：' + mode + '）',
      payload: { result, artifacts, evidence, reviewMode: mode },
    })
    appendEvent(db, {
      type: EVENT_TYPE.ITEM_SUBMITTED,
      ownerId: item.ownerId,
      workitemId: id,
      channel: item.sourceChannel,
      actor,
      payload: { result, artifacts, evidence, reviewMode: mode },
    })
    return { item: getWorkItem(db, id), submitted: true, reviewMode: mode }
  })
}

/** 验收通过：submitted → done。这是 review ≠ self 时唯一能进 done 的路径。 */
export function acceptWorkItem(db, id, { note = '', by = ACTOR.OWNER } = {}) {
  return withTransaction(db, () => {
    const item = applyTransition(db, id, ITEM_STATUS.DONE, {
      viaFinish: true,
      actor: by,
      reason: '验收通过' + (note ? '：' + note : ''),
      payload: { acceptedBy: by, note },
    })
    appendEvent(db, {
      type: EVENT_TYPE.ITEM_ACCEPTED,
      ownerId: item.ownerId,
      workitemId: id,
      channel: item.sourceChannel,
      actor: by,
      payload: { note },
    })
    return getWorkItem(db, id)
  })
}

/** 验收驳回：submitted → running，附理由；调用方负责触发一次 continuation。 */
export function rejectWorkItem(db, id, { reason = '', by = ACTOR.OWNER } = {}) {
  if (!String(reason || '').trim()) throw new Error('驳回必须写理由')
  return withTransaction(db, () => {
    const item = applyTransition(db, id, ITEM_STATUS.RUNNING, {
      actor: by,
      reason: '验收驳回：' + reason,
      payload: { rejectedBy: by, rejectReason: reason },
    })
    appendEvent(db, {
      type: EVENT_TYPE.ITEM_REJECTED,
      ownerId: item.ownerId,
      workitemId: id,
      channel: item.sourceChannel,
      actor: by,
      payload: { reason },
    })
    return getWorkItem(db, id)
  })
}

export function finishWorkItem(db, id, { result, artifacts = [], evidence = null, acceptance = null, reviewMode = null } = {}) {
  return withTransaction(db, () => {
    if (evidence !== null || acceptance !== null || reviewMode !== null) {
      db.prepare('UPDATE workitems SET evidence = COALESCE(?, evidence), acceptance = COALESCE(?, acceptance), review_mode = COALESCE(?, review_mode), submitted_at = ? WHERE id = ?')
        .run(evidence === null ? null : JSON.stringify(evidence), acceptance === null ? null : JSON.stringify(acceptance), reviewMode, Date.now(), id)
    }
    const item = applyTransition(db, id, ITEM_STATUS.DONE, {
      viaFinish: true,
      actor: ACTOR.WORKER,
      reason: 'worker finish',
      payload: { result: result ?? '', artifacts },
    })
    const metrics = stampMetrics(db, id, true)
    for (const p of Array.isArray(artifacts) ? artifacts : []) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO artifacts (id, workitem_id, path, kind, size, sha256, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        ).run('art_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), id, String(p), 'file', Date.now())
      } catch { /* ignore */ }
    }
    appendEvent(db, {
      type: EVENT_TYPE.ITEM_FINISHED,
      ownerId: item.ownerId,
      workitemId: id,
      channel: item.sourceChannel,
      actor: ACTOR.WORKER,
      payload: { result: result ?? '', artifacts },
    })
    if (metrics) {
      appendEvent(db, { type: EVENT_TYPE.ITEM_METRICS, ownerId: item.ownerId, workitemId: id, channel: item.sourceChannel, actor: ACTOR.WORKER, payload: { metrics } })
    }
    return getWorkItem(db, id)
  })
}

export function failWorkItem(db, id, { reason, actor = ACTOR.WORKER } = {}) {
  return withTransaction(db, () => {
    const item = applyTransition(db, id, ITEM_STATUS.FAILED, { reason, actor, payload: { error: reason } })
    const metrics = stampMetrics(db, id, false)
    if (metrics) {
      appendEvent(db, { type: EVENT_TYPE.ITEM_METRICS, ownerId: item.ownerId, workitemId: id, channel: item.sourceChannel, actor, payload: { metrics } })
    }
    return getWorkItem(db, id)
  })
}

export function cancelWorkItem(db, id, { reason = 'owner cancel', actor = ACTOR.OWNER } = {}) {
  return transition(db, id, ITEM_STATUS.CANCELLED, { reason, actor })
}

export function markNeedsHuman(db, id, { reason, actor = ACTOR.KERNEL } = {}) {
  return transition(db, id, ITEM_STATUS.WAITING_HUMAN, {
    reason,
    actor,
    payload: { needsHuman: true },
  })
}

export function listWorkItems(db, { status = null, ownerId = null, limit = 100 } = {}) {
  const where = []
  const args = []
  if (status) { where.push('status = ?'); args.push(status) }
  if (ownerId) { where.push('owner_id = ?'); args.push(ownerId) }
  args.push(Math.max(1, Math.min(1000, limit)))
  const sql = `SELECT * FROM workitems ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`
  return db.prepare(sql).all(...args).map(snapshot)
}

export function summaryCounts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM workitems GROUP BY status').all()
  const out = {}
  for (const s of Object.values(ITEM_STATUS)) out[s] = 0
  for (const r of rows) out[r.status] = Number(r.n)
  return out
}

/** 从事件账本重建任务投影（重启/回放/巡检用）。 */
export function rebuildProjection(db) {
  const events = db.prepare(
    `SELECT * FROM events WHERE type IN (?, ?, ?) ORDER BY seq ASC`,
  ).all(EVENT_TYPE.ITEM_CREATED, EVENT_TYPE.ITEM_STATE, EVENT_TYPE.ITEM_METRICS)

  // 已被 prune 的任务：账本保留事件，但投影重建时不要再复活
  const prunedIds = new Set()
  for (const raw of db.prepare('SELECT payload FROM events WHERE type = ?').all(EVENT_TYPE.WORKITEM_PRUNED)) {
    try {
      const p = JSON.parse(raw.payload)
      for (const id of (p && Array.isArray(p.ids) ? p.ids : [])) prunedIds.add(String(id))
    } catch { /* ignore */ }
  }

  return withTransaction(db, () => {
    db.prepare('DELETE FROM workitems').run()
    let created = 0
    let updated = 0
    for (const raw of events) {
      if (raw.workitem_id && prunedIds.has(String(raw.workitem_id))) continue
      let payload
      try { payload = JSON.parse(raw.payload) } catch { continue }
      if (raw.type === EVENT_TYPE.ITEM_CREATED) {
        insertWorkItemRow(db, payload.workitem)
        created += 1
      } else if (raw.type === EVENT_TYPE.ITEM_STATE) {
        const row = loadRow(db, raw.workitem_id)
        if (!row) continue
        const p = payload
        const needsHuman = p.needsHuman !== undefined ? (p.needsHuman ? 1 : 0) : row.needs_human
        const result = p.to === ITEM_STATUS.DONE ? (p.result ?? row.result) : row.result
        const error = p.to === ITEM_STATUS.FAILED ? (p.error ?? p.reason ?? row.error) : row.error
        const attempts = p.attempts ?? row.attempts
        const sessionId = p.sessionId ?? row.session_id
        db.prepare(
          `UPDATE workitems SET status = ?, updated_at = ?, needs_human = ?, result = ?, error = ?, attempts = ?, session_id = ?
            WHERE id = ?`,
        ).run(p.to, Number(raw.ts), needsHuman, result, error, attempts, sessionId, raw.workitem_id)
        // 事件里带了可变列快照（v0.30+）：回放时一并恢复，避免重启后丢 lane/workspace/model 等
        if (p.columns && typeof p.columns === 'object') {
          const allowed = ['lane_id', 'workspace', 'permission', 'project_root', 'scope', 'scope_source', 'scope_confidence', 'origin', 'topic', 'model']
          const sets = []
          const args = []
          for (const k of allowed) {
            if (!(k in p.columns)) continue
            sets.push(k + ' = ?')
            args.push(p.columns[k] ?? null)
          }
          if (sets.length) {
            args.push(raw.workitem_id)
            db.prepare('UPDATE workitems SET ' + sets.join(', ') + ' WHERE id = ?').run(...args)
          }
        }
        updated += 1
      } else if (raw.type === EVENT_TYPE.ITEM_METRICS) {
        const row = loadRow(db, raw.workitem_id)
        if (!row) continue
        try {
          const p = payload
          if (p && p.metrics) {
            db.prepare('UPDATE workitems SET metrics = ? WHERE id = ?').run(JSON.stringify(p.metrics), raw.workitem_id)
          }
        } catch { /* ignore */ }
      }
    }
    return { created, updated, total: created }
  })
}

const MERGEABLE_STATUS = new Set([
  ITEM_STATUS.INTAKE,
  ITEM_STATUS.TRIAGED,
  ITEM_STATUS.QUEUED,
  ITEM_STATUS.WAITING_HUMAN,
])

export function isMergeable(status) {
  return MERGEABLE_STATUS.has(status)
}

/**
 * 归并：把 N 个「还没开始跑」的任务合成为一个新任务。
 * 规则闸（调用方也可以先挡一轮）：同 owner、同渠道、同人、状态可合、条数在范围内。
 * 成员标 merged（保留原文与 id，可拆回），新任务由调用方负责派单。
 */
export function mergeWorkItems(db, {
  ownerId = OWNER_DEFAULT,
  memberIds = [],
  title = '',
  reason = '',
  confidence = 1,
  actor = ACTOR.RELAY,
  maxMembers = 5,
} = {}) {
  const ids = [...new Set(memberIds.map((x) => String(x || '').trim()).filter(Boolean))]
  if (ids.length < 2) throw new Error('归并至少需要 2 个任务')
  if (ids.length > Math.max(2, maxMembers)) throw new Error('归并成员超过上限：' + maxMembers)
  const rows = ids.map((id) => loadRow(db, id))
  if (rows.some((r) => !r)) throw new Error('存在不存在的任务，不能归并')
  if (rows.some((r) => r.owner_id !== ownerId)) throw new Error('跨 owner 不许归并')
  const first = rows[0]
  if (rows.some((r) => r.source_channel !== first.source_channel)) throw new Error('跨渠道不许归并')
  if (rows.some((r) => r.source_peer !== first.source_peer)) throw new Error('跨人不许归并')
  const bad = rows.find((r) => !isMergeable(r.status))
  if (bad) throw new Error('任务 ' + bad.id + ' 状态是 ' + bad.status + '，不能归并（只能合未开始的任务）')

  return withTransaction(db, () => {
    const texts = rows.map((r) => String(r.intent || '(无描述)'))
    const mergedText = title && String(title).trim()
      ? String(title).trim()
      : texts.join('；同时：')
    const created = insertItemNoTx(db, {
      ownerId,
      channel: first.source_channel,
      peer: first.source_peer,
      kind: 'task',
      intent: mergedText,
      topic: first.topic,
      laneId: first.lane_id,
      projectRoot: first.project_root,
      scope: first.scope,
      scopeSource: first.scope_source,
      scopeConfidence: first.scope_confidence,
    })
    applyTransition(db, created.id, ITEM_STATUS.TRIAGED, {
      reason: 'merge: 由 ' + ids.length + ' 条合并（' + (reason || 'relay 提议') + '）',
      actor,
      payload: { mergedFrom: ids, confidence },
    })
    applyTransition(db, created.id, ITEM_STATUS.QUEUED, { reason: 'route: default', actor })

    for (const row of rows) {
      applyTransition(db, row.id, ITEM_STATUS.MERGED, {
        reason: '并入 ' + created.id + '（' + (reason || 'relay 提议') + '）',
        actor,
        payload: { into: created.id },
      })
      db.prepare(
        'INSERT OR REPLACE INTO merge_members (merged_workitem_id, member_workitem_id, member_text, created_at) VALUES (?, ?, ?, ?)',
      ).run(created.id, row.id, String(row.intent || ''), Date.now())
      appendEvent(db, {
        type: EVENT_TYPE.ITEM_MERGED,
        ownerId,
        workitemId: row.id,
        channel: row.source_channel,
        actor,
        payload: { into: created.id, reason, confidence },
      })
    }
    return { merged: getWorkItem(db, created.id), members: ids }
  })
}

/** 拆回：把合并任务取消，成员原文各建一个新任务（原成员记录保留可审计）。 */
export function splitMerged(db, mergedId, { actor = ACTOR.OWNER, maxMembers = 5 } = {}) {
  const merged = loadRow(db, mergedId)
  if (!merged) throw new Error('任务不存在：' + mergedId)
  const members = db.prepare(
    'SELECT * FROM merge_members WHERE merged_workitem_id = ? ORDER BY created_at ASC',
  ).all(mergedId)
  if (!members.length) throw new Error('这不是合并任务：' + mergedId)

  return withTransaction(db, () => {
    if (!TERMINAL_STATUS.includes(merged.status)) {
      applyTransition(db, mergedId, ITEM_STATUS.CANCELLED, { reason: '拆回（split）', actor })
    }
    const created = []
    for (const m of members.slice(0, maxMembers)) {
      const item = insertItemNoTx(db, {
        ownerId: merged.owner_id,
        channel: merged.source_channel,
        peer: merged.source_peer,
        kind: merged.kind,
        intent: String(m.member_text || ''),
        topic: merged.topic,
      })
      applyTransition(db, item.id, ITEM_STATUS.TRIAGED, { reason: 'split: 从 ' + mergedId + ' 拆回', actor })
      applyTransition(db, item.id, ITEM_STATUS.QUEUED, { reason: 'route: default', actor })
      created.push(getWorkItem(db, item.id))
    }
    appendEvent(db, {
      type: EVENT_TYPE.ITEM_SPLIT,
      ownerId: merged.owner_id,
      workitemId: mergedId,
      channel: merged.source_channel,
      actor,
      payload: { created: created.map((w) => w.id), members: members.length },
    })
    return { cancelled: mergedId, created }
  })
}

export function listMergeMembers(db, mergedId) {
  return db.prepare('SELECT * FROM merge_members WHERE merged_workitem_id = ? ORDER BY created_at ASC').all(mergedId)
}

export function isTerminal(status) {
  return TERMINAL_STATUS.includes(status)
}
