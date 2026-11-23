// 任务工作区解析：把「指定工作区」变成可用的绝对目录（不存在就报错，不猜）。
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

function underPath(cwd, root) {
  const r = resolve(root)
  return cwd === r || cwd.startsWith(r + '/') || cwd.startsWith(r + '\\')
}

export function resolveTaskWorkspace(input, cfg = {}) {
  const raw = String(input || '').trim()
  const base = raw || String(cfg.workspaceRoot || '').trim() || process.cwd()
  if (!isAbsolute(base)) return { error: '工作区必须是绝对路径：' + base }
  let st = null
  try { st = statSync(base) } catch { return { error: '工作区不存在：' + base } }
  if (!st.isDirectory()) return { error: '工作区不是目录：' + base }
  const cwd = resolve(base)
  const allowed = Array.isArray(cfg.allowedWorkspaces) ? cfg.allowedWorkspaces.filter(Boolean) : []
  if (allowed.length && !allowed.some((r) => underPath(cwd, r))) {
    return { error: '工作区不在允许列表里：' + cwd + '（允许：' + allowed.join('、') + '）' }
  }
  return { cwd }
}

export function existsDir(p) {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}
