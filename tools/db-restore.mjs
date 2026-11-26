// 从一致性快照还原：先 integrity_check + schema 版本校验，再原子替换（临时文件 + rename）。
// 替换前把旧库另存为 <目标>.bak；目标 -wal 非空且拿不到排他锁（说明有写入方）时拒绝盲替换。
// 用法：node tools/db-restore.mjs <快照路径> <目标库路径>
import { DatabaseSync } from 'node:sqlite'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCHEMA_VERSION } from '../plugin/src/types.js'
import { readSnapshotInfo } from './db-backup.mjs'

/** 拒绝还原（可操作的失败原因），CLI 用退出码 3 区分于普通错误。 */
export class RestoreRefused extends Error {
  constructor(message) {
    super(message)
    this.name = 'RestoreRefused'
    this.code = 'RESTORE_REFUSED'
  }
}

/** 快照校验：integrity_check 必须 ok，schema 版本必须存在且不高于当前代码。 */
export function inspectSnapshot(snapshotPath) {
  const path = resolve(snapshotPath)
  if (!existsSync(path)) throw new RestoreRefused(`快照不存在：${path}`)

  let info
  try {
    info = readSnapshotInfo(path)
  } catch (err) {
    throw new RestoreRefused(`快照打不开（不是完整的 SQLite 库？）：${err.message}`)
  }
  if (!info.ok) throw new RestoreRefused(`快照 integrity_check 未通过：${info.integrity.join('; ')}`)
  if (!Number.isInteger(info.schemaVersion) || info.schemaVersion <= 0) {
    throw new RestoreRefused('快照缺 schema_meta.schemaVersion，无法校验 schema 版本')
  }
  if (info.schemaVersion > SCHEMA_VERSION) {
    throw new RestoreRefused(`快照 schema 版本 ${info.schemaVersion} 高于当前代码 ${SCHEMA_VERSION}，拒绝还原（同一库只能前进迁移）`)
  }
  return info
}

function walBytes(dbPath) {
  const p = `${dbPath}-wal`
  return existsSync(p) ? statSync(p).size : 0
}

/**
 * 替换前确认目标库没有写入方：用 busy_timeout=0 抢排他锁，抢不到就拒绝（不盲替换）。
 * -wal 非空时（还有已提交事务在 WAL 里）再 checkpoint(TRUNCATE) 把 WAL 落到主文件，
 * 这样旧库的 .bak 副本才是自洽的单文件。
 */
function prepareTarget(dbPath) {
  const before = walBytes(dbPath)

  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (err) {
    throw new RestoreRefused(`目标库打不开（-wal ${before} 字节），拒绝盲替换：${err.message}`)
  }
  try {
    db.exec('PRAGMA busy_timeout = 0;')
    try {
      db.exec('BEGIN EXCLUSIVE')
      db.exec('ROLLBACK')
    } catch (err) {
      throw new RestoreRefused(`目标库正被写入（-wal ${before} 字节，拿不到排他锁），拒绝盲替换；请先停掉内核/写入方再还原`)
    }
    if (before === 0) return { walBytes: 0, checkpointed: false }
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    const left = walBytes(dbPath)
    if (Number(row.busy) !== 0 || left > 0) {
      throw new RestoreRefused(`目标库 -wal 非空（${before} 字节）且 checkpoint 失败（还有读写连接占用，残留 ${left} 字节），拒绝盲替换；请先停掉所有连接再还原`)
    }
    return { walBytes: before, checkpointed: true }
  } finally {
    db.close()
  }
}

