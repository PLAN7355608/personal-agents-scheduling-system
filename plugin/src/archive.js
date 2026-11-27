// 归档：扫描桌面/下载等目录，按扩展名规则给出候选（默认只提议不移动）。
import { readdirSync, statSync, mkdirSync, renameSync, existsSync, copyFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { bigFiles, humanBytes } from './filemap.js'

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return { y: d.getFullYear(), m: p(d.getMonth() + 1), d: p(d.getDate()) }
}

function targetFor(rule, ext, when) {
  const t = today()
  const stamp = when ? new Date(when) : new Date()
  const y = stamp.getFullYear()
  const m = String(stamp.getMonth() + 1).padStart(2, '0')
  return String(rule.target || '')
    .replace(/\{ext\}/g, ext.replace(/^\./, ''))
    .replace(/\{yyyy\}/g, String(y))
    .replace(/\{mm\}/g, m)
    .replace(/\{dd\}/g, String(stamp.getDate()).padStart(2, '0'))
}

export function scanArchive({ watchDirs = [], rules = [], minAgeHours = 24, now = Date.now() } = {}) {
  const out = []
  const maxAge = Math.max(0, Number(minAgeHours) || 0) * 3600000
  for (const dir of watchDirs.slice(0, 6)) {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isFile()) continue
      const ext = extname(ent.name).toLowerCase()
      const rule = rules.find((r) => (r.ext || []).map((e) => e.toLowerCase()).includes(ext))
      if (!rule) continue
      const full = join(dir, ent.name)
      let st = null
      try { st = statSync(full) } catch { continue }
      if (now - st.mtimeMs < maxAge) continue
      out.push({ path: full, name: ent.name, ext, size: st.size, mtime: st.mtimeMs, target: targetFor(rule, ext, st.mtimeMs) })
    }
  }
  out.sort((a, b) => a.mtime - b.mtime)
  return out
}

/**
 * 大文件归档提议：按大小（可选按年龄）挑出来，能匹配扩展名规则的给出建议目标，
 * 匹配不上的 target=null（需要主人自己指定目标目录）。只提议，不动文件。
 */
export function proposeBig({
  dirs = [], rules = [], minBytes = 100 * 1024 * 1024, minAgeDays = 0, maxDepth = 8, limit = 30, now = Date.now(),
} = {}) {
  const cutoff = Number(minAgeDays) > 0 ? now - Number(minAgeDays) * 86400000 : 0
  const r = bigFiles(dirs, { minBytes, limit: Math.max(50, limit * 4), maxDepth, now })
  const items = []
  for (const f of r.files) {
    if (cutoff && f.mtime > cutoff) continue
    const ext = extname(f.path).toLowerCase()
    const rule = rules.find((rr) => (rr.ext || []).map((e) => String(e).toLowerCase()).includes(ext))
    items.push({
      path: f.path,
      name: basename(f.path),
      ext,
      size: f.size,
      sizeHuman: humanBytes(f.size),
      mtime: f.mtime,
      target: rule ? targetFor(rule, ext, f.mtime) : null,
    })
    if (items.length >= limit) break
  }
  return { items, total: items.length, scanned: r.total, truncated: r.truncated }
}

export function applyArchive(candidates = []) {
  const moved = []
  const failed = []
  for (const c of candidates.slice(0, 200)) {
    try {
      const ext = extname(c.path)
      const rawTarget = c.target && c.target.trim() ? c.target.trim() : ''
      if (!rawTarget) throw new Error('没有目标目录')
      if (!isAbsolute(rawTarget)) throw new Error('归档目标必须是绝对路径：' + rawTarget)
      if (dirname(join(rawTarget, basename(c.path))) === dirname(rawTarget) && /^[A-Za-z]:[\\/]?$/.test(dirname(rawTarget) + '\\')) throw new Error('归档目标不能是盘根：' + rawTarget)
      let dest = join(rawTarget, basename(c.path))
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) {
        const stem = basename(c.path, ext)
        dest = join(dirname(dest), stem + '-' + Date.now().toString(36) + ext)
      }
      try {
        renameSync(c.path, dest)
      } catch (err) {
        // 跨盘（Windows C:→E: 常见）：rename 会 EXDEV，降级 copy + unlink
        if (err && err.code === 'EXDEV') {
          copyFileSync(c.path, dest)
          unlinkSync(c.path)
        } else {
          throw err
        }
      }
      moved.push({ from: c.path, to: dest })
    } catch (err) {
      failed.push({ path: c.path, error: String(err && err.message ? err.message : err) })
    }
  }
  return { moved, failed }
}
