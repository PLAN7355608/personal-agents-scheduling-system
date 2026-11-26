import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/db.js'
import { addRevision, countRevisions, latestRevision, listRevisions, scanRecentFiles } from '../../src/revisions.js'

test('续作修订：按版本递增、可查最新', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO workitems (id, owner_id, source_channel, source_peer, kind, status, intent, created_at, updated_at) VALUES ('wi_r1','owner','gui','owner','task','done','x',1,1)").run()
  const a = addRevision(db, { workitemId: 'wi_r1', path: '/ws/a.docx', source: 'observed' })
  const b = addRevision(db, { workitemId: 'wi_r1', path: '/ws/b.docx', source: 'observed' })
  assert.equal(a.revision, 1)
  assert.equal(b.revision, 2)
  assert.equal(countRevisions(db, 'wi_r1'), 2)
  assert.equal(latestRevision(db, 'wi_r1').path, '/ws/b.docx')
  assert.equal(listRevisions(db, 'wi_r1').length, 2)
})

test('续作修订：同一路径不比上次新则跳过', () => {
  const db = openDb(':memory:')
  db.prepare("INSERT INTO workitems (id, owner_id, source_channel, source_peer, kind, status, intent, created_at, updated_at) VALUES ('wi_r2','owner','gui','owner','task','done','x',1,1)").run()
  addRevision(db, { workitemId: 'wi_r2', path: '/ws/a.docx', mtime: 1000, now: 2000 })
  const again = addRevision(db, { workitemId: 'wi_r2', path: '/ws/a.docx', mtime: 900, now: 3000 })
  assert.equal(again, null)
  assert.equal(countRevisions(db, 'wi_r2'), 1)
})

test('scanRecentFiles 找出 since 之后改过的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-scan-'))
  writeFileSync(join(dir, 'old.txt'), 'x')
  writeFileSync(join(dir, 'new.txt'), 'y')
  const now = Date.now()
  utimesSync(join(dir, 'old.txt'), new Date(now - 3600_000), new Date(now - 3600_000))
  utimesSync(join(dir, 'new.txt'), new Date(now), new Date(now))
  const files = scanRecentFiles(dir, now - 60_000, { limit: 10 })
  assert.ok(files.some((f) => f.path.endsWith('new.txt')))
  assert.ok(!files.some((f) => f.path.endsWith('old.txt')))
})

test('scanRecentFiles 文档优先于图片', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-prio-'))
  const now = Date.now()
  writeFileSync(join(dir, 'shot.png'), 'x')
  writeFileSync(join(dir, 'report.docx'), 'x')
  utimesSync(join(dir, 'shot.png'), new Date(now), new Date(now))
  utimesSync(join(dir, 'report.docx'), new Date(now - 1000), new Date(now - 1000))
  const files = scanRecentFiles(dir, now - 60_000, { limit: 10 })
  assert.ok(files[0].path.endsWith('report.docx'))
})