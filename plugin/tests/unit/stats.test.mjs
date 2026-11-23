import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { createWorkItem, finishWorkItem, getWorkItem, transition } from '../../src/workitems.js'
import { classifyTopic, TOPICS } from '../../src/topic.js'
import { distribution, suggestions, summarize } from '../../src/stats.js'

function task(db, { text, topic, done = false } = {}) {
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: text, topic: classifyTopic(text) })
  if (topic) db.prepare('UPDATE workitems SET topic = ? WHERE id = ?').run(topic, item.id)
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r' })
  if (done) finishWorkItem(db, item.id, { result: 'ok' })
  return item
}

test('classifyTopic：关键词归到稳定 topic', () => {
  assert.equal(classifyTopic('把这个文件复制到 D 盘'), 'file')
  assert.equal(classifyTopic('帮我查一下 React 的用法'), 'research')
  assert.equal(classifyTopic('修一下这个 bug，跑测试'), 'code')
  assert.equal(classifyTopic('写一份周报 docx'), 'doc')
  assert.equal(classifyTopic('你好啊'), 'chat')
  assert.equal(classifyTopic('随便做点啥'), 'other')
  assert.ok(TOPICS.includes(classifyTopic('')))
})

test('distribution：按 topic 汇总数量与占比', () => {
  const db = openDb()
  task(db, { text: '文件操作一', done: true })
  task(db, { text: '文件操作二', done: false })
  task(db, { text: '查一下资料', done: true })
  const dist = distribution(db, { days: 7 })
  assert.equal(dist.total, 3)
  const file = dist.topics.find((t) => t.topic === 'file')
  assert.equal(file.total, 2)
  assert.equal(file.done, 1)
  assert.ok(Math.abs(file.share - 0.667) < 0.01)
  const research = dist.topics.find((t) => t.topic === 'research')
  assert.equal(research.total, 1)
  db.close()
})

test('suggestions：占比与样本量达标才建议分工', () => {
  const db = openDb()
  for (let i = 0; i < 3; i += 1) task(db, { text: '文件操作 ' + i, done: true })
  task(db, { text: '查资料', done: true })
  const low = suggestions(db, { days: 7, minTasks: 10, minShare: 0.2 })
  assert.equal(low.suggestions.length, 0)
  const high = suggestions(db, { days: 7, minTasks: 2, minShare: 0.2 })
  assert.equal(high.suggestions.length, 1)
  assert.equal(high.suggestions[0].topic, 'file')
  db.close()
})

test('metrics：完成任务后写入耗时与一次成功标记', () => {
  const db = openDb()
  const a = task(db, { text: '文件操作', done: true })
  const w = getWorkItem(db, a.id)
  assert.equal(w.status, 'done')
  assert.ok(w.metrics)
  assert.equal(w.metrics.firstTrySuccess, true)
  assert.ok(w.metrics.durationMs >= 0)
  db.close()
})

test('summarize：空数据也有可读结论', () => {
  const db = openDb()
  const s = summarize(db, { days: 7 })
  assert.equal(s.total, 0)
  assert.match(s.message, /还没有任务数据/)
  db.close()
})
