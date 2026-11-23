// 入站网关：外部通道来的消息统一走这里。
// 职责：政策校验（通道开关/白名单/限流）→ 记 msg.received 事件 → 建 WorkItem（幂等）。
// 不做业务判断（那是 Relay / judge 的事）。
import { appendEvent } from './events.js'
import { createWorkItem } from './workitems.js'
import { classifyTopic } from './topic.js'
import { ACTOR, EVENT_TYPE, OWNER_DEFAULT } from './types.js'

export function getPolicy(db, channel) {
  const row = db.prepare('SELECT * FROM channel_policies WHERE channel = ?').get(String(channel))
  if (!row) return null
  let allowedPeers = []
  try { allowedPeers = JSON.parse(row.allowed_peers || '[]') } catch { allowedPeers = [] }
  return {
    channel: row.channel,
    mode: row.mode,
    enabled: !!row.enabled,
    maxChars: Number(row.max_chars),
    allowFiles: !!row.allow_files,
    allowGroups: !!row.allow_groups,
    ratePerMin: Number(row.rate_per_min),
    quietHours: row.quiet_hours ? String(row.quiet_hours) : null,
    allowedPeers,
    updatedAt: Number(row.updated_at),
  }
}

export function listPolicies(db) {
  return db.prepare('SELECT channel FROM channel_policies ORDER BY channel').all().map((r) => getPolicy(db, r.channel))
}

export function upsertPolicy(db, policy) {
  // 局部更新：没给的字段沿用旧值（尤其 allowedPeers，不能用空数组把白名单抹掉）
  const prev = getPolicy(db, policy.channel)
  const p = {
    channel: String(policy.channel),
    mode: policy.mode ?? prev?.mode ?? 'direct',
    enabled: policy.enabled === undefined ? (prev ? (prev.enabled ? 1 : 0) : 1) : (policy.enabled ? 1 : 0),
    maxChars: Number(policy.maxChars ?? prev?.maxChars ?? 1500),
    allowFiles: policy.allowFiles === undefined ? (prev ? (prev.allowFiles ? 1 : 0) : 1) : (policy.allowFiles ? 1 : 0),
    allowGroups: policy.allowGroups === undefined ? (prev && prev.allowGroups ? 1 : 0) : (policy.allowGroups ? 1 : 0),
    ratePerMin: Number(policy.ratePerMin ?? prev?.ratePerMin ?? 30),
    quietHours: policy.quietHours === undefined ? (prev?.quietHours ?? null) : (policy.quietHours ? String(policy.quietHours) : null),
    allowedPeers: JSON.stringify(policy.allowedPeers ?? prev?.allowedPeers ?? []),
    updatedAt: Date.now(),
  }
  db.prepare(
    `INSERT INTO channel_policies (channel, mode, enabled, max_chars, allow_files, allow_groups, rate_per_min, quiet_hours, allowed_peers, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel) DO UPDATE SET
       mode=excluded.mode, enabled=excluded.enabled, max_chars=excluded.max_chars,
       allow_files=excluded.allow_files, allow_groups=excluded.allow_groups, rate_per_min=excluded.rate_per_min,
       quiet_hours=excluded.quiet_hours, allowed_peers=excluded.allowed_peers, updated_at=excluded.updated_at`,
  ).run(p.channel, p.mode, p.enabled, p.maxChars, p.allowFiles, p.allowGroups, p.ratePerMin, p.quietHours, p.allowedPeers, p.updatedAt)
  return getPolicy(db, p.channel)
}

function receivedInLastMinute(db, channel, peer, now) {
  // 限流按「通道 + 人」：一个人刷屏不该把整个渠道封死
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM events WHERE type = ? AND channel = ? AND peer = ? AND ts >= ?',
  ).get(EVENT_TYPE.MSG_RECEIVED, channel, peer, now - 60000)
  return Number(row.n || 0)
}

/**
 * 入站。envelope: {channel, peer, msgId, ts?, kind?, text?, sender?, attachments?}
 * 返回 {accepted, duplicate?, workitemId?, reason?}
 */
function normalizeAttachments(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((a) => {
    if (typeof a === 'string') return { path: a }
    const path = String((a && a.path) || '')
    if (!path) return null
    return {
      path,
      name: a.name ? String(a.name) : undefined,
      size: Number.isFinite(Number(a.size)) ? Number(a.size) : undefined,
      kind: a.kind ? String(a.kind) : undefined,
    }
  }).filter(Boolean)
}

export function inbound(db, envelope, { ownerId = OWNER_DEFAULT, now = Date.now() } = {}) {
  const channel = String(envelope?.channel || '').trim()
  const peer = String(envelope?.peer || '').trim()
  const msgId = String(envelope?.msgId || '').trim()
  const text = String(envelope?.text || '').trim()
  if (!channel) return { accepted: false, reason: 'channel required' }
  if (!peer) return { accepted: false, reason: 'peer required' }
  if (!msgId) return { accepted: false, reason: 'msgId required' }
  if (!text) return { accepted: false, reason: 'text required' }

  const policy = getPolicy(db, channel)
  if (!policy) return { accepted: false, reason: 'unknown channel（先在 channel_policies 里登记）' }
  if (!policy.enabled) return { accepted: false, reason: 'channel disabled' }
  if (policy.allowedPeers.length && !policy.allowedPeers.includes(peer)) {
    return { accepted: false, reason: 'peer not allowed' }
  }
  if (policy.maxChars > 0 && text.length > policy.maxChars) {
    return { accepted: false, reason: 'text too long（max ' + policy.maxChars + '）' }
  }
  if (receivedInLastMinute(db, channel, peer, now) >= policy.ratePerMin && policy.ratePerMin > 0) {
    return { accepted: false, reason: 'rate limited' }
  }

  appendEvent(db, {
    type: EVENT_TYPE.MSG_RECEIVED,
    ownerId,
    channel,
    peer,
    actor: ACTOR.SYSTEM,
    ts: now,
    payload: {
      msgId,
      peer,
      sender: envelope.sender || peer,
      kind: envelope.kind || 'text',
      text: text.slice(0, 2000),
      attachments: Array.isArray(envelope.attachments) ? envelope.attachments.slice(0, 20) : [],
    },
  })

  const { item, created } = createWorkItem(db, {
    ownerId,
    channel,
    peer,
    msgId,
    kind: 'task',
    intent: text,
    inputs: normalizeAttachments(envelope.attachments),
    origin: 'channel',
    topic: classifyTopic(text),
    ts: now,
  })
  if (!created) return { accepted: true, duplicate: true, workitemId: item.id }
  return { accepted: true, duplicate: false, workitemId: item.id, policy }
}
