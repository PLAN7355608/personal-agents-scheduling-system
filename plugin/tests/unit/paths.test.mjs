import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDbPath, resolveWorkspaceRoot } from '../../src/paths.js'

test('dbPath：留空用 ~/.dsh/secretary，给了就用给的', () => {
  assert.equal(resolveDbPath(''), join(homedir(), '.dsh', 'secretary', 'secretary.db'))
  assert.equal(resolveDbPath('   '), join(homedir(), '.dsh', 'secretary', 'secretary.db'))
  assert.equal(resolveDbPath('/data/sec.db'), resolve('/data/sec.db'))
  assert.equal(resolveDbPath('C:/x/sec.db'), resolve('C:/x/sec.db'))
})

test('workspaceRoot：留空用当前目录，给了转绝对路径', () => {
  assert.equal(resolveWorkspaceRoot(''), homedir())
  assert.equal(resolveWorkspaceRoot('.'), process.cwd())
  const got = resolveWorkspaceRoot('/tmp/ws')
  assert.ok(got.endsWith('ws'))
})
