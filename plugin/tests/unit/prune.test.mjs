import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { rebuildProjection } from '../../src/workitems.js'
import { createWorkItem, finishWorkItem, getWorkItem, transition } from '../../src/workitems.js'
import { countEvents } from '../../src/events.js'
import { previewPrune, runPrune } from '../../src/prune.js'

function doneOld(db, text, daysAgo) {
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: text })
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r' })
  finishWorkItem(db, item.id, { result: 'ok' })
  const ts = Date.now() - daysAgo * 86400000
  db.prepare('UPDATE workitems SET updated_at = ? WHERE id = ?').run(ts, item.id)
  return item
}

test('previewPrune：只列终态且超期的任务', () => {
  const db = openDb()
  const old1 = doneOld(db, '很久以前的任务', 40)
  doneOld(db, '最近完成的任务', 1)
  const p = previewPrune(db, { days: 30 })
  assert.equal(p.count, 1)
  assert.equal(p.items[0].id, old1.id)
  db.close()
})

test('runPrune：删投影、留事件；活动任务不受影响', () => {
  const db = openDb()
  const old1 = doneOld(db, '旧任务', 40)
  const { item: active } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '在办任务' })
  transition(db, active.id, 'triaged', { reason: 'r' })
  transition(db, active.id, 'queued', { reason: 'r' })
  const eventsBefore = countEvents(db)

  const r = runPrune(db, { days: 30 })
  assert.equal(r.deleted, 1)
  assert.equal(getWorkItem(db, old1.id), null)
  assert.equal(getWorkItem(db, active.id).status, 'queued')
  assert.equal(countEvents(db), eventsBefore + 1, '审计事件 +1（workitem.pruned）')
  assert.ok(db.prepare("SELECT 1 FROM events WHERE type = 'workitem.pruned'").get(), '要有 pruned 审计事件')
  // 重建投影也不能把已清理的任务复活
  rebuildProjection(db)
  assert.equal(getWorkItem(db, old1.id), null)
  assert.equal(getWorkItem(db, active.id).status, 'queued')

  db.close()
})

test('runPrune：没有可清理时返回 0', () => {
  const db = openDb()
  const r = runPrune(db, { days: 30 })
  assert.equal(r.deleted, 0)
  db.close()
})
