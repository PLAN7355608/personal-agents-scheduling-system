// 启动恢复：账本 → 投影，再把上一次进程留下的「半截任务」显式处理掉。
// 原则：不假装成功；没完成就是没完成，标 blocked 等人处理。
import { statSync } from 'node:fs'
import { rebuildProjection, transition } from './workitems.js'
import { repairStuckLanes } from './lanes.js'
import { findSessionLog } from './session-store.js'
import { ITEM_STATUS } from './types.js'

// 能说明「工人在干活」的事件；worker.user_message 不算（主人插话也会写它）
export const WORKER_SIGNAL_TYPES = ['worker.tool', 'worker.tool.start', 'worker.continuation']

function placeholders(types) {
  return types.map(() => '?').join(',')
}

/**
 * 派单后完全没有回音的任务：`agents.resume` 到一个已经死掉的旧会话时最常见——
 * prompt 被静默丢弃，任务永远停在 running，也没有任何 worker.tool 事件。
 * 判定要两个信号都缺席：账本里没有工人事件，且工人会话日志在派单后也没再写过。
 */
export function findSilentDispatches(db, { now = Date.now(), silentMs = 8 * 60 * 1000 } = {}) {
  const rows = db.prepare(
    `SELECT w.*,
            (SELECT MAX(e.ts) FROM events e WHERE e.workitem_id = w.id AND e.type = 'item.state') AS dispatched_at,
            (SELECT MAX(e.ts) FROM events e WHERE e.workitem_id = w.id AND e.type IN (${placeholders(WORKER_SIGNAL_TYPES)})) AS worker_at
       FROM workitems w
      WHERE w.status = 'running'`,
  ).all(...WORKER_SIGNAL_TYPES)
  const out = []
  for (const row of rows) {
    const dispatchedAt = Number(row.dispatched_at || 0)
    if (!dispatchedAt) continue
    if (now - dispatchedAt <= silentMs) continue
    const workerAt = Number(row.worker_at || 0)
    if (workerAt && workerAt >= dispatchedAt) continue
    // 会话日志在派单后还在写 → 工人在跑（长任务也许只是暂时没调工具），不判死
    if (row.session_id && sessionWroteSince(row.session_id, dispatchedAt)) continue
    out.push(row)
  }
  return out
}

function sessionWroteSince(sessionId, since) {
  try {
    const file = findSessionLog(sessionId)
    if (!file) return false
    // 派单时 prompt 本身会写一次日志，所以要求晚于「派单后 60 秒」才算真活动
    return statSync(file).mtimeMs > since + 60000
  } catch {
    return false
  }
}

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
