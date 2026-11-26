import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getSchemaVersion, openDb } from '../../src/db.js'
import { appendEvent, countEvents } from '../../src/events.js'
import { SCHEMA_VERSION } from '../../src/types.js'
import { createSnapshot } from '../../../tools/db-backup.mjs'
import { inspectSnapshot, restoreSnapshot, RestoreRefused } from '../../../tools/db-restore.mjs'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-backup-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(db, n = 2) {
  for (let i = 0; i < n; i += 1) {
    appendEvent(db, { type: 'kernel.started', actor: 'kernel', payload: { i } })
  }
}

test('备份：单文件快照包含未 checkpoint 的已提交 WAL 事务', () => withDir((dir) => {
  const dbPath = join(dir, 'secretary.db')
  const db = openDb({ path: dbPath })
  try {
    seed(db, 2)
    // 不 close：已提交事务还在 -wal 里，这正是旧部署脚本会漏掉的场景
    assert.ok(statSync(`${dbPath}-wal`).size > 0, '-wal 应为非空')

    const snap = createSnapshot({ dbPath, outDir: join(dir, 'backups'), now: new Date('2026-11-25T15:43:54Z') })
    assert.equal(basename(snap.snapshotPath), 'secretary-20261125T154354Z.db')
    assert.equal(snap.ok, true)
    assert.deepEqual(snap.integrity, ['ok'])
    assert.equal(snap.schemaVersion, SCHEMA_VERSION)
    assert.equal(snap.counts.events, 2)
    assert.equal(existsSync(`${snap.snapshotPath}-wal`), false, '快照应是单文件（无 -wal）')
  } finally {
    db.close()
  }
}))

test('还原：数据回滚、integrity_check ok、旧库留在 .bak', () => withDir((dir) => {
  const dbPath = join(dir, 'secretary.db')
  const db = openDb({ path: dbPath })
  try {
    seed(db, 2)
    const snap = createSnapshot({ dbPath, outDir: join(dir, 'backups') })
    assert.equal(snap.counts.events, 2)

    // 备份之后再改库：多一条事件 + 篡改已有行
    appendEvent(db, { type: 'kernel.started', actor: 'kernel', payload: { i: 99 } })
    db.exec("UPDATE events SET actor = 'tampered' WHERE seq = 1")
    // 连接保持打开（空闲、不持写锁）：已提交事务留在 -wal 里，还原时应先 checkpoint
    assert.ok(statSync(`${dbPath}-wal`).size > 0, '-wal 应为非空')

    // Windows 上不能替换/删除正被打开的文件（rename 会 EPERM）：先关连接，等同「停掉内核」。
    // POSIX 上保持打开，验证「有连接但仍能安全 checkpoint + 替换」。
    const isWindows = process.platform === 'win32'
    if (isWindows) db.close()

    const result = restoreSnapshot({ snapshotPath: snap.snapshotPath, targetPath: dbPath })
    if (!isWindows) {
      assert.equal(result.checkpointed, true, '-wal 非空且无写入方：应先 checkpoint 再替换')
    }
    assert.equal(result.backupPath, `${dbPath}.bak`)
    assert.ok(existsSync(result.backupPath), '旧库应另存为 .bak')
    assert.equal(result.restored.ok, true)
    assert.equal(result.restored.counts.events, 2)

    // 还原后的库能正常打开、数据是备份时的样子
    const re = openDb({ path: dbPath })
    try {
      assert.equal(getSchemaVersion(re), SCHEMA_VERSION)
      assert.equal(countEvents(re), 2)
      const bad = re.prepare("SELECT COUNT(*) AS c FROM events WHERE actor = 'tampered'").get()
      assert.equal(Number(bad.c), 0, '备份之后的修改应被回滚')
      assert.deepEqual(re.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check), ['ok'])
    } finally {
      re.close()
    }

    // .bak 保留的是被替换掉的旧库（含后来的 3 条事件）
    const bak = new DatabaseSync(result.backupPath, { readOnly: true })
    try {
      assert.equal(Number(bak.prepare('SELECT COUNT(*) AS c FROM events').get().c), 3)
      assert.deepEqual(bak.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check), ['ok'])
    } finally {
      bak.close()
    }
  } finally {
    try { db.close() } catch { /* Windows 分支里已提前关掉 */ }
  }
}))

test('还原：-wal 非空且库正被写入时拒绝盲替换', () => withDir((dir) => {
  const dbPath = join(dir, 'secretary.db')
  const snapDir = join(dir, 'backups')
  const db = openDb({ path: dbPath })
  try {
    seed(db, 1)
    const snap = createSnapshot({ dbPath, outDir: snapDir })

    db.exec('BEGIN IMMEDIATE')
    appendEvent(db, { type: 'kernel.started', actor: 'kernel', payload: { i: 1 } })
    assert.ok(statSync(`${dbPath}-wal`).size > 0)

    assert.throws(
      () => restoreSnapshot({ snapshotPath: snap.snapshotPath, targetPath: dbPath }),
      (err) => err instanceof RestoreRefused && /正被写入/.test(err.message),
    )
    // 被拒绝时目标库没被动过：未提交事务还在，-wal 还在
    assert.ok(existsSync(`${dbPath}-wal`))
    assert.equal(existsSync(`${dbPath}.bak`), false)
    db.exec('ROLLBACK')
  } finally {
    db.close()
  }
}))

test('还原：快照校验不通过一律拒绝（缺失/坏文件/版本过新）', () => withDir((dir) => {
  const target = join(dir, 'secretary.db')
  assert.throws(() => inspectSnapshot(join(dir, 'nope.db')), (err) => err instanceof RestoreRefused && /不存在/.test(err.message))

  const junk = join(dir, 'junk.db')
  writeFileSync(junk, 'not a sqlite database at all')
  assert.throws(() => inspectSnapshot(junk), (err) => err instanceof RestoreRefused)

  const future = join(dir, 'future.db')
  const fdb = new DatabaseSync(future)
  try {
    fdb.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    fdb.prepare("INSERT INTO schema_meta (key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION + 1))
  } finally {
    fdb.close()
  }
  assert.throws(() => inspectSnapshot(future), (err) => err instanceof RestoreRefused && /高于当前代码/.test(err.message))

  // 三种拒绝都不应碰目标库
  assert.equal(existsSync(target), false)
}))
