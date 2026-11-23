import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { looksLikeFileTask, sniffFiles } from '../../src/filesniff.js'

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'sniff-'))
  mkdirSync(join(root, '记录表'), { recursive: true })
  writeFileSync(join(root, '记录表', '2026年项目进展情况清单.xlsx'), 'x')
  writeFileSync(join(root, '记录表', '2026年项目数据统计.docx'), 'x')
  writeFileSync(join(root, '记录表', '事项进展.xls'), 'x')
  writeFileSync(join(root, '噪音.txt'), 'x')
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'x', '记录表.xlsx'), 'x')
  return root
}

test('文件嗅探：按任务词的重合度找候选，跳过依赖目录', () => {
  const root = makeTree()
  const hits = sniffFiles({ dirs: [root], intent: '请提交项目和事项记录表材料', limit: 5, maxDepth: 3 })
  assert.ok(hits.length >= 2, '应至少命中 2 个文件：' + JSON.stringify(hits.map((h) => h.name)))
  assert.ok(hits.some((h) => h.name.includes('项目')), '应命中项目清单')
  assert.ok(!hits.some((h) => h.path.includes('node_modules')), '不应进入 node_modules')
  assert.ok(hits.every((h) => h.score > 0))
})

test('文件嗅探：无匹配返回空；limit 生效', () => {
  const root = makeTree()
  assert.deepEqual(sniffFiles({ dirs: [root], intent: '完全无关的天气查询', limit: 5 }), [])
  const all = sniffFiles({ dirs: [root], intent: '记录表 民生 项目 清单 统计 进展', limit: 2 })
  assert.ok(all.length <= 2)
})

test('文件类任务判定：创建文件不算；「文件在机器里有」算', () => {
  assert.equal(looksLikeFileTask('创建文件 prompt-check.txt，内容写 ok'), false)
  assert.equal(looksLikeFileTask('请提交本月以来的事项，文件在办公机器里有，允许上网找'), true)
  assert.equal(looksLikeFileTask('把记录表.xlsx 整理成表格'), true)
  assert.equal(looksLikeFileTask('帮我查一下明天天气'), false)
})