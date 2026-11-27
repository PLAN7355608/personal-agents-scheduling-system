import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { acquireLease, expireLeases, listLeases, normalizeLeasePath, releaseItemLeases, releaseLease } from '../../src/leases.js'

const T0 = Date.parse('2026-11-27T10:00:00Z')

test('租约：同路径同任务可续约，不同任务被拦', () => {
  const db = openDb()
  const a = acquireLease(db, { path: 'E:/ws/a.txt', workitemId: 'wi_a', now: T0 })
  assert.equal(a.ok, true)
  const again = acquireLease(db, { path: 'E:/ws/a.txt', workitemId: 'wi_a', now: T0 + 1000 })
  assert.equal(again.ok, true)
  assert.equal(again.renewed, true)
  const b = acquireLease(db, { path: 'E:/ws/a.txt', workitemId: 'wi_b', now: T0 + 2000 })
  assert.equal(b.ok, false)
  assert.equal(b.holder, 'wi_a')
  db.close()
})

test('租约：过期可被接管；释放后别人能拿', () => {
  const db = openDb()
  acquireLease(db, { path: '/w/x.txt', workitemId: 'wi_a', ttlMs: 1000, now: T0 })
  const taken = acquireLease(db, { path: '/w/x.txt', workitemId: 'wi_b', now: T0 + 2000 })
  assert.equal(taken.ok, true)
  assert.equal(taken.takenFrom, 'wi_a')

  assert.equal(releaseLease(db, { path: '/w/x.txt' }), true)
  const c = acquireLease(db, { path: '/w/x.txt', workitemId: 'wi_c', now: T0 + 3000 })
  assert.equal(c.ok, true)
  db.close()
})

test('租约：按任务批量释放 + 过期清理', () => {
  const db = openDb()
  acquireLease(db, { path: '/w/a', workitemId: 'wi_a', now: T0 })
  acquireLease(db, { path: '/w/b', workitemId: 'wi_a', now: T0 })
  acquireLease(db, { path: '/w/c', workitemId: 'wi_c', ttlMs: 1000, now: T0 })
  assert.equal(releaseItemLeases(db, 'wi_a'), 2)
  assert.equal(listLeases(db, { now: T0 + 2000 }).length, 1)
  assert.equal(expireLeases(db, { now: T0 + 2000 }), 1)
  assert.equal(listLeases(db).length, 0)
  db.close()
})

test('租约：Windows 路径大小写与斜杠归一', () => {
  const a = normalizeLeasePath('E:/Workbench/A.txt', 'win32')
  const b = normalizeLeasePath('e:\\workbench\\a.txt', 'win32')
  assert.equal(a, b)
})
