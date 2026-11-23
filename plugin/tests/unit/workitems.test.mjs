import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { readEvents } from '../../src/events.js'
import {
  cancelWorkItem, createWorkItem, finishWorkItem, getWorkItem, listWorkItems,
  rebuildProjection, summaryCounts, transition,
} from '../../src/workitems.js'

function fresh() {
  return openDb()
}

function make(db, extra = {}) {
  return createWorkItem(db, {
    channel: 'gui', peer: 'owner', msgId: `m_${Math.random().toString(36).slice(2)}`,
    kind: 'task', ...extra,
  })
}

test('createWorkItem：初始状态 intake，并写 item.created 事件', () => {
  const db = fresh()
  const { item, created } = make(db)
  assert.equal(created, true)
  assert.equal(item.status, 'intake')
  assert.equal(item.needsHuman, false)
  const evs = readEvents(db, { workitemId: item.id })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].type, 'item.created')
  assert.equal(summaryCounts(db).intake, 1)
  db.close()
})

test('createWorkItem：同一 msgId 幂等，不产生第二个任务', () => {
  const db = fresh()
  const a = createWorkItem(db, { channel: 'gui', peer: 'owner', msgId: 'same_1' })
  const b = createWorkItem(db, { channel: 'gui', peer: 'owner', msgId: 'same_1' })
  assert.equal(a.created, true)
  assert.equal(b.created, false)
  assert.equal(a.item.id, b.item.id)
  assert.equal(listWorkItems(db).length, 1)
  db.close()
})

test('合法链路：intake→triaged→queued→running→done（经 finish）', () => {
  const db = fresh()
  const { item } = make(db)
  transition(db, item.id, 'triaged', { reason: 'judge: 是任务' })
  transition(db, item.id, 'queued', { reason: 'route: default' })
  transition(db, item.id, 'running', { reason: 'dispatch worker' })
  const done = finishWorkItem(db, item.id, { result: '已把 A 整理成 B', artifacts: ['/out/b.md'] })
  assert.equal(done.status, 'done')
  assert.equal(done.result, '已把 A 整理成 B')

  const types = readEvents(db, { workitemId: item.id }).map((e) => e.type)
  assert.deepEqual(types, ['item.created', 'item.state', 'item.state', 'item.state', 'item.state', 'item.finished', 'item.metrics'])
  assert.equal(summaryCounts(db).done, 1)
  db.close()
})

test('非法转移：intake 直接到 running 被拒绝', () => {
  const db = fresh()
  const { item } = make(db)
  assert.throws(() => transition(db, item.id, 'running', { reason: '跳步' }), /非法状态转移/)
  db.close()
})

test('done 不能绕过 finish()', () => {
  const db = fresh()
  const { item } = make(db)
  transition(db, item.id, 'triaged', { reason: 'ok' })
  transition(db, item.id, 'queued', { reason: 'ok' })
  transition(db, item.id, 'running', { reason: 'ok' })
  assert.throws(() => transition(db, item.id, 'done', { reason: '直接宣布完成' }), /只能由 finish/)
  db.close()
})

test('转移必须带 reason', () => {
  const db = fresh()
  const { item } = make(db)
  assert.throws(() => transition(db, item.id, 'triaged', {}), /必须带 reason/)
  db.close()
})

test('running 可取消；取消后是终态', () => {
  const db = fresh()
  const { item } = make(db)
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r' })
  const cancelled = cancelWorkItem(db, item.id, { reason: '主人叫停' })
  assert.equal(cancelled.status, 'cancelled')
  assert.throws(() => transition(db, item.id, 'queued', { reason: '想复活' }), /非法状态转移/)
  db.close()
})

test('waiting_human：needs_human 置位，回来可回 queued', () => {
  const db = fresh()
  const { item } = make(db)
  transition(db, item.id, 'triaged', { reason: 'r' })
  const waiting = transition(db, item.id, 'waiting_human', { reason: '要问主人', payload: { needsHuman: true } })
  assert.equal(waiting.needsHuman, true)
  const back = transition(db, item.id, 'queued', { reason: '主人答了', payload: { needsHuman: false } })
  assert.equal(back.needsHuman, false)
  db.close()
})

test('rebuildProjection：从事件重建与在线投影完全一致', () => {
  const db = fresh()
  const a = make(db).item
  const b = make(db).item
  transition(db, a.id, 'triaged', { reason: 'r' })
  transition(db, a.id, 'queued', { reason: 'r' })
  transition(db, b.id, 'triaged', { reason: 'r' })
  transition(db, b.id, 'waiting_human', { reason: '问主人', payload: { needsHuman: true } })

  const before = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM workitems ORDER BY id').all()))
  const report = rebuildProjection(db)
  const after = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM workitems ORDER BY id').all()))

  assert.equal(report.created, 2)
  assert.deepEqual(after, before)
  db.close()
})

test('getWorkItem：不存在返回 null', () => {
  const db = fresh()
  assert.equal(getWorkItem(db, 'wi_nope'), null)
  db.close()
})

test('重建投影：metrics 不丢（item.metrics 事件）', () => {
  const db = fresh()
  const { item } = make(db)
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r', payload: { sessionId: 'session-x' } })
  finishWorkItem(db, item.id, { result: 'ok' })
  const before = getWorkItem(db, item.id)
  assert.ok(before.metrics, '完成后应有 metrics')
  assert.equal(before.sessionId, 'session-x')
  rebuildProjection(db)
  const after = getWorkItem(db, item.id)
  assert.deepEqual(after.metrics, before.metrics)
  assert.equal(after.sessionId, 'session-x')
  db.close()
})