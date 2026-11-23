import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { forget, injectionFacts, recall, remember, stats } from '../../src/memory.js'

test('remember / recall：写入后能按关键词查到', () => {
  const db = openDb()
  const r = remember(db, { text: '文件一般放 D:\\工作 目录', tags: '路径 偏好' })
  assert.ok(r.id.startsWith('mem_'))
  const hits = recall(db, { query: '工作' })
  assert.equal(hits.length, 1)
  assert.match(hits[0].text, /D:\\工作/)
  assert.equal(stats(db).active, 1)
  db.close()
})

test('同 key 覆盖：旧记忆被 supersede，不再出现', () => {
  const db = openDb()
  const a = remember(db, { type: 'profile', key: '称呼', text: '叫主人' })
  const b = remember(db, { type: 'profile', key: '称呼', text: '叫哥' })
  assert.equal(b.superseded, a.id)
  const rows = recall(db, { query: '' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, '叫哥')
  db.close()
})

test('forget：忘掉后查不到，但数据还在（软删）', () => {
  const db = openDb()
  remember(db, { text: '临时记忆：测试忘掉' })
  const r = forget(db, { query: '忘掉' })
  assert.equal(r.forgotten, 1)
  assert.equal(recall(db, { query: '忘掉' }).length, 0)
  const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get()
  assert.equal(Number(total.n), 1)
  db.close()
})

test('injectionFacts：画像在前，事实在后，受字数上限约束', () => {
  const db = openDb()
  remember(db, { type: 'profile', key: '称呼', text: '叫哥' })
  remember(db, { text: '事实一：文件放 D 盘' })
  remember(db, { text: '事实二：不要碰支付' })
  const lines = injectionFacts(db, { limit: 5, maxChars: 1200 })
  assert.ok(lines.length >= 3)
  assert.match(lines[0], /^画像：/)
  assert.ok(lines.some((l) => l.includes('不要碰支付')))
  const tiny = injectionFacts(db, { limit: 5, maxChars: 12 })
  assert.ok(tiny.join('').length <= 24)
  db.close()
})

test('记忆操作写事件：remember / forget 可审计', async () => {
  const { readEvents } = await import('../../src/events.js')
  const db = openDb()
  const r = remember(db, { type: 'fact', text: '事件测试：记住这条' })
  const ev1 = readEvents(db, { type: 'memory.remember' })
  assert.equal(ev1.length, 1)
  assert.equal(ev1[0].payload.id, r.id)

  const f = forget(db, { query: '事件测试' })
  assert.equal(f.forgotten, 1)
  const ev2 = readEvents(db, { type: 'memory.forget' })
  assert.equal(ev2.length, 1)
  const payload = ev2[0].payload
  assert.equal(payload.query, '事件测试')
  assert.deepEqual(payload.ids, [r.id])
  db.close()
})