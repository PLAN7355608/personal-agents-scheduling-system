// 系统保护路径 / 提权命令识别：给工人守卫用，避免工人悄悄改系统配置或提权。

const PROTECTED_PATTERNS = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\users\\[^\\]+\\appdata\\local\\microsoft\\windows\\inetcache(\\|$)/i,
]

/** 是否系统保护路径（Windows 目录 / Program Files / ProgramData 等）。 */
export function isProtectedPath(input) {
  const p = String(input || '').trim().replace(/\//g, '\\')
  if (!p) return false
  return PROTECTED_PATTERNS.some((re) => re.test(p))
}

const ESCALATION_PATTERNS = [
  { re: /-verb\s+runas/i, why: '用 RunAs 提权启动进程' },
  { re: /start-process[^\n]*-verb\s+runas/i, why: '用 Start-Process -Verb RunAs 提权' },
  { re: /schtasks(\.exe)?[^\n]*\/create/i, why: '创建计划任务（可绕开权限）' },
  { re: /takeown[^\n]*(windows|program files)/i, why: '修改系统文件所有权' },
  { re: /icacls[^\n]*(windows|program files)/i, why: '修改系统目录 ACL' },
  { re: /reg\s+add[^\n]*hklm/i, why: '修改 HKLM 注册表' },
  { re: /(set-content|add-content|copy-item|out-file)[^\n]*\\windows\\(system32\\)?drivers\\etc\\hosts/i, why: '写系统 hosts 文件' },
]

/** 命令是否包含提权/系统修改动作；返回命中说明，没有命中返回 null。 */
export function escalationReason(command) {
  const cmd = String(command || '')
  if (!cmd) return null
  for (const p of ESCALATION_PATTERNS) {
    if (p.re.test(cmd)) return p.why
  }
  return null
}

/**
 * 统一检查一个工具调用是否触碰系统保护边界。
 * 返回 { kind, detail } 或 null。
 */
export function protectedBoundaryReason(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  if (name === 'write' || name === 'edit' || name === 'write_file' || name === 'apply_patch') {
    const target = a.file_path || a.path || a.file || ''
    if (isProtectedPath(target)) return { kind: 'path', detail: '写入系统目录：' + target }
    return null
  }
  if (name === 'bash' || name === 'pwsh') {
    const command = typeof args === 'string' ? args : String(a.command || a.script || '')
    const why = escalationReason(command)
    if (why) return { kind: 'command', detail: why }
    return null
  }
  return null
}
