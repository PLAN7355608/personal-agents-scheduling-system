// 人设分层 v0：
//   preset（文件）= 骨架 + 红线 + 默认语气（改它要重载，可 diff 可回滚）
//   persona_overrides（DB）= 主人可调的语气项（称呼/自称/语气/口头禅/敬语/语言），运行时改
// 红线永远不在 DB 里——这里只允许白名单键，写不进红线。
import { OWNER_DEFAULT } from './types.js'

export const PERSONA_KEYS = {
  nickname_owner: { label: '称呼主人', max: 20, example: '主人' },
  nickname_self: { label: '自称', max: 20, example: '小助手' },
  tone: { label: '语气', max: 120, example: '短句、先结论、不客套' },
  catchphrases: { label: '口头禅', max: 120, example: '办好了；我查一下' },
  formality: { label: '敬语', max: 120, example: '不用「您」，用「你」' },
  language: { label: '语言', max: 30, example: '中文' },
}

const KEY_NAMES = Object.keys(PERSONA_KEYS)

export function getPersona(db, { ownerId = OWNER_DEFAULT } = {}) {
  const rows = db.prepare('SELECT key, value FROM persona_overrides WHERE owner_id = ?').all(ownerId)
  const out = {}
  for (const row of rows) {
    if (KEY_NAMES.includes(row.key)) out[row.key] = row.value
  }
  return out
}

export function setPersona(db, { ownerId = OWNER_DEFAULT, key, value } = {}) {
  const k = String(key || '').trim()
  if (!KEY_NAMES.includes(k)) {
    throw new Error('不允许改这个键：' + k + '（只能改：' + KEY_NAMES.join(' / ') + '；红线与安全规则在 preset 里，不能从数据库改）')
  }
  const v = String(value ?? '').trim()
  if (v.length > PERSONA_KEYS[k].max) throw new Error('值太长（上限 ' + PERSONA_KEYS[k].max + ' 字）')
  if (!v) {
    db.prepare('DELETE FROM persona_overrides WHERE owner_id = ? AND key = ?').run(ownerId, k)
    return { key: k, value: '', removed: true }
  }
  db.prepare(
    `INSERT INTO persona_overrides (owner_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ownerId, k, v, Date.now())
  return { key: k, value: v, removed: false }
}

/** 把 DB 里的人设项拼成一段可注入的文字；没有设定就返回空串（不污染 prompt）。 */
export function buildPersonaBlock(db, { ownerId = OWNER_DEFAULT, forResult = false } = {}) {
  const p = getPersona(db, { ownerId })
  const lines = []
  if (p.nickname_owner) lines.push('称呼主人：' + p.nickname_owner)
  if (p.nickname_self) lines.push('自称：' + p.nickname_self)
  if (p.formality) lines.push('敬语：' + p.formality)
  if (p.tone) lines.push('语气：' + p.tone)
  if (p.catchphrases) lines.push('可用口头禅：' + p.catchphrases)
  if (p.language) lines.push('语言：' + p.language)
  if (!lines.length) return ''
  if (forResult) {
    lines.push('result 要写成**对主人说的话**：先结论、再必要细节，用上面的称呼与语气；不要写汇报体。')
  }
  return lines.join('\n')
}

export function describePersona(db, { ownerId = OWNER_DEFAULT } = {}) {
  const current = getPersona(db, { ownerId })
  return KEY_NAMES.map((k) => ({
    key: k,
    label: PERSONA_KEYS[k].label,
    example: PERSONA_KEYS[k].example,
    value: current[k] || '',
  }))
}
