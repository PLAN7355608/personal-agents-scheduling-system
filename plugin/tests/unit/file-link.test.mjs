import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { createWorkItem, finishWorkItem, getWorkItem, transition } from '../../src/workitems.js'
import { inbound } from '../../src/gateway.js'
import { enqueue, listPending } from '../../src/outbox.js'
import { buildWorkitemTrace } from '../../src/trace.js'

test('输入文件：createWorkItem 落 inputs，投影可读', () => {
  const db = openDb()
  const { item } = createWorkItem(db, {
    channel: 'gui', peer: 'owner', intent: '处理附件',
    inputs: [{ path: 'C:/in/a.txt', name: 'a.txt' }],
  })
  const got = getWorkItem(db, item.id)
  assert.deepEqual(got.inputs, [{ path: 'C:/in/a.txt', name: 'a.txt' }])
  db.close()
})

test('入站附件：gateway 把 attachments 归一化为 inputs', () => {
  const db = openDb()
  const r = inbound(db, {
    channel: 'mock', peer: 'tester', msgId: 'att-1',
    text: '读一下附件',
    attachments: [
      { path: 'C:/in/x.txt', name: 'x.txt', size: 12, kind: 'file' },
      'C:/in/y.png',
      { name: 'no-path' },
    ],
  })
  assert.equal(r.accepted, true)
  const item = getWorkItem(db, r.workitemId)
  assert.equal(item.inputs.length, 2)
  assert.equal(item.inputs[0].path, 'C:/in/x.txt')
  assert.equal(item.inputs[1].path, 'C:/in/y.png')
  db.close()
})

test('出站文件：outbox 保存 files 并被 adapter 读到', () => {
  const db = openDb()
  enqueue(db, { channel: 'mock', peer: 'tester', content: '给你文件', files: ['C:/out/result.md'] })
  const items = listPending(db, { channel: 'mock' })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].files, ['C:/out/result.md'])
  db.close()
})

test('产物：finish 落 artifacts 表，trace 与 wait 都能取', () => {
  const db = openDb()
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '产出文件' })
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  transition(db, item.id, 'running', { reason: 'r' })
  finishWorkItem(db, item.id, { result: '做好了', artifacts: ['C:/out/result.md'] })
  const trace = buildWorkitemTrace(db, item.id)
  assert.equal(trace.artifacts.length, 1)
  assert.equal(trace.artifacts[0].path, 'C:/out/result.md')
  const row = db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE workitem_id = ?').get(item.id)
  assert.equal(Number(row.n), 1)
  db.close()
})

test('worker prompt：输入文件与语气都写进指令', async () => {
  const { buildWorkerPrompt } = await import('../../src/dispatch.js')
  const item = { id: 'wi_1', intent: '处理附件' }
  const cfg = { workspaceRoot: 'E:/ws' }
  const prompt = buildWorkerPrompt(item, cfg, ['偏好X'], [], '称呼主人：主人', [{ path: 'C:/in/a.txt', name: 'a.txt' }])
  assert.match(prompt, /输入文件/)
  assert.match(prompt, /C:\/in\/a\.txt/)
})