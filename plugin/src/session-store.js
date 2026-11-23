// 读取 DSH 会话日志（只读）：找文件、读头、读全部事件。
// 用于「老会话登记」：检查它是什么预设、把它的事件 seed 进新工人会话。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function dshSessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 在所有 profile 目录里找某会话的最新日志文件。 */
export function findSessionLog(sessionId) {
  const root = dshSessionsRoot()
  if (!existsSync(root)) return null
  let best = null
  for (const profile of readdirSync(root)) {
    const dir = join(root, profile, sessionId)
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter((f) => f.startsWith('session.v') && f.endsWith('.jsonl.zstd'))
    if (!files.length) continue
    const file = join(dir, files[files.length - 1])
    const mtime = statSync(file).mtimeMs
    if (!best || mtime > best.mtime) best = { file, mtime, profile }
  }
  return best ? best.file : null
}

function decodeAllFrames(file) {
  const raw = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) starts.push(i)
  }
  if (!starts.length) throw new Error('不是 zstd 会话日志：' + file)
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : raw.length
    try { parts.push(zstdDecompressSync(raw.subarray(starts[i], end))) } catch { /* 假魔数跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 读会话头（创建时的 preset / cwd / 时间）。 */
export function readSessionHeader(sessionId) {
  const file = findSessionLog(sessionId)
  if (!file) return null
  const text = decodeAllFrames(file)
  const line = text.split('\n').find((l) => l.trim())
  if (!line) return null
  const head = JSON.parse(line)
  return {
    id: head.id || sessionId,
    createdAt: head.createdAt || 0,
    cwd: head.cwd || null,
    agentPreset: head.agentPreset || null,
    version: head.version || null,
    file,
  }
}

/** 读全部事件（seed 用）。坏行跳过。 */
export function readSessionEvents(sessionId) {
  const file = findSessionLog(sessionId)
  if (!file) return { events: [], header: null }
  const text = decodeAllFrames(file)
  const events = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s)
      if (obj && obj.type && obj.type !== 'session') events.push(obj)
    } catch { /* 跳过坏行 */ }
  }
  return { events, header: readSessionHeader(sessionId) }
}

/** 工人资格检查：只有 worker 预设的会话默认能直接当工人。 */
export function vetWorkerPreset(preset, { workerPreset = 'secretary-worker', force = false } = {}) {
  const p = String(preset || '')
  if (p === workerPreset) return { ok: true, reason: '预设匹配' }
  if (force) return { ok: true, reason: '非工人预设，但已强制登记' }
  return {
    ok: false,
    reason: '这个会话的预设是「' + (p || '未知') + '」，不是工人预设（' + workerPreset + '），' +
      '直接当工人可能不会按工人方式干活（可能转手再派活、或假报完成）。确认要用就传 force=true，或改用 mode=seed 把它变成带记忆的新工人。',
  }
}

export function sessionAgeDays(createdAt, now = Date.now()) {
  if (!createdAt) return null
  return (now - createdAt) / 86400000
}
