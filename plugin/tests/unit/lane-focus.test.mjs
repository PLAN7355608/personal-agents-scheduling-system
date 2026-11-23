import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { focusFromText, laneKeyFor } from '../../src/lanes.js'

test('focusFromText：从任务文本提取第一个绝对路径的父目录', () => {
  assert.equal(focusFromText('继续改 /root/example/示例报告.docx，按批注'), '/root/example')
  assert.equal(focusFromText('改 E:\\ws\\pass\\plugin\\index.js 的 bug'), 'E:/ws/pass/plugin')
  assert.equal(focusFromText('检查字体映射，不改文档'), null)
})

test('laneKey：focus 会拆出独立工作流，unique 会强制新线', () => {
  const base = '/root/workbench'
  assert.equal(
    laneKeyFor({ sessionId: 's1', workspace: base, baseWorkspace: base }),
    'session:s1',
  )
  assert.equal(
    laneKeyFor({ sessionId: 's1', workspace: base, baseWorkspace: base, focus: '/root/example' }),
    'session:s1#/root/example',
  )
  assert.equal(
    laneKeyFor({ sessionId: 's1', workspace: base, baseWorkspace: base, focus: '/root/example', unique: 'abc' }),
    'session:s1#/root/example~abc',
  )
})
