// 路径解析：让插件在 Windows / Linux 上都能用。
// 配置留空 → 用用户目录下的 .dsh/secretary（跨平台）；工作区留空 → 用进程当前目录。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function resolveDbPath(configured) {
  const raw = String(configured || '').trim()
  if (!raw) return join(homedir(), '.dsh', 'secretary', 'secretary.db')
  return resolve(raw)
}

export function resolveWorkspaceRoot(configured) {
  const raw = String(configured || '').trim()
  if (!raw) return homedir()
  return resolve(raw)
}
