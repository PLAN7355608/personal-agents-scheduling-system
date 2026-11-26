import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractHumanGuidance } from '../../src/session-audit.js'

function userMsg(text, time = Date.now()) {
  return { type: 'user/message', time, data: { content: [{ type: 'text', text }] } }
}

test('旁路审计：只挑人给的指导，排除任务提示词与系统提醒', () => {
  const now = Date.now()
  const events = [
    userMsg('<system-reminder>session info</system-reminder>', now),
    userMsg('【任务】把这个文件改一下', now),
    userMsg('【主人补充指令】第二段太啰嗦，压到 200 字', now),
    userMsg('这段批注：把“脱薄”那词改成“提升”', now),
    userMsg('   ', now),
    { type: 'assistant/message', time: now, data: { content: [{ type: 'text', text: '好' }] } },
  ]
  const out = extractHumanGuidance(events)
  assert.equal(out.length, 1)
  assert.ok(out[0].preview.includes('批注'))
})

test('旁路审计：按 since 过滤旧消息', () => {
  const old = Date.now() - 86400000
  const now = Date.now()
  const events = [userMsg('旧的批注', old), userMsg('新的批注', now)]
  assert.equal(extractHumanGuidance(events, { since: now - 1000 }).length, 1)
})

test('旁路审计：同一内容 hash 稳定', () => {
  const a = extractHumanGuidance([userMsg('同一句话')])[0]
  const b = extractHumanGuidance([userMsg('同一句话')])[0]
  assert.equal(a.hash, b.hash)
})

test('旁路审计：DSH 每轮注入的环境上下文不算人工指导', () => {
  const now = Date.now()
  const events = [
    userMsg('Clock: 2026-11-24 20:24 Tue · Asia/Hong_Kong (UTC+08:00)'),
    userMsg('Time sampled while preparing turn 1, step 1: 2026-11-24T20:24:26+08:00'),
    userMsg('Current working directory: "E:\\ws"'),
    userMsg('这段批注：标题改短'),
  ]
  const out = extractHumanGuidance(events)
  assert.equal(out.length, 1)
  assert.ok(out[0].preview.includes('标题改短'))
})

test('旁路审计：带附件的消息也算人工指导', () => {
  const ev = {
    type: 'user/message',
    time: Date.now(),
    data: {
      content: [
        { type: 'text', text: '按批注改好的版本在这' },
        { type: 'file', name: '示例2026年项目说明文档(3).docx', path: '/root/.dsh/attachments/x.docx' },
      ],
    },
  }
  const out = extractHumanGuidance([ev])
  assert.equal(out.length, 1)
  assert.ok(out[0].preview.includes('docx'))
})

test('旁路审计：运行时的审批策略变更通知不算人工指导', () => {
  const now = Date.now()
  const events = [
    userMsg('The user changed the approval policy from "never ask the user for approval" to "ask the user for approval".', now),
    userMsg('1.两条手机号都记录上 2.已退休 不用记录', now),
  ]
  const out = extractHumanGuidance(events)
  assert.equal(out.length, 1)
  assert.ok(out[0].preview.includes('手机号'))
})