function fsyncFile(path) {
  // Windows 沙箱/部分文件系统会对 FlushFileBuffers 返回 EPERM：退化为 best-effort，
  // 由还原后的 integrity_check + 行数复核兜底，不因为一次 fsync 失败就中断还原。
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

function fsyncDir(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch { /* Windows 等不支持目录 fsync：忽略 */ } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 还原：校验快照 → （必要时 checkpoint）→ 旧库另存 .bak → 临时文件 + rename 原子替换 → 复核。
 * 任何前置校验失败都抛 RestoreRefused，此时目标库未被改动。
 */
export function restoreSnapshot({ snapshotPath, targetPath, log = () => {} } = {}) {
  if (!snapshotPath) throw new RestoreRefused('缺少快照路径')
  if (!targetPath) throw new RestoreRefused('缺少目标库路径')
  const snap = resolve(snapshotPath)
  const target = resolve(targetPath)
  if (snap === target) throw new RestoreRefused('快照路径与目标库路径相同，拒绝自我覆盖')

  const info = inspectSnapshot(snap)
  log(`快照校验通过：integrity_check=${info.integrity.join('; ')} schemaVersion=${info.schemaVersion}`)

  let backupPath = null
  let checkpointed = false
  if (existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    const cp = prepareTarget(target)
    checkpointed = cp.checkpointed
    if (checkpointed) log(`旧库 -wal（${cp.walBytes} 字节）已 checkpoint 进主文件`)

    backupPath = `${target}.bak`
    copyFileSync(target, backupPath)
    if (!fsyncFile(backupPath)) log('注意：本机 fsync 不可用（Windows 沙箱），旧库备份按 best-effort 处理')
    log(`旧库已另存：${backupPath}`)

    // 旧库内容已在 .bak 里，主文件之外的 -wal/-shm（以及 rollback 模式残留的 -journal）不再需要，
    // 留着会和替换后的主文件错配；此刻已持过排他锁，残留 journal 只可能来自已回滚/崩溃的未提交事务。
    // Windows 上被其他连接占用的文件删不掉：checkpoint 后 -wal 已是 0 字节，留着也安全（SQLite 会按
    // WAL 头里的 salt 判定失配并丢弃），所以这里删不掉不致命。
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { rmSync(`${target}${suffix}`, { force: true }) } catch { /* 被占用：忽略 */ }
    }
  } else {
    mkdirSync(dirname(target), { recursive: true })
  }

  // 同目录临时文件 + rename：要么旧库，要么新库，不会出现半个文件。
  const tmp = `${target}.restore-${process.pid}-${Date.now()}.tmp`
  try {
    copyFileSync(snap, tmp)
    fsyncFile(tmp)
    renameSync(tmp, target)
    fsyncDir(dirname(target))
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    if (err && ['EPERM', 'EBUSY', 'EACCES'].includes(String(err.code))) {
      throw new RestoreRefused(
        `目标库仍被其他进程打开（Windows 不能替换已打开的文件），请先停掉内核/写入方再还原：${err.message}`,
      )
    }
    throw err
  }

  const restored = readSnapshotInfo(target)
  if (!restored.ok) {
    throw new Error(`还原后 integrity_check 未通过：${restored.integrity.join('; ')}（旧库在 ${backupPath || '无'}）`)
  }
  const sameCounts = JSON.stringify(restored.counts) === JSON.stringify(info.counts)
  if (!sameCounts) {
    throw new Error(`还原后行数与快照不一致（旧库在 ${backupPath || '无'}）：快照=${JSON.stringify(info.counts)} 还原后=${JSON.stringify(restored.counts)}`)
  }
  log(`还原完成：${target}（integrity_check=ok，schemaVersion=${restored.schemaVersion}）`)

  return {
    targetPath: target,
    snapshotPath: snap,
    backupPath,
    checkpointed,
    snapshot: info,
    restored,
  }
}

export function formatReport(result) {
  const lines = [
    `还原完成：${result.targetPath}`,
    `  来源快照：${result.snapshotPath}（schemaVersion=${result.snapshot.schemaVersion}）`,
    `  旧库备份：${result.backupPath || '（目标库原先不存在，无 .bak）'}`,
    `  integrity_check：${result.restored.integrity.join('; ')}`,
    `  行数：${Object.entries(result.restored.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
  ]
  return lines.join('\n')
}

function main(argv) {
  if (argv.length !== 2 || argv.includes('-h') || argv.includes('--help')) {
    console.error('usage: node tools/db-restore.mjs <快照路径> <目标库路径>')
    return 2
  }
  try {
    const result = restoreSnapshot({ snapshotPath: argv[0], targetPath: argv[1], log: (m) => console.log(m) })
    console.log(formatReport(result))
    return 0
  } catch (err) {
    if (err instanceof RestoreRefused) {
      console.error(`拒绝还原：${err.message}`)
      return 3
    }
    console.error(`还原失败：${err.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
