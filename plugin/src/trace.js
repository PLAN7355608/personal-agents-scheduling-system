// 任务追踪聚合：给 trace 接口和面板详情用。
// 把事件流压成「步骤 / 产物 / 失败原因 / 统计」四块，前端不用自己拼。
import { readEvents } from './events.js'
import { getWorkItem } from './workitems.js'

export function buildWorkitemTrace(db, workitemId) {
  const workitem = getWorkItem(db, workitemId)
  if (!workitem) return null

  const events = readEvents(db, { workitemId, limit: 5000 })
  const steps = events
    .filter((e) => e.type === 'worker.tool')
    .map((e) => ({ ts: e.ts, ...e.payload }))

  let toolOk = 0
  let toolFail = 0
  for (const s of steps) {
    if (s.ok) toolOk += 1
    else toolFail += 1
  }

  let artifacts = []
  try {
    artifacts = db.prepare(
      'SELECT id, path, kind, size, sha256, created_at FROM artifacts WHERE workitem_id = ? ORDER BY created_at ASC',
    ).all(workitemId).map((a) => ({
      id: a.id, path: a.path, kind: a.kind, size: Number(a.size || 0), sha256: a.sha256, createdAt: Number(a.created_at),
    }))
  } catch {
    artifacts = []
  }

  // finish 事件里的产物路径也并进来（当前 finish 只是把路径写进 payload）
  for (const e of events) {
    if (e.type === 'item.finished' && Array.isArray(e.payload.artifacts)) {
      for (const p of e.payload.artifacts) {
        if (!artifacts.some((a) => a.path === p)) {
          artifacts.push({ id: null, path: p, kind: 'file', size: 0, sha256: null, createdAt: e.ts })
        }
      }
    }
  }

  let failure = workitem.error || null
  if (!failure) {
    const bad = [...events].reverse().find((e) => e.type === 'item.state' && (e.payload.to === 'failed' || e.payload.to === 'blocked'))
    failure = bad ? String(bad.payload.reason || '') : null
  }

  return {
    workitem,
    events,
    steps,
    artifacts,
    summary: {
      steps: steps.length,
      toolOk,
      toolFail,
      artifacts: artifacts.length,
      failure,
      durationMs: workitem.metrics ? workitem.metrics.durationMs ?? null : null,
      attempt: workitem.attempts,
    },
  }
}
