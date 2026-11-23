// Worker 工具级追踪：把 Worker 会话里的工具调用，变成账本里的 worker.tool 事件。
// 目的：任务跑完/会话归档后，仍能回放「它在干什么」；也是面板「最近一步」的数据源。
// 注意：参数**必须脱敏**，只留摘要（路径这类必要信息保留，token/密码一律抹掉）。

import { createHash } from 'node:crypto'

const SENSITIVE_KEYS = /(token|password|passwd|secret|apikey|api_key|authorization|cookie|session_id|credential|密码|密钥|口令|令牌)/i
const CONTENT_KEYS = /^(content|text|body|code|script|command|new_string|old_string|newText|oldText)$/i

export function agentSessionId(exec) {
  const candidates = [
    exec?.agent?.sessionId,
    exec?.agent?.session?.id,
    exec?.agent?.session?.sessionId,
    exec?.sessionId,
    exec?.session?.id,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  return ''
}

export function toolNameOf(exec) {
  return String(exec?.name || exec?.tool?.name || exec?.definition?.name || 'unknown')
}

export function redactText(input, maxLen = 300) {
  let s = typeof input === 'string' ? input : safeStringify(input)
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
  // JSON 形态："token":"xxx"
  s = s.replace(/("(?:token|password|passwd|secret|apikey|api_key|authorization|cookie)"\s*:\s*")[^"]*(")/gi, '$1***$2')
  // 引号值形态：token: "xxx"
  s = s.replace(/((?:token|password|passwd|secret|apikey|api_key|authorization|cookie)\s*[:=]\s*")[^"]*(")/gi, '$1***$2')
  // 裸值形态：token=xxx / token: xxx
  s = s.replace(/((?:token|password|passwd|secret|apikey|api_key|authorization|cookie)\s*[:=]\s*)(?!Bearer|\*\*\*)[^\s,}"']+/gi, '$1***')
  // 中文键名：密码是 xxx / 密钥：xxx
  s = s.replace(/((?:密码|密钥|口令|令牌)\s*(?:是|为|[:=：])\s*)([^\s,，。;；]{1,80})/g, '$1***')
  s = s.replace(/"(?:密码|密钥|口令|令牌)"\s*:\s*"[^"]*"/g, '"***"')
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…'
  return s
}

function sha8(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8)
}

function summarizeValue(value, key = '') {
  if (value === undefined || value === null) return value
  if (typeof value === 'string') {
    // 正文/代码/命令：只记长度与哈希，不把原文写进账本
    if (CONTENT_KEYS.test(key)) return '[内容 len=' + value.length + ' sha=' + sha8(value) + ']'
    if (SENSITIVE_KEYS.test(key)) return '***'
    return redactText(value, 200)
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((v) => summarizeValue(v, key))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = summarizeValue(v, k)
    return out
  }
  return value
}

export function summarizeArgs(args) {
  if (args === undefined || args === null) return ''
  try {
    const text = JSON.stringify(summarizeValue(args))
    return text.length > 400 ? text.slice(0, 400) + '…' : text
  } catch {
    return ''
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function resultOk(result) {
  if (!result) return true
  if (result.isError === true) return false
  if (result.error) return false
  if (typeof result.ok === 'boolean') return result.ok
  return true
}

/**
 * 从一次工具执行构造 worker.tool 事件 payload。
 * @returns {null | {tool:string, ok:boolean, durationMs:number|null, summary:string, sessionId:string}}
 */
export function buildWorkerToolEvent({ exec, result, startedAt, durationMs }) {
  const sessionId = agentSessionId(exec)
  if (!sessionId) return null
  const tool = toolNameOf(exec)
  let ms = Number(durationMs)
  if (!Number.isFinite(ms) && Number.isFinite(Number(startedAt))) ms = Date.now() - Number(startedAt)
  return {
    tool,
    ok: resultOk(result),
    durationMs: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null,
    summary: summarizeArgs(exec?.arguments ?? exec?.args ?? exec?.input ?? null),
    sessionId,
  }
}

export { SENSITIVE_KEYS }
