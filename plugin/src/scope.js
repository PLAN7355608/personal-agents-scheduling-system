// 任务作用域推断：项目根 + 相对路径前缀。
// 三档：auto（高置信直接生效）/ suggest（只建议，默认）/ manual（不推断）。
const ABS_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?\r\n]+/g

function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function extractPaths(text) {
  const body = String(text || '')
  const hits = body.match(ABS_PATH) || []
  return hits
    .map((p) => norm(p).replace(/[),.;:!?]+$/, ''))
    .filter((p) => p.length > 2)
    .filter((p) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !p.startsWith('//'))
}

/** 从文本/路径推断任务落在哪个项目与 scope。 */
export function inferScope({ text = '', cfg = {}, lane = null } = {}) {
  const mode = (lane && lane.scopeMode) || cfg.defaultScopeMode || 'suggest'
  if (mode === 'manual') return { projectRoot: null, scope: null, source: 'manual', confidence: 0 }

  const roots = []
  if (cfg.projects && Array.isArray(cfg.projects)) {
    for (const p of cfg.projects) {
      if (p && p.root) roots.push({ name: p.name || '', root: norm(p.root) })
    }
  }
  if (cfg.workspaceRoot) roots.push({ name: 'workspace', root: norm(cfg.workspaceRoot) })
  // 长根优先，避免子目录被父目录抢走
  roots.sort((a, b) => b.root.length - a.root.length)

  let best = null
  for (const p of extractPaths(text)) {
    for (const r of roots) {
      if (p === r.root || p.startsWith(r.root + '/')) {
        const rel = p === r.root ? '' : p.slice(r.root.length + 1)
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        const candidate = { projectRoot: r.root, scope: dir || null, source: 'auto', confidence: 0.9 }
        if (!best || p.length > best.pathLen) best = { ...candidate, pathLen: p.length }
      }
    }
  }
  if (best) {
    if (mode === 'auto' && best.confidence >= 0.8) {
      return { projectRoot: best.projectRoot, scope: best.scope, source: 'auto', confidence: best.confidence }
    }
    return { projectRoot: best.projectRoot, scope: best.scope, source: 'suggest', confidence: best.confidence }
  }

  // 没路径：按项目名关键字猜（中置信，只作建议）
  const body = String(text || '')
  for (const r of roots) {
    if (r.name && r.name !== 'workspace' && body.includes(r.name)) {
      return { projectRoot: r.root, scope: null, source: 'suggest', confidence: 0.6 }
    }
  }
  return { projectRoot: null, scope: null, source: mode === 'auto' ? 'auto' : 'suggest', confidence: 0 }
}
