// 分工统计 v0：按 topic / workerType 汇总，按阈值给出「要不要切专精」的建议。
// 只读；建议进面板/对话，切不切由主人决定（见 02 §13 / D13）。
import { TOPICS } from './topic.js'

export function distribution(db, { ownerId = 'owner', days = 14 } = {}) {
  const since = Date.now() - Math.max(1, Number(days) || 14) * 86400000
  const rows = db.prepare(
    `SELECT topic, status, COUNT(*) AS n,
            AVG(CASE WHEN metrics IS NOT NULL THEN json_extract(metrics, '$.durationMs') END) AS avgMs
       FROM workitems
      WHERE owner_id = ? AND created_at >= ? AND status != 'merged'
      GROUP BY topic, status`,
  ).all(ownerId, since)

  const byTopic = new Map()
  let total = 0
  for (const row of rows) {
    const topic = TOPICS.includes(row.topic) ? row.topic : 'other'
    if (!byTopic.has(topic)) {
      byTopic.set(topic, { topic, total: 0, done: 0, failed: 0, blocked: 0, cancelled: 0, merged: 0, running: 0, queued: 0, avgMsSum: 0, avgMsN: 0 })
    }
    const t = byTopic.get(topic)
    const n = Number(row.n)
    t.total += n
    total += n
    if (row.status === 'done') t.done += n
    else if (row.status === 'failed') t.failed += n
    else if (row.status === 'blocked') t.blocked += n
    else if (row.status === 'cancelled') t.cancelled += n
    else if (row.status === 'merged') t.merged += n
    else if (row.status === 'running') t.running += n
    else if (row.status === 'queued') t.queued += n
    if (row.avgMs !== null && row.avgMs !== undefined) {
      t.avgMsSum += Number(row.avgMs) * n
      t.avgMsN += n
    }
  }

  const topics = [...byTopic.values()]
    .map((t) => ({
      ...t,
      share: total > 0 ? Number((t.total / total).toFixed(3)) : 0,
      avgMs: t.avgMsN > 0 ? Math.round(t.avgMsSum / t.avgMsN) : null,
    }))
    .sort((a, b) => b.total - a.total)
  return { days: Number(days) || 14, total, topics }
}

/**
 * 分工建议：两条阈值（先只看占比和样本量，工具面差异等接了专精再评估）。
 * 返回的是「建议」，不是动作；主人同意后才新增 WorkerType。
 */
export function suggestions(db, { ownerId = 'owner', days = 14, minShare = 0.2, minTasks = 10 } = {}) {
  const dist = distribution(db, { ownerId, days })
  const out = []
  for (const t of dist.topics) {
    if (t.topic === 'chat' || t.topic === 'other') continue
    if (t.share < minShare) continue
    if (t.total < minTasks) continue
    out.push({
      topic: t.topic,
      share: t.share,
      tasks: t.total,
      avgMs: t.avgMs,
      reason: '占比 ' + Math.round(t.share * 100) + '%（' + t.total + ' 单）且样本量足够，可以考虑单独一个 Worker 类型',
    })
  }
  return { days: dist.days, total: dist.total, minShare, minTasks, suggestions: out }
}

export function summarize(db, { ownerId = 'owner', days = 14 } = {}) {
  const dist = distribution(db, { ownerId, days })
  const top = dist.topics[0]
  return {
    ...dist,
    message: dist.total === 0
      ? '这 ' + dist.days + ' 天还没有任务数据'
      : '近 ' + dist.days + ' 天共 ' + dist.total + ' 单，最多的是 ' + top.topic + '（' + top.total + ' 单，' + Math.round(top.share * 100) + '%）',
  }
}
