import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { appendEvent } from '../../src/events.js'
import { createWorkItem, transition } from '../../src/workitems.js'
import { findSilentDispatches } from '../../src/recovery.js'

const T0 = Date.parse('2026-11-27T10:00:00Z')

function running(db, sessionId = null) {
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', msgId: 'm1', kind: 'task', intent: '测试' })
  transition(db, item.id, 'triaged', { reason: 't', ts: T0 })
  transition(db, item.id, 'queued', { reason: 't', ts: T0 + 1000 })
  transition(db, item.id, 'running', { reason: 'dispatch', payload: { sessionId }, ts: T0 + 2000 })
  return item.id
}

function workerTool(db, id, ts) {
  appendEvent(db, { type: 'worker.tool', ownerId: 'owner', workitemId: id, sessionId: 's1', actor: 'worker', ts, payload: { tool: 'pwsh' } })
}

test('无回音：派单后既没 worker 事件也没日志更新 → 判死', () => {
  const db = openDb()
  const id = running(db)
  // 刚派单 1 分钟：还没到静默窗口
  assert.equal(findSilentDispatches(db, { now: T0 + 62000, silentMs: 8 * 60 * 1000 }).length, 0)
  // 9 分钟后仍无回音
  const hits = findSilentDispatches(db, { now: T0 + 2000 + 9 * 60 * 1000, silentMs: 8 * 60 * 1000 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, id)
  db.close()
})

test('有回音：派单后调过工具就不算静默', () => {
  const db = openDb()
  const id = running(db)
  workerTool(db, id, T0 + 3 * 60 * 1000)
  assert.equal(findSilentDispatches(db, { now: T0 + 2000 + 9 * 60 * 1000, silentMs: 8 * 60 * 1000 }).length, 0)
  db.close()
})

test('主人插话（worker.user_message）不算工人回音', () => {
  const db = openDb()
  const id = running(db)
  appendEvent(db, { type: 'worker.user_message', ownerId: 'owner', workitemId: id, sessionId: 's1', actor: 'owner', ts: T0 + 3 * 60 * 1000, payload: { source: 'kernel' } })
  assert.equal(findSilentDispatches(db, { now: T0 + 2000 + 9 * 60 * 1000, silentMs: 8 * 60 * 1000 }).length, 1)
  db.close()
})

test('非 running 的任务不参与判死', () => {
  const db = openDb()
  const id = running(db)
  transition(db, id, 'blocked', { reason: '已处理', ts: T0 + 3000 })
  assert.equal(findSilentDispatches(db, { now: T0 + 2000 + 9 * 60 * 1000, silentMs: 8 * 60 * 1000 }).length, 0)
  db.close()
})
