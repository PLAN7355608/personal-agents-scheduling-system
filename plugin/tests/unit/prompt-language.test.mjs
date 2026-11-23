import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerPrompt } from '../../src/dispatch.js'
import { composeReply } from '../../src/language.js'

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

test('派单 v2：只含干活需要的信息，不含画像/口吻', () => {
  const prompt = buildWorkerPrompt(
    { id: 'wi_1', intent: '把文件整理成表格', workspace: '/root/workbench', projectRoot: '/root/workbench', scope: '2026/reports' },
    { workspaceRoot: '/root/workbench', workerPromptMaxChars: 700, workerPromptMaxFacts: 2 },
    ['主人喜欢先结论', '这个项目用中文命名'],
    [],
    '称呼主人：主人',
    [{ path: '/root/workbench/a.docx' }],
    [{ intent: '上次整理', result: '生成 b.xlsx', artifacts: ['/root/workbench/b.xlsx'] }],
  )
  assert.match(prompt, /【任务】/)
  assert.match(prompt, /【工作区】\/root\/workbench/)
  assert.match(prompt, /【项目】\/root\/workbench \/ 2026\/reports/)
  assert.match(prompt, /【输入文件】/)
  assert.match(prompt, /【本线上下文】/)
  assert.match(prompt, /【相关背景】/)
  assert.match(prompt, /【完成要求】/)
  assert.match(prompt, /result 只写结论和路径/)
  assert.doesNotMatch(prompt, /画像|称呼主人/)
  assert.ok(prompt.length <= 800, '提示词过长：' + prompt.length)
})

test('派单 v2：背景最多 2 条', () => {
  const facts = ['a', 'b', 'c', 'd']
  const prompt = buildWorkerPrompt(
    { id: 'wi_2', intent: '整理文件', workspace: '/w' },
    { workspaceRoot: '/w', workerPromptMaxChars: 700, workerPromptMaxFacts: 2 },
    facts,
  )
  assert.ok(prompt.includes('- a'))
  assert.ok(prompt.includes('- b'))
  assert.ok(!prompt.includes('- c'))
})

test('派单 v3：长任务原文完整保留，完成要求必须保留', () => {
  const longTail = '【任务结尾标记XYZ】'
  const prompt = buildWorkerPrompt(
    { id: 'wi_3', intent: '很长的任务描述'.repeat(300) + longTail, workspace: '/w' },
    { workspaceRoot: '/w', workerPromptMaxChars: 500, workerPromptMaxFacts: 2 },
    [],
  )
  assert.ok(prompt.includes(longTail), '任务结尾必须保留，不能被截断')
  assert.ok(prompt.length > 500, '任务本身超预算时应完整下发而不是硬截')
  assert.doesNotMatch(prompt, /（截断）/)
  assert.match(prompt, /【完成要求】/)
  assert.match(prompt, /secretary_work_finish/)
})

test('派单 v3：任务原文过长超过硬上限时直接报错', () => {
  assert.throws(
    () => buildWorkerPrompt({ id: 'wi_huge', intent: '超长'.repeat(20000), workspace: '/w' }, { workspaceRoot: '/w' }),
    /任务文本过长/,
  )
})

test('语言服务：关闭/无模型直接回退原文', async () => {
  const raw = '已创建文件 a.txt'
  const off = await composeReply({ llm: fakeLlm('主人，办好了'), cfg: { language: { enabled: false } }, item: {}, raw })
  assert.equal(off.text, raw)
  assert.equal(off.ok, false)

  const noLlm = await composeReply({ llm: null, cfg: { language: { enabled: true } }, item: {}, raw })
  assert.equal(noLlm.text, raw)
  assert.equal(noLlm.reason, 'no-llm')
})

test('语言服务：正常改写 / 输出过长或调用失败都回退', async () => {
  const raw = '已创建文件 /root/workbench/a.xlsx'
  const ok = await composeReply({
    llm: fakeLlm('主人，表格做好了：/root/workbench/a.xlsx'),
    cfg: { language: { enabled: true, provider: 'p', model: 'm' } },
    personaText: '称呼主人：主人',
    item: { intent: '整理表格' },
    raw,
  })
  assert.equal(ok.ok, true)
  assert.match(ok.text, /主人/)
  assert.equal(ok.model, 'p/m')

  const tooLong = await composeReply({
    llm: fakeLlm('长'.repeat(1000)),
    cfg: { language: { enabled: true } },
    raw,
  })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.text, raw)

  const failed = await composeReply({
    llm: fakeLlm('', { fail: true }),
    cfg: { language: { enabled: true } },
    raw,
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.text, raw)
})

test('派单 v3：文件类任务带本地搜索指引（含可搜目录）', () => {
  const prompt = buildWorkerPrompt(
    { id: 'wi_f', intent: '把记录表.xlsx 里的数据整理出来', workspace: '/root/workbench', topic: 'file' },
    { workspaceRoot: '/root/workbench', workerPromptMaxChars: 900, searchDirs: ['/root/workbench', '/root/example'] },
  )
  assert.match(prompt, /【本地文件】/)
  assert.match(prompt, /\/root\/example/)
  assert.match(prompt, /本地未找到/)
})

test('派单 v3：写作类任务带事实纪律（来源/待核/不许改时点）', () => {
  const prompt = buildWorkerPrompt(
    { id: 'wi_w', intent: '请提交本月以来的事项报告', workspace: '/root/workbench', topic: 'doc' },
    { workspaceRoot: '/root/workbench', workerPromptMaxChars: 900 },
  )
  assert.match(prompt, /【事实纪律】/)
  assert.match(prompt, /待核/)
  assert.match(prompt, /不得把旧报道时点/)
})
test('派单 v3：纯创建文件的任务不触发"本地文件"指引', () => {
  const prompt = buildWorkerPrompt(
    { id: 'wi_c', intent: '创建文件 prompt-check.txt，内容写 ok', workspace: '/root/workbench', topic: 'file' },
    { workspaceRoot: '/root/workbench', workerPromptMaxChars: 900 },
  )
  assert.doesNotMatch(prompt, /【本地文件】/)
  assert.match(prompt, /【完成要求】/)
})