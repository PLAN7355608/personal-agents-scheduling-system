import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyArchive, scanArchive } from '../../src/archive.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'arch-'))
  const inbox = join(root, 'inbox')
  const out = join(root, 'out')
  mkdirSync(inbox, { recursive: true })
  const old = new Date(Date.now() - 5 * 86400000)
  writeFileSync(join(inbox, 'a.pdf'), 'x')
  utimesSync(join(inbox, 'a.pdf'), old, old)
  writeFileSync(join(inbox, 'b.docx'), 'x')
  utimesSync(join(inbox, 'b.docx'), old, old)
  writeFileSync(join(inbox, 'new.pdf'), 'x') // 新的，不该被扫到
  writeFileSync(join(inbox, 'skip.txt'), 'x')
  utimesSync(join(inbox, 'skip.txt'), old, old)
  return { root, inbox, out: join(out, '{ext}') }
}

test('归档扫描：按扩展名/年龄筛候选', () => {
  const { inbox, out } = setup()
  const found = scanArchive({
    watchDirs: [inbox],
    rules: [{ ext: ['.pdf', '.docx'], target: out }],
    minAgeHours: 24,
  })
  const names = found.map((f) => f.name).sort()
  assert.deepEqual(names, ['a.pdf', 'b.docx'])
  assert.equal(found[0].target.includes('pdf'), true)
})

test('归档执行：移动到目标目录（{ext} 展开）', () => {
  const { inbox, out } = setup()
  const found = scanArchive({ watchDirs: [inbox], rules: [{ ext: ['.pdf'], target: out }], minAgeHours: 24 })
  const r = applyArchive(found)
  assert.equal(r.moved.length, 1)
  assert.equal(r.failed.length, 0)
  assert.deepEqual(readdirSync(join(inbox)).sort(), ['b.docx', 'new.pdf', 'skip.txt'])
  assert.deepEqual(readdirSync(join(inbox, '..', 'out', 'pdf')), ['a.pdf'])
})
