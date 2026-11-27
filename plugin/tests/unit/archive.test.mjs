import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyArchive, proposeBig, scanArchive } from '../../src/archive.js'

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

test('大文件提议：按大小挑出、能匹配规则的给出目标、匹配不上的 target=null', () => {
  const root = mkdtempSync(join(tmpdir(), 'archbig-'))
  const inbox = join(root, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const big = Buffer.alloc(2 * 1024 * 1024)
  writeFileSync(join(inbox, 'video.mp4'), big)
  writeFileSync(join(inbox, 'blob.weird'), big)
  writeFileSync(join(inbox, 'small.mp4'), 'x')
  const out = join(root, 'out')
  const r = proposeBig({
    dirs: [inbox],
    rules: [{ ext: ['.mp4'], target: join(out, '{ext}') }],
    minBytes: 1024 * 1024,
    limit: 10,
  })
  assert.equal(r.total, 2)
  const video = r.items.find((i) => i.name === 'video.mp4')
  assert.equal(video.target, join(out, 'mp4'))
  const weird = r.items.find((i) => i.name === 'blob.weird')
  assert.equal(weird.target, null)
  assert.equal(video.sizeHuman, '2.0 MB')
})

test('大文件提议：按年龄过滤（太新的不算）', () => {
  const root = mkdtempSync(join(tmpdir(), 'archbig2-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'new.iso'), Buffer.alloc(1024 * 1024))
  const fresh = proposeBig({ dirs: [root], minBytes: 512 * 1024, minAgeDays: 30 })
  assert.equal(fresh.total, 0)
  const any = proposeBig({ dirs: [root], minBytes: 512 * 1024, minAgeDays: 0 })
  assert.equal(any.total, 1)
})
