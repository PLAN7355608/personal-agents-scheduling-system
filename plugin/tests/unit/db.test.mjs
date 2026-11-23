import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSchemaVersion, openDb } from '../../src/db.js'
import { SCHEMA_VERSION } from '../../src/types.js'

test('文件库：schema 版本、WAL、表齐全', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-db-'))
  const path = join(dir, 'secretary.db')
  try {
    const db = openDb({ path })
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION)
    const mode = db.prepare('PRAGMA journal_mode').get()
    assert.equal(String(mode.journal_mode).toLowerCase(), 'wal')

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r) => r.name)
    for (const t of ['events', 'workitems', 'threads', 'sessions', 'memories', 'artifacts', 'judge_calls', 'approvals', 'channel_health']) {
      assert.ok(tables.includes(t), `缺少表 ${t}`)
    }
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重复 open 幂等：迁移不会重复执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-db-'))
  const path = join(dir, 'secretary.db')
  try {
    openDb({ path }).close()
    const db = openDb({ path })
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
