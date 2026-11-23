import test from 'node:test'
import assert from 'node:assert/strict'
import { parseModelRef, resolveWorkerModel } from '../../src/dispatch.js'

test('工人模型：没配置就跟随 DSH 默认（返回 null）', () => {
  assert.equal(resolveWorkerModel({}, { topic: 'doc' }), null)
  assert.equal(resolveWorkerModel({ workerModel: { provider: '', model: '' } }, {}), null)
})

test('工人模型：全局配置生效，带 reasoningEffort', () => {
  const got = resolveWorkerModel(
    { workerModel: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' } },
    { topic: 'file' },
  )
  assert.deepEqual(got, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' })
})

test('工人模型：按 topic 覆盖优先，topic 未配置时回落全局', () => {
  const cfg = {
    workerModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    workerModelByTopic: { research: { provider: 'deepseek-account', model: 'deepseek-v4' } },
  }
  assert.equal(resolveWorkerModel(cfg, { topic: 'research' }).model, 'deepseek-v4')
  assert.equal(resolveWorkerModel(cfg, { topic: 'doc' }).model, 'deepseek-flash')
  assert.equal(resolveWorkerModel(cfg, {}).model, 'deepseek-flash')
})

test('工人模型：配置不完整视作未配置', () => {
  assert.equal(resolveWorkerModel({ workerModel: { provider: 'x' } }, {}), null)
  assert.equal(resolveWorkerModel({ workerModelByTopic: { doc: { model: 'm' } } }, { topic: 'doc' }), null)
})

test('模型引用：provider/model 解析与格式校验', () => {
  assert.deepEqual(parseModelRef('zai/glm-5.3'), { provider: 'zai', model: 'glm-5.3' })
  assert.deepEqual(parseModelRef('moonshotai-cn/kimi-k3'), { provider: 'moonshotai-cn', model: 'kimi-k3' })
  assert.equal(parseModelRef('glm-5.3'), null)
  assert.equal(parseModelRef('zai/'), null)
  assert.equal(parseModelRef('/glm-5.3'), null)
  assert.equal(parseModelRef(''), null)
})

test('工人模型：任务显式指定优先于 topic / 全局', () => {
  const cfg = {
    workerModel: { provider: 'deepseek-account', model: 'deepseek-flash' },
    workerModelByTopic: { chat: { provider: 'zai', model: 'glm-5.3' } },
  }
  const got = resolveWorkerModel(cfg, { topic: 'chat', model: 'moonshotai-cn/kimi-k3' })
  assert.deepEqual(got, { provider: 'moonshotai-cn', model: 'kimi-k3' })
  const fallback = resolveWorkerModel(cfg, { topic: 'chat' })
  assert.deepEqual(fallback, { provider: 'zai', model: 'glm-5.3' })
  const bad = resolveWorkerModel(cfg, { topic: 'chat', model: 'not-a-ref' })
  assert.deepEqual(bad, { provider: 'zai', model: 'glm-5.3' })
})