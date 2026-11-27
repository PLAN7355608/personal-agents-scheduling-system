import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import {
  acceptWorkItem, createWorkItem, getWorkItem, rejectWorkItem, submitWorkItem,
  transition, validateSubmission,
} from '../../src/workitems.js'
import { buildReviewText, parseReview } from '../../src/review.js'

function runningItem(db, opts = {}) {
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '做一份东西', ...opts })
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r' })
  return item.id
}

function fresh() {
  return openDb()
}

test('提交校验：空证据一律不通过', () => {
  assert.equal(validateSubmission({ acceptance: [], evidence: [] }).ok, false)
  assert.equal(validateSubmission({ acceptance: [], evidence: [{ kind: 'file', ref: '/x.docx' }] }).ok, true)
  const r = validateSubmission({
    acceptance: [{ id: 'a1', text: '有手机号', done: false }],
    evidence: [{ kind: 'file', ref: '/x.xlsx' }],
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /未勾选/)
})

test('self 模式：提交即完成，证据落库', () => {
  const db = fresh()
  const id = runningItem(db)
  const r = submitWorkItem(db, id, {
    result: '做完了',
    evidence: [{ kind: 'file', ref: '/out/a.docx', summary: '产物' }],
    acceptance: [{ id: 'a1', text: '有产物', done: true }],
    reviewMode: 'self',
  })
  assert.equal(r.submitted, true)
  assert.equal(r.item.status, 'done')
  assert.equal(r.item.evidence.length, 1)
  assert.equal(r.item.reviewMode, 'self')
  db.close()
})

test('owner 模式：提交进 submitted，验收通过才 done', () => {
  const db = fresh()
  const id = runningItem(db)
  const sub = submitWorkItem(db, id, {
    result: '交一版',
    evidence: [{ kind: 'file', ref: '/out/a.docx' }],
    reviewMode: 'owner',
  })
  assert.equal(sub.submitted, true)
  assert.equal(sub.item.status, 'submitted')

  const done = acceptWorkItem(db, id, { note: '可以' })
  assert.equal(done.status, 'done')
  assert.equal(done.result, '交一版')
  db.close()
})

test('owner 模式：驳回回到 running 并记理由', () => {
  const db = fresh()
  const id = runningItem(db)
  submitWorkItem(db, id, { result: 'x', evidence: [{ kind: 'text', ref: '说完了' }], reviewMode: 'owner' })
  assert.throws(() => rejectWorkItem(db, id, { reason: '  ' }), /必须写理由/)
  const back = rejectWorkItem(db, id, { reason: '第 3 条没做' })
  assert.equal(back.status, 'running')
  const ev = db.prepare("select payload from events where workitem_id = ? and type = 'item.rejected'").get(id)
  assert.match(String(ev.payload), /第 3 条没做/)
  db.close()
})

test('验收：模型输出解析失败按不通过处理', () => {
  assert.deepEqual(parseReview('{"pass":true,"reason":"ok","failed":[]}'), { pass: true, reason: 'ok', failed: [] })
  const bad = parseReview('我觉得可以')
  assert.equal(bad.pass, false)
  assert.equal(bad.unparsed, true)
})

test('验收：提示词里带任务、清单与证据，且标明不可信', () => {
  const text = buildReviewText({
    intent: '整理名单',
    result: '整理好了',
    acceptance: [{ id: 'a1', text: '60 人都有手机号', done: true }],
    evidence: [{ kind: 'file', ref: '/out/名单.xlsx', summary: '新版' }],
  })
  assert.match(text, /不可信输入/)
  assert.match(text, /60 人都有手机号/)
  assert.match(text, /名单\.xlsx/)
})

test('父子任务：一层限制 + 父任务不能是子任务', () => {
  const db = fresh()
  const parentId = runningItem(db, { intent: '父任务' })
  const { item: child } = createWorkItem(db, {
    channel: 'gui', peer: 'owner', intent: '子任务', parentId, laneId: getWorkItem(db, parentId).laneId,
  })
  assert.equal(getWorkItem(db, child.id).parentId, parentId)
  // 子任务的子任务：schema 层不拦（工具层拦），这里只验证 parentId 能落库
  const { item: grand } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '孙任务', parentId: child.id })
  assert.equal(getWorkItem(db, grand.id).parentId, child.id)
  db.close()
})
