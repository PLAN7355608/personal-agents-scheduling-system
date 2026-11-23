import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { appendEvent } from '../../src/events.js'
import { createWorkItem, failWorkItem, finishWorkItem, transition } from '../../src/workitems.js'
import { buildWorkitemTrace } from '../../src/trace.js'

function running(db) {
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '跑个活' })
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r', payload: { sessionId: 'session-x' } })
  return item
}

test('trace：完成任务的步骤/产物/统计', () => {
  const db = openDb()
  const item = running(db)
  appendEvent(db, {
    type: 'worker.tool', actor: 'worker', workitemId: item.id, sessionId: 'session-x',
    payload: { tool: 'pwsh', ok: true, durationMs: 1200, summary: '{"command":"dir"}' },
  })
  appendEvent(db, {
    type: 'worker.tool', actor: 'worker', workitemId: item.id, sessionId: 'session-x',
    payload: { tool: 'write', ok: false, durationMs: 30, summary: '{"path":"C:/a.txt"}' },
  })
  finishWorkItem(db, item.id, { result: '办好了', artifacts: ['C:/out/a.txt'] })

  const t = buildWorkitemTrace(db, item.id)
  assert.equal(t.workitem.status, 'done')
  assert.equal(t.workitem.sessionId, 'session-x')
  assert.equal(t.summary.steps, 2)
  assert.equal(t.summary.toolOk, 1)
  assert.equal(t.summary.toolFail, 1)
  assert.equal(t.artifacts.length, 1)
  assert.equal(t.artifacts[0].path, 'C:/out/a.txt')
  assert.equal(t.summary.failure, null)
  assert.equal(t.steps[0].tool, 'pwsh')
  db.close()
})

test('trace：失败任务带失败原因', () => {
  const db = openDb()
  const item = running(db)
  failWorkItem(db, item.id, { reason: '目标文件不存在' })
  const t = buildWorkitemTrace(db, item.id)
  assert.equal(t.workitem.status, 'failed')
  assert.match(t.summary.failure, /目标文件不存在/)
  db.close()
})

test('trace：blocked 原因从最后一条状态事件取', () => {
  const db = openDb()
  const item = running(db)
  transition(db, item.id, 'blocked', { reason: 'worker 超时', payload: { needsHuman: true } })
  const t = buildWorkitemTrace(db, item.id)
  assert.equal(t.workitem.status, 'blocked')
  assert.match(t.summary.failure, /worker 超时/)
  db.close()
})

test('trace：不存在的任务返回 null', () => {
  const db = openDb()
  assert.equal(buildWorkitemTrace(db, 'wi_nope'), null)
  db.close()
})
