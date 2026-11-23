// 启动恢复：账本 → 投影，再把上一次进程留下的「半截任务」显式处理掉。
// 原则：不假装成功；没完成就是没完成，标 blocked 等人处理。
import { rebuildProjection, transition } from './workitems.js'
import { repairStuckLanes } from './lanes.js'
import { ITEM_STATUS } from './types.js'

export function recoverOnStart(db, { log = () => {} } = {}) {
  const rebuilt = rebuildProjection(db)

  const running = db.prepare("SELECT * FROM workitems WHERE status = 'running'").all()
  for (const row of running) {
    try {
      transition(db, row.id, ITEM_STATUS.BLOCKED, {
        reason: '内核重启，任务中断（需重新派单）',
        payload: { needsHuman: true },
      })
    } catch (err) {
      log('恢复 running 任务失败 ' + row.id + '：' + (err && err.message))
    }
  }

  // 只处理"没有线、或线是空转"的排队任务；排在忙碌线后面的合法任务交给 repairStuckLanes/正常调度
  const staleQueued = db.prepare(
    "SELECT w.* FROM workitems w LEFT JOIN lanes l ON w.lane_id = l.id " +
    "WHERE w.status = 'queued' AND w.updated_at < ? AND (w.lane_id IS NULL OR l.id IS NULL OR (l.status = 'idle' AND l.current_workitem_id IS NULL))",
  ).all(Date.now() - 120000)
  for (const row of staleQueued) {
    try {
      transition(db, row.id, ITEM_STATUS.BLOCKED, {
        reason: '派单中断（内核重启）',
        payload: { needsHuman: true },
      })
    } catch (err) {
      log('恢复 queued 任务失败 ' + row.id + '：' + (err && err.message))
    }
  }

  let repaired = 0
  try {
    repaired = repairStuckLanes(db)
  } catch (err) {
    log('修复卡住的线失败：' + (err && err.message))
  }

  if (running.length || staleQueued.length || repaired) {
    log('启动恢复：' + rebuilt.created + ' 条任务重建；' + running.length + ' running / ' + staleQueued.length + ' queued → blocked；修复卡线 ' + repaired)
  }
  return { rebuilt: rebuilt.created, blockedRunning: running.length, blockedQueued: staleQueued.length }
}
