// 删除护栏：解析 bash/pwsh 里的删除命令，限制目标范围、拦高危、统计规模。
// 原则：工作区内小删除放行并审计；工作区外/根目录/通配 → 拒绝；大删除 → 上报审批。
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const DEL_VERBS = new Set(['rm', 'rmdir', 'rd', 'unlink', 'erase', 'deltree', 'shred', 'truncate', 'dd', 'remove-item', 'del'])
const FIND_DELETE = /\bfind\b[^\n]*\s-delete\b/i
// 无法静态解析目标的高危形态：直接转审批，不猜
const DEL_WORDS = /\b(rm|rmdir|rd|del|erase|deltree|unlink|shred|truncate|Remove-Item)\b/i
const OPAQUE_DELETE = [
  /\bfind\b[^\n]*(?:-exec[^\n]*\b(?:rm|rmdir|del|Remove-Item)\b|-ok[^\n]*\brm\b)/i,
  /(?:pwsh|powershell)(?:\.exe)?\b[^\n]*\s-(?:File|EncodedCommand|enc)\b/i,
  /\bgit\s+clean\b[^\n]*\s-[a-z]*f/i,
]

// 只看「真正作为命令出现」的删除词（避免 python 里 dd=d.get(...) 这种误判）
const CMD_PREFIX_SKIP = new Set(['sudo', 'command', 'env', 'time', 'nice', 'nohup'])
function segmentDeleteCommand(seg) {
  const parts = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  let i = 0
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i += 1
  while (i < parts.length && CMD_PREFIX_SKIP.has(parts[i].toLowerCase())) i += 1
  if (i >= parts.length) return null
  const cmd = parts[i].replace(/^['"]|['"]$/g, '').toLowerCase()
  if (cmd === 'find' && FIND_DELETE.test(seg)) return 'find'
  return DEL_VERBS.has(cmd) ? cmd : null
}
function containsDeleteCommand(cmdText) {
  for (const seg of splitSegments(cmdText)) {
    if (segmentDeleteCommand(seg)) return true
  }
  return false
}

function opaqueDelete(cmdText) {
  if (OPAQUE_DELETE.some((re) => re.test(cmdText))) return true
  // pwsh -File 只有同时出现删除词才 escalate（脚本内容无法静态读）
  if (/(?:pwsh|powershell)(?:\.exe)?\b[^\n]*\s-File\b/i.test(cmdText) && DEL_WORDS.test(cmdText)) return true
  return false
}

function stripQuotes(t) {
  return t.replace(/^['"]|['"]$/g, '')
}

function splitSegments(command) {
  return String(command || '')
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function tokens(seg) {
  return seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
}

function cdTarget(seg) {
  const parts = tokens(seg).map(stripQuotes)
  if (!parts.length) return null
  const head = parts[0].toLowerCase()
  if ((head === 'cd' || head === 'pushd') && parts[1]) {
    if (parts[1].startsWith('-')) return null
    return parts[1]
  }
  return null
}

function absolutize(raw, cwd) {
  return (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) ? raw : resolve(cwd || '.', raw)
}

function targetsFromSegment(seg, cwd) {
  const out = []
  const parts = tokens(seg).map(stripQuotes)
  const lower = parts.map((p) => p.toLowerCase())
  for (let i = 0; i < parts.length; i += 1) {
    const cmd = lower[i]
    if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'rd' || cmd === 'unlink' || cmd === 'erase' || cmd === 'deltree' || cmd === 'shred' || cmd === 'truncate' || cmd === 'remove-item' || cmd === 'del') {
      for (let j = i + 1; j < parts.length; j += 1) {
        const t = parts[j]
        if (t.startsWith('-')) continue
        if (/^[a-z_]+=/.test(t)) continue
        out.push({ raw: t, abs: absolutize(t, cwd) })
      }
      break
    }
    if (cmd === 'dd') {
      for (const t of parts.slice(i + 1)) if (t.startsWith('of=')) {
        const raw = t.slice(3)
        out.push({ raw, abs: absolutize(raw, cwd) })
      }
      break
    }
    if (cmd === 'find' && FIND_DELETE.test(seg)) {
      for (const t of parts.slice(i + 1)) {
        if (t.startsWith('-') || t.startsWith('(') || t.startsWith('!')) break
        out.push({ raw: t, abs: absolutize(t, cwd) })
      }
      break
    }
  }
  return out
}

function under(cwd, root) {
  const r = resolve(root)
  return cwd === r || cwd.startsWith(r + '/') || cwd.startsWith(r + '\\')
}

// 把工作区内的通配展开成真实文件（只匹配单层，用于「清理任务自己生成的临时文件」）
function expandGlob(absPath) {
  const dir = dirname(absPath)
  const pattern = basename(absPath)
  if (!pattern.includes('*') && !pattern.includes('?')) return []
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const reStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$'
  let re
  try { re = new RegExp(reStr, 'i') } catch { return [] }
  return entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => dir + '/' + e.name)
}

function countFilesRecursive(p, limit = 500) {  let n = 0
  let bytes = 0
  const walk = (dir, depth) => {
    if (n >= limit || depth > 6) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (n >= limit) return
      const full = dir + '/' + e.name
      if (e.isDirectory()) walk(full, depth + 1)
      else {
        n += 1
        try { bytes += statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  try {
    const st = statSync(p)
    if (st.isDirectory()) walk(p, 0)
    else return { count: 1, bytes: st.size }
  } catch {
    return { count: 0, bytes: 0 }
  }
  return { count: n, bytes }
}

/**
 * @returns {{kind:'none'|'delete', action:'allow'|'deny'|'escalate', reason?:string,
 *            targets?:string[], count?:number, bytes?:number, risk?:string}}
 */
export function analyzeDeletionCommand(command, { workspaceRoot = '', searchDirs = [], workdir = '', maxFilesAuto = 50 } = {}) {
  const cmdText = String(command || '')
  if (!cmdText) return { kind: 'none', action: 'allow' }
  // 不可静态解析的高危形态：即使没有直接删除词，也先转审批（如 pwsh -File 脚本）
  if (opaqueDelete(cmdText)) {
    return {
      kind: 'delete',
      action: 'escalate',
      reason: '删除/脚本命令形态无法静态确认目标（-exec rm / pwsh -File / git clean 等），先列清单给主人确认',
      risk: 'opaque',
      rawTargets: [],
    }
  }
  const startsDelete = containsDeleteCommand(cmdText)
  if (!startsDelete) return { kind: 'none', action: 'allow' }

  const roots = [workspaceRoot, ...(searchDirs || [])].filter(Boolean).map((r) => resolve(r))
  let base = workdir ? resolve(workdir) : roots[0] || process.cwd()
  const targets = []
  const rawTargets = []
  for (const seg of splitSegments(cmdText)) {
    const cdTo = cdTarget(seg)
    if (cdTo) {
      if (cdTo.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(cdTo)) base = resolve(cdTo)
      else if (cdTo !== '-') base = resolve(base, cdTo)
      continue
    }
    for (const t of targetsFromSegment(seg, base)) {
      targets.push(t.abs)
      rawTargets.push(t.raw)
    }
  }
  if (!targets.length) {
    // 有删除命令但解析不到目标（可能变量/通配），按高风险处理
    return { kind: 'delete', action: 'escalate', reason: '删除命令的目标无法确认（可能含变量或通配），先列清单给主人确认', risk: 'ambiguous', rawTargets: [] }
  }

  // 先按"用户原样写的目标"拦：~、环境变量、根、通配（不能被工作区解析掩盖）
  // 例外：工作区内的通配（典型是任务自己生成的临时图/脚本，如 build/tb-*.png）→ 展开后按规模放行
  const resolved = []
  for (let i = 0; i < rawTargets.length; i += 1) {
    const raw = rawTargets[i]
    const abs = targets[i]
    if (raw === '/' || raw === '/*' || raw === '*' || raw.startsWith('~')) {
      return { kind: 'delete', action: 'deny', reason: '拒绝删除根目录/家目录/通配：' + raw, risk: 'root' }
    }
    if (/%[A-Za-z_]+%/.test(raw) || /^\$(HOME|USERPROFILE)\b/i.test(raw)) {
      return { kind: 'delete', action: 'deny', reason: '拒绝删除含环境变量展开的目标：' + raw, risk: 'root' }
    }
    if (raw.includes('$')) {
      return { kind: 'delete', action: 'deny', reason: '拒绝带变量的删除：' + raw, risk: 'wildcard' }
    }
    if (raw.includes('*')) {
      const expanded = expandGlob(abs)
      if (!expanded.length) {
        return { kind: 'delete', action: 'deny', reason: '通配没有匹配到文件（或无法展开）：' + raw, risk: 'wildcard' }
      }
      const outside = expanded.find((p) => !roots.some((r) => under(p, r)))
      if (outside) {
        return { kind: 'delete', action: 'deny', reason: '通配展开后含工作区外目标：' + outside, risk: 'outside' }
      }
      resolved.push(...expanded)
      continue
    }
    // 再按绝对路径检查是否落在工作区/白名单目录内
    if (roots.some((r) => abs === r)) {
      return { kind: 'delete', action: 'deny', reason: '拒绝删除工作区/共享目录根：' + abs, risk: 'root' }
    }
    if (!roots.some((r) => under(abs, r))) {
      return { kind: 'delete', action: 'deny', reason: '目标不在工作区/共享目录内：' + abs, risk: 'outside' }
    }
    resolved.push(abs)
  }

  let count = 0
  let bytes = 0
  for (const p of resolved) {
    const r = countFilesRecursive(p)
    count += r.count
    bytes += r.bytes
  }
  if (count > Math.max(1, Number(maxFilesAuto) || 50)) {
    return { kind: 'delete', action: 'escalate', reason: '一次删除 ' + count + ' 个文件，超过自动放行阈值（' + maxFilesAuto + '）', targets: resolved, rawTargets, count, bytes, risk: 'large' }
  }
  return { kind: 'delete', action: 'allow', targets: resolved, rawTargets, count, bytes }
}
