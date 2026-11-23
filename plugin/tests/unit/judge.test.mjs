import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { judgeToolDecision, parseJudge } from '../../src/judge.js'
import { createToolRequest, escalateToolRequest, getToolRequest } from '../../src/tool-requests.js'

function fakeLlm(text, { fail = false } = {}) {
  return {
    stream() {
      return (async function* () {
        if (fail) throw new Error('model down')
        yield { type: 'text-delta', index: 0, text }
      })()
    },
  }
}

test('裁判输出解析：allow / deny / 非法都兜底 escalate', () => {
  assert.deepEqual(parseJudge('{"decision":"allow","reason":"相关","scope":"once"}').decision, 'allow')
  assert.equal(parseJudge('{"decision":"deny","reason":"越权"}').decision, 'deny')
  assert.equal(parseJudge('{"decision":"weird"}').decision, 'escalate')
  assert.equal(parseJudge('不是 JSON').decision, 'escalate')
  assert.equal(parseJudge('```json\n{"decision":"allow","reason":"x"}\n```').decision, 'allow')
})

test('裁判调用：模型返回 allow；模型挂了 → escalate（不擅自放行）', async () => {
  const cfg = { judge: { provider: 'p', model: 'm', timeoutMs: 3000 } }
  const ok = await judgeToolDecision({ llm: fakeLlm('{"decision":"allow","reason":"正常干活","scope":"once"}'), cfg, request: { tool: 'printer_print', reason: '打印文件' }, taskText: '打印试卷' })
  assert.equal(ok.decision, 'allow')
  assert.equal(ok.scope, 'once')
  assert.equal(ok.model, 'p/m')

  const down = await judgeToolDecision({ llm: fakeLlm('', { fail: true }), cfg, request: { tool: 'x', reason: 'y' } })
  assert.equal(down.decision, 'escalate')

  const noLlm = await judgeToolDecision({ llm: null, cfg, request: { tool: 'x' } })
  assert.equal(noLlm.decision, 'escalate')
})

test('escalate：pending → escalated，之后还能被主人决定', () => {
  const db = openDb()
  const req = createToolRequest(db, { tool: 'ext_tool_a', reason: '拿不准' })
  const esc = escalateToolRequest(db, req.id)
  assert.equal(esc.status, 'escalated')
  assert.equal(getToolRequest(db, req.id).decidedBy, 'judge')
  db.close()
})
