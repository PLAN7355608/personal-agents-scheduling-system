// 旁路审计：读工人会话日志，把「主人直接在会话里说的/批注的」内容记进账本。
// 为什么需要：批注插件、直接打字等方式不经过内核工具，账本原本看不到；这里从会话日志侧补齐。
import { createHash } from 'node:crypto'
import { readSessionEvents } from './session-store.js'

const TASK_MARKERS = ['【任务】', '【主人补充指令】', '【工作区】', '【事实纪律】', '【完成要求】']
// DSH 每轮注入的环境上下文（不是人说的话），审计时排除
const SYSTEM_PREFIXES = [
  '<system-reminder>',
  '<available_skills>',
  'Clock:',
  'Time sampled while preparing',
  'Current working directory:',
  'Calendar:',
  'Image tools current default provider:',
  'Image-gen workbench canvas:',
  'Configured image providers',
  'Subscription parameters:',
  'Minimal calls:',
  'Current DeepSeek Harness implementation checkout:',
  'Current DeepSeek Harness Web GUI URL:',
  'You are an AI agent powered by',
]
// 运行时的系统通知（形如人话、但不是主人说的），按正则排除
const SYSTEM_PATTERNS = [
  /^The user changed the approval policy/i,
  /^The user (?:set|switched) (?:the )?(?:model|permission|sandbox)/i,
  /^Approval (?:policy|mode) (?:changed|set)/i,
]
const PREVIEW_CHARS = 300

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' ? String(c.text || '') : ''))
    .join('\n')
    .trim()
}

/** 把带附件的消息也变成可读摘要（用户常直接把改过的 docx/图片丢给工人）。 */
function attachmentSummary(content) {
  if (!Array.isArray(content)) return ''
  const names = []
  for (const c of content) {
    if (!c || typeof c !== 'object') continue
    const type = String(c.type || '')
    if (type === 'text') continue
    const name = c.name || c.filename || c.path || c.file_path || c.url || ''
    if (type || name) names.push('[' + (type || '附件') + '] ' + String(name).split(/[\\/]/).pop())
  }
  return names.join(' ')
}

/** 从会话事件里挑出「人给的指导」：排除系统提醒与内核注入的任务提示词。 */
export function extractHumanGuidance(events, { since = 0 } = {}) {
  const out = []
  for (const ev of events || []) {
    if (!ev || ev.type !== 'user/message') continue
    const data = ev.data || {}
    const content = data.content !== undefined ? data.content : data.message && data.message.content
    const text = textOf(content)
    const attach = attachmentSummary(content)
    const combined = [text, attach].filter(Boolean).join(' ').trim()
    if (!combined) continue
    if (text.startsWith('<system-reminder>')) continue
    if (SYSTEM_PREFIXES.some((p) => text.startsWith(p))) continue
    if (SYSTEM_PATTERNS.some((re) => re.test(text))) continue
    if (TASK_MARKERS.some((m) => text.includes(m))) continue
    const ts = Number(ev.time || data.time || 0)
    if (ts && ts < since) continue
    const hash = createHash('sha256').update(combined).digest('hex').slice(0, 16)
    out.push({
      hash,
      ts,
      chars: combined.length,
      preview: combined.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS),
      hasAttachment: !!attach,
    })
  }
  return out
}

/** 会话里在 since 之后是否有主人手动输入（含附件）；用于判断终态任务是否被主人“接手继续改”。 */
export function sessionHasManualInput(sessionId, since = 0) {
  if (!sessionId) return false
  try {
    const r = readSessionEvents(sessionId)
    const guidance = extractHumanGuidance((r && r.events) || [], { since })
    return guidance.length > 0
  } catch {
    return false
  }
}

/**
 * 把某个工人会话里的人工指导写进账本；已记过的按 hash 去重。
 * 返回新写入条数。
 */
export function auditWorkerGuidance(db, { sessionId, workitemId, ownerId, channel, appendEvent, since = 0, log = () => {} } = {}) {
  if (!sessionId || !workitemId) return 0
  let events = []
  try {
    const r = readSessionEvents(sessionId)
    events = (r && r.events) || []
  } catch (err) {
    log('读工人会话日志失败（跳过审计）：' + (err && err.message ? err.message : String(err)))
    return 0
  }
  if (!events.length) return 0
  const guidance = extractHumanGuidance(events, { since })
  if (!guidance.length) return 0
  const seen = new Set()
  try {
    for (const row of db.prepare(
      "SELECT payload FROM events WHERE workitem_id = ? AND type = 'worker.user_message'",
    ).all(workitemId)) {
      try {
        const p = JSON.parse(row.payload)
        if (p && p.hash) seen.add(String(p.hash))
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  let written = 0
  for (const g of guidance) {
    if (seen.has(g.hash)) continue
    seen.add(g.hash)
    try {
      appendEvent(db, {
        type: 'worker.user_message',
        ownerId,
        workitemId,
        sessionId,
        channel,
        actor: 'owner',
        payload: { source: 'session-log', hash: g.hash, chars: g.chars, preview: g.preview, at: g.ts || Date.now() },
      })
      written += 1
    } catch (err) {
      log('写人工指导事件失败：' + (err && err.message ? err.message : String(err)))
    }
  }
  return written
}
