import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { createWorkItem, failWorkItem, finishWorkItem, transition } from '../../src/workitems.js'

function toRunning(db, id) {
  transition(db, id, 'triaged', { reason: 't' })
  transition(db, id, 'queued', { reason: 'q' })
  transition(db, id, 'running', { reason: 'r' })
}
import { buildBrief, buildReview } from '../../src/briefing.js'

test('daily 简报：统计办成/卡住/产物/待决定', () => {
  const db = openDb()
  const a = createWorkItem(db, { ownerId: 'owner', channel: 'gui', peer: 'owner', intent: '写简报', topic: 'doc' }).item
  toRunning(db, a.id)
  finishWorkItem(db, a.id, { result: '已完成报告', artifacts: ['/w/报告.docx'] })
  const b = createWorkItem(db, { ownerId: 'owner', channel: 'gui', peer: 'owner', intent: '整理表格', topic: 'file' }).item
  toRunning(db, b.id)
  failWorkItem(db, b.id, { reason: '缺源文件' })

  const text = buildBrief(db, { ownerId: 'owner', kind: 'daily' })
  assert.match(text, /昨日简报/)
  assert.match(text, /写简报/)
  assert.match(text, /整理表格/)
  assert.match(text, /缺源文件/)
  assert.match(text, /报告\.docx/)
  assert.match(text, /待你决定/)
})

test('weekly 简报与复盘：标题与统计正确', () => {
  const db = openDb()
  for (let i = 0; i < 3; i += 1) {
    const w = createWorkItem(db, { ownerId: 'owner', channel: 'gui', peer: 'owner', intent: '任务' + i, topic: 'doc' }).item
    toRunning(db, w.id)
    finishWorkItem(db, w.id, { result: 'ok' })
  }
  const weekly = buildBrief(db, { ownerId: 'owner', kind: 'weekly' })
  assert.match(weekly, /本周简报/)

  const review = buildReview(db, { ownerId: 'owner', days: 7 })
  assert.match(review, /任务复盘/)
  assert.match(review, /任务总数：3/)
  assert.match(review, /done=3/)
})
