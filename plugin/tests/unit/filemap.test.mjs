import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bigFiles, defaultRoots, dirMap, humanBytes, recentFiles } from '../../src/filemap.js'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'filemap-'))
  mkdirSync(join(root, 'docs'))
  mkdirSync(join(root, 'docs', 'deep'))
  mkdirSync(join(root, 'imgs'))
  writeFileSync(join(root, 'a.txt'), 'x'.repeat(100))
  writeFileSync(join(root, 'docs', 'b.txt'), 'y'.repeat(2000))
  writeFileSync(join(root, 'docs', 'deep', 'c.bin'), Buffer.alloc(3 * 1024 * 1024))
  writeFileSync(join(root, 'imgs', 'd.png'), Buffer.alloc(1024))
  return root
}

test('文件地图：按第一层目录汇总体积与文件数', () => {
  const root = sandbox()
  try {
    const [row] = dirMap([root], { maxDepth: 3 })
    assert.equal(row.files, 4)
    assert.equal(row.bytes, 100 + 2000 + 3 * 1024 * 1024 + 1024)
    const docs = row.children.find((c) => c.name === 'docs')
    assert.equal(docs.files, 2)
    assert.equal(docs.bytes, 2000 + 3 * 1024 * 1024)
    const imgs = row.children.find((c) => c.name === 'imgs')
    assert.equal(imgs.files, 1)
    // 占地最大的排前面
    assert.equal(row.children[0].name, 'docs')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('大文件：按阈值过滤并按大小排序', () => {
  const root = sandbox()
  try {
    const r = bigFiles([root], { minBytes: 1024 * 1024 })
    assert.equal(r.total, 1)
    assert.equal(r.files[0].path.endsWith('c.bin'), true)
    const none = bigFiles([root], { minBytes: 10 * 1024 * 1024 })
    assert.equal(none.total, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('最近改动：窗口外的不算', () => {
  const root = sandbox()
  try {
    const r = recentFiles([root], { sinceMs: 3600 * 1000 })
    assert.equal(r.total, 4)
    const old = recentFiles([root], { sinceMs: 1000, now: Date.now() + 60 * 60 * 1000 })
    assert.equal(old.total, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('路径与体积：默认根目录去重，人类可读体积', () => {
  const roots = defaultRoots({ workspaceRoot: '/w', searchDirs: ['/a', '/a', '/b'] })
  assert.equal(roots.length, 2)
  assert.ok(roots[0].endsWith('a'), roots[0])
  assert.ok(roots[1].endsWith('b'), roots[1])
  assert.deepEqual(defaultRoots({ workspaceRoot: '/w' }).length, 1)
  assert.equal(humanBytes(512), '512 B')
  assert.equal(humanBytes(2 * 1024), '2.0 KB')
  assert.equal(humanBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(humanBytes(3 * 1024 * 1024 * 1024), '3.00 GB')
})

test('文件地图：跳过依赖目录（node_modules 不计入）', () => {
  const root = sandbox()
  try {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'z'.repeat(5000))
    const [row] = dirMap([root], { maxDepth: 3 })
    assert.equal(row.files, 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
