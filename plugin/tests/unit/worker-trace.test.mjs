import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentSessionId, buildWorkerToolEvent, redactText, resultOk, summarizeArgs, toolNameOf,
} from '../../src/worker-trace.js'

test('agentSessionId：从多种形态里取会话 id', () => {
  assert.equal(agentSessionId({ agent: { sessionId: 'session-1' } }), 'session-1')
  assert.equal(agentSessionId({ agent: { session: { id: 'session-2' } } }), 'session-2')
  assert.equal(agentSessionId({ sessionId: 'session-3' }), 'session-3')
  assert.equal(agentSessionId({}), '')
  assert.equal(agentSessionId(null), '')
})

test('toolNameOf：拿工具名', () => {
  assert.equal(toolNameOf({ tool: { name: 'write' } }), 'write')
  assert.equal(toolNameOf({ definition: { name: 'read' } }), 'read')
  assert.equal(toolNameOf({}), 'unknown')
})

test('redactText：token/密码/Bearer 被抹掉', () => {
  assert.match(redactText('token=abc123'), /token=\*\*\*/)
  assert.match(redactText('password: "hunter2"'), /password: "\*\*\*"/)
  assert.match(redactText('Authorization: Bearer eyJhbGci'), /Bearer \*\*\*/)
  assert.equal(redactText('C:/work/a.txt'), 'C:/work/a.txt')
  assert.match(redactText('密码是 abc123'), /密码是 \*\*\*/)
  assert.match(redactText('密钥：xyz'), /密钥：\*\*\*/)
})

test('summarizeArgs：正文只记长度+哈希，不落原文', () => {
  const args = { text: 'x'.repeat(1000) }
  const s = summarizeArgs(args)
  assert.match(s, /\[内容 len=1000 sha=[0-9a-f]{8}\]/)
  assert.doesNotMatch(s, /xxxx/)
  assert.equal(summarizeArgs(null), '')
})

test('resultOk：错误形态判失败', () => {
  assert.equal(resultOk({ isError: true }), false)
  assert.equal(resultOk({ error: 'boom' }), false)
  assert.equal(resultOk({ ok: false }), false)
  assert.equal(resultOk({ content: [] }), true)
  assert.equal(resultOk(null), true)
})

test('buildWorkerToolEvent：无会话返回 null；有会话给出结构化 payload', () => {
  assert.equal(buildWorkerToolEvent({ exec: { tool: { name: 'write' } } }), null)
  const payload = buildWorkerToolEvent({
    exec: { agent: { sessionId: 'session-9' }, tool: { name: 'write' }, args: { path: 'C:/a.txt', token: 'secret' } },
    result: { ok: true },
    durationMs: 123,
  })
  assert.equal(payload.sessionId, 'session-9')
  assert.equal(payload.tool, 'write')
  assert.equal(payload.ok, true)
  assert.equal(payload.durationMs, 123)
  assert.match(payload.summary, /C:\/a\.txt/)
  assert.doesNotMatch(payload.summary, /secret/)
})
