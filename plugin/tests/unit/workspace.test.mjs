import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTaskWorkspace } from '../../src/workspace.js'
import { laneKeyFor } from '../../src/lanes.js'

test('工作区解析：存在的绝对目录通过；不存在/相对路径报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'))
  const ok = resolveTaskWorkspace(dir, {})
  assert.equal(ok.cwd, dir)
  assert.ok(!ok.error)

  const missing = resolveTaskWorkspace(join(dir, 'nope'), {})
  assert.match(missing.error, /不存在/)

  const rel = resolveTaskWorkspace('relative/dir', {})
  assert.match(rel.error, /绝对路径/)

  const file = join(dir, 'f.txt')
  writeFileSync(file, 'x')
  const notDir = resolveTaskWorkspace(file, {})
  assert.match(notDir.error, /不是目录/)
})

test('工作区解析：允许列表外拒绝，列表内通过', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-root-'))
  const inside = join(root, 'proj')
  mkdirSync(inside, { recursive: true })
  const outside = mkdtempSync(join(tmpdir(), 'ws-out-'))

  const passed = resolveTaskWorkspace(inside, { allowedWorkspaces: [root] })
  assert.equal(passed.cwd, inside)

  const blocked = resolveTaskWorkspace(outside, { allowedWorkspaces: [root] })
  assert.match(blocked.error, /不在允许列表/)
})

test('线 key：默认工作区不加后缀，指定别的目录加 @路径', () => {
  const base = 'E:/base'
  assert.equal(laneKeyFor({ sessionId: 's1', workspace: 'E:/base', baseWorkspace: base }), 'session:s1')
  assert.equal(laneKeyFor({ sessionId: 's1', workspace: 'E:/base/proj', baseWorkspace: base }), 'session:s1@E:/base/proj')
  assert.equal(laneKeyFor({ sessionId: 's1' }), 'session:s1')
  assert.equal(laneKeyFor({ channel: 'gui', peer: 'owner', workspace: 'E:/x', baseWorkspace: base }), 'peer:gui:owner@E:/x')
})
