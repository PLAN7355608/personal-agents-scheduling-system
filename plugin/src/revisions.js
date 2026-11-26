// 续作修订账本：任务 done 之后主人继续让同一工人改稿，产物按版本登记，不篡改原任务。
import { randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function nextRevisionNo(db, workitemId) {
  const row = db.prepare('SELECT MAX(revision) AS n FROM revisions WHERE workitem_id = ?').get(workitemId)
  return Number(row && row.n ? row.n : 0) + 1
}

/** 记一条修订；同一路径且不比上次更新则跳过（避免每轮扫描重复登记）。 */
export function addRevision(db, { workitemId, path, source = 'observed', note = '', mtime = 0, now = Date.now() }) {
  if (!workitemId || !path) return null
  try {
    if (mtime) {
      const prev = db.prepare('SELECT created_at FROM revisions WHERE workitem_id = ? AND path = ? ORDER BY created_at DESC LIMIT 1').get(workitemId, path)
      if (prev && Number(prev.created_at) >= Number(mtime)) return null
    }
    const revision = nextRevisionNo(db, workitemId)
    const id = 'rev_' + randomUUID().slice(0, 12)
    db.prepare(
      'INSERT INTO revisions (id, workitem_id, path, revision, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, workitemId, path, revision, source, note, now)
    return { id, workitemId, path, revision, source, note, createdAt: now }
  } catch {
    return null
  }
}

export function listRevisions(db, workitemId, limit = 20) {
  try {
    return db.prepare('SELECT id, path, revision, source, note, created_at AS createdAt FROM revisions WHERE workitem_id = ? ORDER BY revision DESC LIMIT ?').all(workitemId, limit)
  } catch {
    return []
  }
}

export function revisionPriority(path) {
  const ext = String(path || '').toLowerCase().split('.').pop()
  if (['docx', 'doc', 'pdf', 'md', 'xlsx', 'xls', 'pptx', 'csv'].includes(ext)) return 3
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 1
  return 2
}

/** 「最新产物」：优先文档，其次普通文件，最后图片；同优先级取 revision 大的。 */
export function latestRevision(db, workitemId) {
  try {
    const rows = db.prepare('SELECT id, path, revision, source, note, created_at AS createdAt FROM revisions WHERE workitem_id = ? ORDER BY revision DESC LIMIT 50').all(workitemId)
    if (!rows.length) return null
    rows.sort((a, b) => (revisionPriority(b.path) - revisionPriority(a.path)) || (b.revision - a.revision))
    return rows[0]
  } catch {
    return null
  }
}

export function countRevisions(db, workitemId) {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE workitem_id = ?').get(workitemId).n || 0)
  } catch {
    return 0
  }
}

/** 扫工作区里 since 之后修改过的文件；文档/表格优先，图片其次（避免临时渲染图抢占「最新产物」）。 */
export function scanRecentFiles(root, since = 0, { limit = 10, maxDepth = 3 } = {}) {
  const out = []
  const score = (name) => {
    const ext = String(name).toLowerCase().split('.').pop()
    if (['docx', 'doc', 'pdf', 'md', 'xlsx', 'xls', 'pptx', 'csv'].includes(ext)) return 3
    if (['txt', 'json', 'py', 'js', 'mjs', 'sh'].includes(ext)) return 2
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 1
    return 2
  }
  const walk = (dir, depth) => {
    if (out.length >= limit * 4 || depth > maxDepth) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist'].includes(e.name)) continue
        walk(full, depth + 1)
        continue
      }
      try {
        const st = statSync(full)
        if (st.isFile() && st.mtimeMs > since) out.push({ path: full, size: st.size, mtime: st.mtimeMs, score: score(e.name) })
      } catch {
        /* ignore */
      }
    }
  }
  if (!root) return out
  walk(root, 0)
  return out
    .sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime))
    .slice(0, limit)
}
