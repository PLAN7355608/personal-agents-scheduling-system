// 宿主机文件地图：只读扫描，给主人和工人一个「东西都在哪」的视角。
// 原则：不删、不改、不跟随符号链接；有扫描上限和时间预算，慢盘不会把内核拖死。
import { readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

// 明显不该扫的目录（依赖/版本库/回收站/系统卷）
const SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '__pycache__', '.venv', 'venv',
  '$RECYCLE.BIN', 'System Volume Information', '.Trash', '.Spotlight-V100',
  'AppData', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
])

const MAX_ENTRIES = 200000
const TIME_BUDGET_MS = 8000

export function defaultRoots({ workspaceRoot = null, searchDirs = [] } = {}) {
  const roots = []
  for (const d of searchDirs || []) if (d) roots.push(resolve(String(d)))
  if (!roots.length && workspaceRoot) roots.push(resolve(String(workspaceRoot)))
  return [...new Set(roots)]
}

function statSafe(p) {
  try { return statSync(p) } catch { return null }
}

/**
 * 遍历：对每个文件回调 { path, size, mtime }，对目录回调 { dir }。
 * 超上限/超时就停，返回 truncated 标记。
 */
function walk(dir, opts, visit) {
  const { maxDepth = 6, shouldStop } = opts
  const stack = [{ path: dir, depth: 0 }]
  let entries = 0
  let truncated = false
  while (stack.length) {
    const cur = stack.pop()
    let names = []
    try { names = readdirSync(cur.path) } catch { continue }
    for (const name of names) {
      if (SKIP.has(name)) continue
      const full = join(cur.path, name)
      const st = statSafe(full)
      if (!st) continue
      entries += 1
      if (entries > MAX_ENTRIES || shouldStop()) { truncated = true; return { truncated } }
      if (st.isDirectory()) {
        visit({ dir: full, depth: cur.depth + 1 })
        if (cur.depth + 1 < maxDepth) stack.push({ path: full, depth: cur.depth + 1 })
      } else if (st.isFile()) {
        visit({ path: full, size: st.size, mtime: st.mtimeMs, depth: cur.depth })
      }
    }
  }
  return { truncated }
}

export function dirMap(dirs, { maxDepth = 2, limit = 20, now = Date.now() } = {}) {
  const out = []
  for (const root of dirs) {
    const startedAt = now
    const stopAt = now + TIME_BUDGET_MS
    const buckets = new Map()
    let files = 0
    let bytes = 0
    let newestAt = 0
    const res = walk(root, { maxDepth, shouldStop: () => Date.now() > stopAt }, (item) => {
      if (!item.path) return
      files += 1
      bytes += item.size
      if (item.mtime > newestAt) newestAt = item.mtime
      // 按「根下第一层目录」归组，方便看哪块最占地
      const rel = item.path.slice(root.length).replace(/^[\\/]+/, '')
      const top = rel.includes('\\') || rel.includes('/') ? rel.split(/[\\/]/)[0] : '（散落在根目录）'
      const b = buckets.get(top) || { name: top, files: 0, bytes: 0, newestAt: 0 }
      b.files += 1
      b.bytes += item.size
      if (item.mtime > b.newestAt) b.newestAt = item.mtime
      buckets.set(top, b)
    })
    out.push({
      root,
      label: basename(root) || root,
      files,
      bytes,
      newestAt: newestAt || null,
      truncated: !!res.truncated,
      scannedMs: Date.now() - startedAt,
      children: [...buckets.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit),
    })
  }
  return out
}

export function bigFiles(dirs, { minBytes = 50 * 1024 * 1024, limit = 30, maxDepth = 8, now = Date.now() } = {}) {
  const stopAt = now + TIME_BUDGET_MS
  const found = []
  let truncated = false
  for (const root of dirs) {
    const res = walk(root, { maxDepth, shouldStop: () => Date.now() > stopAt }, (item) => {
      if (!item.path || item.size < minBytes) return
      found.push({ path: item.path, size: item.size, mtime: item.mtime })
    })
    if (res.truncated) truncated = true
  }
  found.sort((a, b) => b.size - a.size)
  return { files: found.slice(0, limit), total: found.length, truncated }
}

export function recentFiles(dirs, { sinceMs = 24 * 3600 * 1000, limit = 30, maxDepth = 8, now = Date.now() } = {}) {
  const stopAt = now + TIME_BUDGET_MS
  const cutoff = now - sinceMs
  const found = []
  let truncated = false
  for (const root of dirs) {
    const res = walk(root, { maxDepth, shouldStop: () => Date.now() > stopAt }, (item) => {
      if (!item.path || item.mtime < cutoff) return
      found.push({ path: item.path, size: item.size, mtime: item.mtime })
    })
    if (res.truncated) truncated = true
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return { files: found.slice(0, limit), total: found.length, truncated }
}

export function humanBytes(n) {
  const v = Number(n || 0)
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
