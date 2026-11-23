import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIntent, intentSimilar, pickDuplicate } from '../../src/dedupe.js'

test('normalizeIntent 忽略空格标点大小写', () => {
  assert.equal(normalizeIntent('修复 GitHub! 连通性'), normalizeIntent('修复github连通性'))
})

test('intentSimilar 判断同一件事', () => {
  const a = '本机访问 GitHub 不通，请诊断并修复，要求：先测连通性，再查本机因素，定位根因后立刻修。'
  const b = '本机访问 GitHub 不通，请诊断并修复。先测连通性，再查本机因素，定位根因后立刻修。'
  assert.equal(intentSimilar(a, b), true)
  assert.equal(intentSimilar('写一个字幕', '生成视频提示词'), false)
  assert.equal(intentSimilar('写文件', '写文件'), true)
})

test('pickDuplicate 返回第一条相似任务', () => {
  const items = [
    { id: 'wi_a', intent: '写项目介绍视频的字幕' },
    { id: 'wi_b', intent: '修复 GitHub 访问' },
  ]
  assert.equal(pickDuplicate(items, '修复 GitHub 访问').id, 'wi_b')
  assert.equal(pickDuplicate(items, '完全不相干的事'), null)
})
