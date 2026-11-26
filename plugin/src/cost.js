// 花费账本：从工人会话日志里抽取模型 token 用量，按可配置单价折算成金额。
export function extractUsage(events) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const ev of events || []) {
    if (!ev || ev.type !== 'assistant/message') continue
    const u = (ev.data && ev.data.usage) || {}
    input += Number(u.inputTokens || 0)
    output += Number(u.outputTokens || 0)
    cacheRead += Number(u.cacheReadTokens || 0)
    cacheWrite += Number(u.cacheWriteTokens || 0)
  }
  return { input, output, cacheRead, cacheWrite, total: input + output }
}

/** rates: { 'provider/model': { inputPerM, outputPerM, cacheReadPerM } }，单位 CNY/百万 token。 */
export function estimateCost(usage, rate) {
  if (!rate) return 0
  const perM = (n, p) => (Number(n || 0) / 1e6) * Number(p || 0)
  return perM(usage.input, rate.inputPerM) + perM(usage.output, rate.outputPerM) + perM(usage.cacheRead, rate.cacheReadPerM)
}

export function recordUsage(db, { workitemId, sessionId = null, usage, costCny = 0, now = Date.now() } = {}) {
  if (!workitemId || !usage) return null
  const prev = db.prepare('SELECT * FROM cost_usage WHERE workitem_id = ?').get(workitemId)
  const row = {
    input: Number(usage.input || 0),
    output: Number(usage.output || 0),
    cacheRead: Number(usage.cacheRead || 0),
    cacheWrite: Number(usage.cacheWrite || 0),
    costCny: Number(costCny || 0),
  }
  const merged = prev
    ? {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        costCny: row.costCny,
      }
    : row
  db.prepare(
    'INSERT INTO cost_usage (workitem_id, session_id, input_tokens, output_tokens, cache_read, cache_write, cost_cny, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(workitem_id) DO UPDATE SET session_id=excluded.session_id, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, ' +
    'cache_read=excluded.cache_read, cache_write=excluded.cache_write, cost_cny=excluded.cost_cny, updated_at=excluded.updated_at',
  ).run(workitemId, sessionId, merged.input, merged.output, merged.cacheRead, merged.cacheWrite, merged.costCny, now)
  return merged
}

export function costTotals(db, { since = 0 } = {}) {
  try {
    const row = db.prepare(
      'SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cost_cny),0) AS c FROM cost_usage WHERE updated_at >= ?',
    ).get(since)
    return { input: Number(row.i || 0), output: Number(row.o || 0), costCny: Number(row.c || 0), tokens: Number(row.i || 0) + Number(row.o || 0) }
  } catch {
    return { input: 0, output: 0, costCny: 0, tokens: 0 }
  }
}

export function costFor(db, workitemId) {
  try {
    const row = db.prepare('SELECT input_tokens AS i, output_tokens AS o, cost_cny AS c FROM cost_usage WHERE workitem_id = ?').get(workitemId)
    if (!row) return null
    return { tokens: Number(row.i || 0) + Number(row.o || 0), costCny: Number(row.c || 0) }
  } catch {
    return null
  }
}
