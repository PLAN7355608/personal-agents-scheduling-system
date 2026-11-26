import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { extractUsage, estimateCost, recordUsage, costTotals, costFor } from '../../src/cost.js'

test('extractUsage 汇总 assistant 消息里的 token 用量', () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10 } } },
    { type: 'tool/result', data: {} },
  ]
  const u = extractUsage(events)
  assert.equal(u.input, 150)
  assert.equal(u.output, 30)
  assert.equal(u.cacheRead, 80)
  assert.equal(u.total, 180)
})

test('estimateCost 按百万 token 单价折算', () => {
  const cost = estimateCost({ input: 1_000_000, output: 500_000, cacheRead: 0 }, { inputPerM: 2, outputPerM: 8 })
  assert.equal(cost, 6)
  assert.equal(estimateCost({ input: 100 }, null), 0)
})

test('recordUsage 写入并按任务查花费', () => {
  const db = openDb(':memory:')
  recordUsage(db, { workitemId: 'wi_cost1', usage: { input: 1000, output: 200 }, costCny: 0.01 })
  recordUsage(db, { workitemId: 'wi_cost2', usage: { input: 500, output: 100 }, costCny: 0.005 })
  const t = costTotals(db, { since: 0 })
  assert.equal(t.input, 1500)
  assert.equal(t.output, 300)
  assert.ok(t.costCny > 0.014)
  const c = costFor(db, 'wi_cost1')
  assert.equal(c.tokens, 1200)
})
