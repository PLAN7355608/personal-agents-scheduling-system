// 派单去重：同一工作区里已经有同类在办任务时，不再新建一单。

export function normalizeIntent(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:"'`~()（）\[\]【】<>《》|/\\]/g, '')
}

/** 最长公共子序列长度（字符级，避免「要求：」这类插入词把包含判断打断）。 */
function lcsLength(a, b) {
  const m = a.length
  const n = b.length
  if (!m || !n) return 0
  if (m * n > 250000) return 0
  let prev = new Uint16Array(n + 1)
  let cur = new Uint16Array(n + 1)
  for (let i = 1; i <= m; i += 1) {
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= n; j += 1) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const t = prev
    prev = cur
    cur = t
    cur.fill(0)
  }
  return prev[n]
}

/** 两句话是否近似同一件事：完全一致，或字符级相似度足够高。 */
export function intentSimilar(a, b) {
  const na = normalizeIntent(a)
  const nb = normalizeIntent(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const shorter = na.length <= nb.length ? na : nb
  const longer = na.length <= nb.length ? nb : na
  if (shorter.length < 12) return false
  const lcs = lcsLength(shorter, longer)
  return lcs / longer.length >= 0.85
}

/** 从候选任务里挑出与 intent 相似的第一条。 */
export function pickDuplicate(items, intent) {
  for (const item of items || []) {
    if (item && intentSimilar(item.intent, intent)) return item
  }
  return null
}
