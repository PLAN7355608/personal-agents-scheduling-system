import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/db.js'
import { createWorkItem, getWorkItem, transition } from '../../src/workitems.js'
import { recoverOnStart } from '../../src/recovery.js'

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-rec-'))
  return { dir, path: join(dir, 'secretary.db') }
}

test('重启恢复：上次 running 的任务 → blocked（不假装成功）', () => {
  const { dir, path } = tempDb()
  let db1
  let db2
  try {
    db1 = openDb({ path })
    const { item } = createWorkItem(db1, { channel: 'gui', peer: 'owner', intent: '跑一半的活' })
    transition(db1, item.id, 'triaged', { reason: 'r' })
    transition(db1, item.id, 'queued', { reason: 'r' })
    transition(db1, item.id, 'running', { reason: 'r' })
    db1.close()
    db1 = null

    db2 = openDb({ path })
    const rec = recoverOnStart(db2, {})
    assert.equal(rec.rebuilt, 1)
    assert.equal(rec.blockedRunning, 1)
    const after = getWorkItem(db2, item.id)
    assert.equal(after.status, 'blocked')
    assert.equal(after.needsHuman, true)
  } finally {
    try { if (db1) db1.close() } catch { /* ignore */ }
    try { if (db2) db2.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重启恢复：陈旧 queued 任务 → blocked', () => {
  const { dir, path } = tempDb()
  let db1
  let db2
  try {
    const longAgo = Date.now() - 300000
    db1 = openDb({ path })
    // 用旧时间戳写事件，保证重建投影后 updated_at 仍是旧的（模拟"派单中途死掉"）
    const { item } = createWorkItem(db1, { channel: 'gui', peer: 'owner', intent: '没派出去的活', ts: longAgo })
    transition(db1, item.id, 'triaged', { reason: 'r', ts: longAgo })
    transition(db1, item.id, 'queued', { reason: 'r', ts: longAgo })
    db1.close()
    db1 = null

    db2 = openDb({ path })
    const rec = recoverOnStart(db2, {})
    assert.equal(rec.blockedQueued, 1)
    assert.equal(getWorkItem(db2, item.id).status, 'blocked')
  } finally {
    try { if (db1) db1.close() } catch { /* ignore */ }
    try { if (db2) db2.close() } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
