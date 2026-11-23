// 简报与复盘：把账本/记忆/工具申请汇总成给人看的中文 markdown。
// 只读数据、不调模型；生成后由调用方决定写文件/面板/出站。
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function fmtDate(d) {
  const x = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
}

function rangeStart(kind, days, now) {
  const ms = new Date(now)
  if (kind === 'daily') {
    ms.setHours(0, 0, 0, 0)
    ms.setDate(ms.getDate() - 1)
    return ms.getTime()
  }
  if (kind === 'weekly') {
    ms.setHours(0, 0, 0, 0)
    ms.setDate(ms.getDate() - 7)
    return ms.getTime()
  }
  return now - Math.max(1, Number(days) || 7) * 86400000
}

function taskLines(db, { ownerId, since, until }) {
  const rows = db.prepare(
    'SELECT id, status, topic, workspace, substr(intent,1,60) AS intent, substr(result,1,120) AS result, ' +
    'substr(error,1,120) AS error, updated_at FROM workitems ' +
    'WHERE owner_id = ? AND updated_at >= ? AND updated_at <= ? ORDER BY updated_at ASC',
  ).all(ownerId, since, until)
  return rows
}

function artifactsOf(db, ids) {
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  return db.prepare('SELECT workitem_id, path FROM artifacts WHERE workitem_id IN (' + marks + ')').all(...ids)
}

export function buildBrief(db, { ownerId = 'owner', kind = 'daily', now = Date.now() } = {}) {
  const since = rangeStart(kind, 1, now)
  const until = now
  const tasks = taskLines(db, { ownerId, since, until })
  const done = tasks.filter((t) => t.status === 'done')
  const bad = tasks.filter((t) => t.status === 'failed' || t.status === 'blocked')
  const arts = artifactsOf(db, done.map((t) => t.id))
  const pendingTools = db.prepare(
    "SELECT id, tool, substr(reason,1,60) AS reason FROM tool_requests WHERE owner_id = ? AND status IN ('pending','escalated')",
  ).all(ownerId)
  const active = db.prepare(
    "SELECT id, status, substr(intent,1,50) AS intent FROM workitems WHERE status IN ('queued','running','waiting_human','blocked')",
  ).all()
  const memCount = db.prepare(
    'SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND superseded_by IS NULL',
  ).get().n

  const title = kind === 'weekly' ? '本周简报' : '昨日简报'
  const lines = [
    '# ' + title + '（' + fmtDate(now) + '）',
    '',
    '## 一、办成的（' + done.length + ' 件）',
    ...(done.length ? done.map((t) => '- ' + t.intent + (t.result ? ' → ' + t.result : '')) : ['- 没有完成的任务']),
    '',
    '## 二、卡住的 / 失败的（' + bad.length + ' 件）',
    ...(bad.length ? bad.map((t) => '- ' + t.intent + '：' + (t.error || t.status)) : ['- 无']),
    '',
    '## 三、产出文件（' + arts.length + ' 个）',
    ...(arts.length ? arts.map((a) => '- ' + a.path) : ['- 无']),
    '',
    '## 四、待你决定',
    ...(pendingTools.length ? pendingTools.map((p) => '- 工具申请：' + p.tool + '（' + p.reason + '）') : ['- 无待批工具申请']),
    ...(active.length ? active.map((a) => '- 在办：' + a.intent + '（' + a.status + '）') : []),
    '',
    '## 五、记录表',
    '- 活跃记忆 ' + memCount + ' 条；在办 ' + active.length + ' 件；本期任务 ' + tasks.length + ' 件',
  ]
  return lines.join('\n')
}

export function buildReview(db, { ownerId = 'owner', days = 7, now = Date.now() } = {}) {
  const since = now - Math.max(1, Number(days) || 7) * 86400000
  const tasks = taskLines(db, { ownerId, since, until: now })
  const byStatus = {}
  const byTopic = {}
  const durations = []
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1
    byTopic[t.topic || 'other'] = (byTopic[t.topic || 'other'] || 0) + 1
  }
  const metricsRows = db.prepare(
    'SELECT metrics FROM workitems WHERE updated_at >= ? AND metrics IS NOT NULL',
  ).all(since)
  for (const r of metricsRows) {
    try {
      const m = JSON.parse(r.metrics)
      if (m && Number.isFinite(m.durationMs)) durations.push(m.durationMs)
    } catch { /* ignore */ }
  }
  const tools = db.prepare(
    "SELECT tool, status, COUNT(*) n FROM tool_requests WHERE created_at >= ? GROUP BY tool, status",
  ).all(since)
  const judges = db.prepare('SELECT COUNT(*) n FROM judge_calls WHERE created_at >= ?').get(since).n
  const deleted = db.prepare("SELECT COUNT(*) n FROM events WHERE type='file.deleted' AND ts >= ?").get(since).n
  const arts = db.prepare('SELECT COUNT(*) n FROM artifacts WHERE created_at >= ?').get(since).n
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null
  return [
    '# 任务复盘（最近 ' + days + ' 天，截至 ' + fmtDate(now) + '）',
    '',
    '- 任务总数：' + tasks.length,
    '- 状态分布：' + (Object.entries(byStatus).map(([k, v]) => k + '=' + v).join('，') || '无'),
    '- 类型分布：' + (Object.entries(byTopic).map(([k, v]) => k + '=' + v).join('，') || '无'),
    '- 平均耗时：' + (avg === null ? '无数据' : avg + ' 秒'),
    '- 产物数：' + arts,
    '- 删除审计：' + deleted + ' 次',
    '- judge 调用：' + judges + ' 次',
    '',
    '## 工具申请',
    ...(tools.length ? tools.map((t) => '- ' + t.tool + '：' + t.status + ' ×' + t.n) : ['- 无']),
    '',
    '## 失败/卡住明细',
    ...(tasks.filter((t) => t.status === 'failed' || t.status === 'blocked').map((t) => '- ' + t.id + ' ' + t.intent + '：' + (t.error || t.status)) || []),
  ].join('\n')
}

export function writeReport(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, 'utf8')
  return filePath
}
