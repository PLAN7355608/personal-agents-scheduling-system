// Reporter v0：决定一条消息「该用哪级打扰」。
// L0 只记日志 / L1 进面板 / L2 回当前对话 / L3 主动推送（跨渠道，有每日预算和静音时段）。
// 这里只做「决策 + 记账」，真正的 L3 推送要等入口 adapter（PWA/IM）到位。

export const LEVELS = ['L0', 'L1', 'L2', 'L3']

export function isQuietHour(hour, quietHours) {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false
  const [start, end] = quietHours.map((n) => Number(n))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  if (start === end) return false
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end)
}

/**
 * 决策：默认安静；只有「需要人」和「出错」才够格 L3，且受预算与静音时段限制。
 * @returns {{level:'L0'|'L1'|'L2'|'L3', reason:string}}
 */
export function decideDelivery({
  kind,               // done | failed | blocked | waiting_human | notice
  needsHuman = false,
  ownerHour,          // 主人的本地小时（0-23），不传则不算静音
  quietHours = [23, 8],
  l3Used = 0,
  l3Budget = 6,
} = {}) {
  if (kind === 'notice') return { level: 'L1', reason: '普通通知只进面板' }
  if (kind === 'done') return { level: 'L2', reason: '任务完成，回当前对话即可' }

  // failed / blocked / waiting_human
  if (!needsHuman) return { level: 'L2', reason: '出错但不需要主人立刻处理' }
  let level = 'L3'
  let reason = '需要主人处理'
  if (typeof ownerHour === 'number' && isQuietHour(ownerHour, quietHours)) {
    level = 'L2'
    reason = '需要主人处理，但处在静音时段（' + quietHours[0] + ':00–' + quietHours[1] + ':00），先回对话不进推送'
  } else if (l3Used >= l3Budget) {
    level = 'L2'
    reason = '需要主人处理，但今日主动推送预算已用完（' + l3Used + '/' + l3Budget + '）'
  }
  return { level, reason }
}

export function countL3Today(db, { ownerId = 'owner', now = Date.now() } = {}) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM events
      WHERE owner_id = ? AND type = 'delivery.decided' AND ts >= ?
        AND json_extract(payload, '$.level') = 'L3'`,
  ).get(ownerId, start.getTime())
  return Number(row.n || 0)
}

export function deliveryBudget(db, { ownerId = 'owner', now = Date.now(), budget = 6 } = {}) {
  const used = countL3Today(db, { ownerId, now })
  return { l3Used: used, l3Budget: budget, remaining: Math.max(0, budget - used) }
}
