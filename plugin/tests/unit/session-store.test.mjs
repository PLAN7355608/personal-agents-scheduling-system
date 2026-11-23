import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { findSessionLog, readSessionHeader, readSessionEvents, sessionAgeDays, vetWorkerPreset } from '../../src/session-store.js'

function makeSession(home, profile, id, lines) {
  const dir = join(home, 'sessions', profile, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  // 两帧，模拟追加写
  const half = Math.ceil(lines.length / 2)
  const a = zstdCompressSync(Buffer.from(lines.slice(0, half).map((l) => JSON.stringify(l)).join('\n') + '\n'))
  const b = zstdCompressSync(Buffer.from(lines.slice(half).map((l) => JSON.stringify(l)).join('\n') + '\n'))
  writeFileSync(file, Buffer.concat([a, b]))
  return file
}

test('会话日志：读头 / 读事件 / 找文件（跨帧）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  process.env.DSH_HOME = home
  makeSession(home, 'web', 'session-abc', [
    { type: 'session', version: 4, id: 'session-abc', createdAt: 1700000000000, cwd: '/tmp/ws', agentPreset: 'standard' },
    { type: 'turn/start', seq: 1, time: 1700000000001, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 1700000000002, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 3, time: 1700000000003, data: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
  ])
  const file = findSessionLog('session-abc')
  assert.ok(file && file.endsWith('session.v4.jsonl.zstd'))
  const header = readSessionHeader('session-abc')
  assert.equal(header.agentPreset, 'standard')
  assert.equal(header.cwd, '/tmp/ws')
  const { events } = readSessionEvents('session-abc')
  assert.equal(events.length, 3)
  assert.equal(events[2].type, 'user/message')
  delete process.env.DSH_HOME
})

test('工人资格：worker 预设放行；其他要 force', () => {
  assert.equal(vetWorkerPreset('secretary-worker').ok, true)
  const denied = vetWorkerPreset('standard')
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /不是工人预设/)
  assert.match(denied.reason, /force=true/)
  assert.equal(vetWorkerPreset('standard', { force: true }).ok, true)
  assert.equal(vetWorkerPreset(null).ok, false)
})

test('会话年龄：按 createdAt 算天', () => {
  const now = 1700000000000
  assert.equal(sessionAgeDays(now - 3 * 86400000, now), 3)
  assert.equal(sessionAgeDays(0), null)
})
