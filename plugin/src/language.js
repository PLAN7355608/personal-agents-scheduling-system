// 语言服务（骨架）：只负责「把结果说得像秘书」，不做事、不加事实。
// 用在：外部通道（没有 Relay 会话时）、Relay 输出被 guard 打回后的重写、以后手机 PWA。
// 约束：只许改写；失败/超时/输出可疑 → 回退原文。
export const LANGUAGE_KIND = 'compose_reply'

const SYSTEM = [
  '你是秘书的「说法」模块：只负责把已经办好的结果改写成给主人看的一两句话。',
  '硬规则：',
  '1. 只改写，不许新增、删改任何事实；不编造没给过的信息。',
  '2. 称呼按给的人格；先结论后细节；句子短，不写汇报体。',
  '3. 如果原文里有失败或需要主人拍板，要如实说。',
  '4. 只输出改写后的正文，不要解释、不要 markdown 标题。',
].join('\n')

function buildUser({ personaText, item, kind, raw }) {
  return [
    '人格/称呼：' + (personaText || '（默认：称呼主人「主人」，简短、先结论）'),
    '任务原文：' + String(item.intent || '').slice(0, 500),
    '结果类型：' + kind,
    '原始结果：' + String(raw || '').slice(0, 800),
    '请改写。',
  ].join('\n')
}

/** 返回 { text, ok, model, durationMs }；失败时 text=原文。 */
export async function composeReply({ llm, cfg, personaText = '', item = {}, kind = 'done', raw = '', now = Date.now() } = {}) {
  const lcfg = (cfg && cfg.language) || {}
  const rawText = String(raw || '')
  if (!lcfg.enabled) return { text: rawText, ok: false, reason: 'disabled', durationMs: 0 }
  if (!llm || typeof llm.stream !== 'function') return { text: rawText, ok: false, reason: 'no-llm', durationMs: 0 }

  const provider = lcfg.provider || (cfg.judge && cfg.judge.provider) || 'deepseek-account'
  const model = lcfg.model || (cfg.judge && cfg.judge.model) || 'deepseek-flash'
  const timeoutMs = Math.max(2000, Number(lcfg.timeoutMs) || 8000)
  const maxLen = Math.max(80, rawText.length * 2 + 80)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  let text = ''
  try {
    const stream = llm.stream({
      provider,
      model,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUser({ personaText, item, kind, raw: rawText }) }] }],
      temperature: 0.4,
      maxTokens: Math.max(80, Number(lcfg.maxTokens) || 220),
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
  } catch (err) {
    clearTimeout(timer)
    return { text: rawText, ok: false, reason: 'error:' + String((err && err.message) || err).slice(0, 80), durationMs: Date.now() - startedAt }
  }
  clearTimeout(timer)
  const out = text.trim()
  if (!out || out.length > maxLen) {
    return { text: rawText, ok: false, reason: out ? 'too-long' : 'empty', durationMs: Date.now() - startedAt }
  }
  return { text: out, ok: true, model: provider + '/' + model, durationMs: Date.now() - startedAt, at: now }
}
