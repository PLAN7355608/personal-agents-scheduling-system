// 内核文件嗅探：任务提到文件/材料时，在先配置的白名单目录里按「文件名与任务的重合度」找候选文件。
// 只读、限深度/限数量，不碰系统目录与依赖目录。
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', 'dist', 'build', 'proc', 'sys', 'dev', 'run'])
const SKIP_EXT = new Set(['.tmp', '.log', '.lock', '.db-wal', '.db-shm', '.pyc'])

function cjkBigrams(text) {
  const set = new Set()
  const s = String(text || '')
  for (let i = 0; i < s.length - 1; i += 1) {
    const a = s[i]
    const b = s[i + 1]
    if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) set.add(a + b)
  }
  return set
}

function scoreName(name, grams) {
  if (!grams.size) return 0
  const n = String(name || '')
  let hit = 0
  for (const g of grams) if (n.includes(g)) hit += 1
  return hit / grams.size
}

/** 返回 [{ path, name, mtime, size, score }] 按分数/时间排序。 */
export function sniffFiles({ dirs = [], intent = '', limit = 8, maxDepth = 3, maxFiles = 4000 } = {}) {
  const grams = cjkBigrams(intent)
  const results = []
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth || visited >= maxFiles) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (visited >= maxFiles) return
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(full, depth + 1)
        continue
      }
      visited += 1
      const ext = (ent.name.match(/\.[^.]+$/) || [''])[0].toLowerCase()
      if (SKIP_EXT.has(ext)) continue
      const score = scoreName(ent.name, grams)
      if (score <= 0) continue
      let st = null
      try { st = statSync(full) } catch { continue }
      results.push({ path: full, name: ent.name, mtime: st.mtimeMs, size: st.size, score })
    }
  }
  for (const d of dirs.slice(0, 8)) walk(d, 0)
  results.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime))
  return results.slice(0, Math.max(1, Math.min(20, limit)))
}

export function formatCandidates(list = []) {
  return list.map((f) => '- ' + f.path + (f.mtime ? '（' + new Date(f.mtime).toISOString().slice(0, 10) + '）' : ''))
}
/** 任务是否像「要读本地文件」的活（标题里只是创建一个文件不算）。 */
export function looksLikeFileTask(intentText) {
  const t = String(intentText || '')
  if (/记录表|报表|附件|压缩包|材料|excel|pdf|docx?|xlsx?/i.test(t)) return true
  if (/文件/.test(t) && /机器|本地|附件|材料|里面|现有|读取|找到|查找|找一下|整理|分析|根据|依据/.test(t)) return true
  return false
}