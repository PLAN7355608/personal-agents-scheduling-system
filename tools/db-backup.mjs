// 一致性备份：VACUUM INTO 导出单文件快照（已提交的 WAL 内容一并进快照），
// 并打印 integrity_check / schema 版本 / 表行数摘要。
// 用法：node tools/db-backup.mjs [--db <库路径>] [--out <目录>]
// 默认库路径与 plugin/src/paths.js 一致（~/.dsh/secretary/secretary.db），默认输出 backups/。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

// FTS5 的影子表不计数（memories_fts_data / _idx / _content / _docsize / _config）。
const SHADOW = /_(data|idx|content|docsize|config)$/

export function defaultDbPath() {
  return join(homedir(), '.dsh', 'secretary', 'secretary.db')
}

/** UTC 时间戳，形如 20261125T154354Z（排序友好、无冒号，可直接做文件名）。 */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function sqlQuote(path) {
  return `'${String(path).replace(/'/g, "''")}'`
}

function isUserTable(name) {
  return !name.startsWith('sqlite_') && name !== 'memories_fts' && !SHADOW.test(name)
}

/** 各表行数摘要（只统计普通表；FTS5 虚表与其影子表跳过）。 */
export function countRows(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((r) => String(r.name))
    .filter(isUserTable)
  const counts = {}
  for (const name of names) {
    const quoted = `"${name.replace(/"/g, '""')}"`
    counts[name] = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get().c)
  }
  return counts
}

/** 只读打开一个库/快照，返回校验信息（不写任何东西）。 */
export function readSnapshotInfo(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => String(r.integrity_check))
    const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()
    return {
      ok: integrity.length === 1 && integrity[0].toLowerCase() === 'ok',
      integrity,
      schemaVersion: versionRow ? Number(versionRow.value) : 0,
      counts: countRows(db),
    }
  } finally {
    db.close()
  }
}

/**
 * 用 VACUUM INTO 导出一致性快照。
 * 源库以只读连接打开：在线库（含未 checkpoint 的 -wal）也能拿到已提交状态的完整快照，
 * 且不会因为备份动作本身在源库上产生写入。
 */
export function createSnapshot({ dbPath = defaultDbPath(), outDir = 'backups', now = new Date() } = {}) {
  const src = resolve(dbPath)
  if (!existsSync(src)) throw new Error(`库不存在：${src}`)

  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })

  const stamp = utcStamp(now)
  let snapshotPath = join(dir, `secretary-${stamp}.db`)
  for (let i = 2; existsSync(snapshotPath); i += 1) snapshotPath = join(dir, `secretary-${stamp}-${i}.db`)

  const db = new DatabaseSync(src, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`VACUUM INTO ${sqlQuote(snapshotPath)}`)
  } finally {
    db.close()
  }

  const info = readSnapshotInfo(snapshotPath)
  return { dbPath: src, snapshotPath, ...info }
}

export function formatReport(info) {
  const lines = [
    `备份文件：${info.snapshotPath}`,
    `  integrity_check：${info.integrity.join('; ')}`,
    `  schemaVersion：${info.schemaVersion}`,
    `  行数：${Object.entries(info.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  ]
  return lines.join('\n')
}

function main(argv) {
  const opts = { dbPath: defaultDbPath(), outDir: 'backups' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') opts.dbPath = argv[++i]
    else if (a === '--out') opts.outDir = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log('usage: node tools/db-backup.mjs [--db <库路径>] [--out <目录>]')
      return 0
    } else {
      console.error(`未知参数：${a}`)
      return 2
    }
  }
  try {
    const info = createSnapshot(opts)
    console.log(formatReport(info))
    if (!info.ok) {
      console.error('快照 integrity_check 未通过，文件保留待排查')
      return 1
    }
    return 0
  } catch (err) {
    console.error(`备份失败：${err.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
