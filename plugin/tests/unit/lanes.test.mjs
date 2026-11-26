import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { createWorkItem, finishWorkItem, getWorkItem, transition } from '../../src/workitems.js'
import {
  adoptSession, claimLane, ensureLane, getLaneByKey, getLaneById, findLaneRef, laneContext, laneKeyFor, laneSummary,
  nextQueuedOnLane, releaseLane, repairStuckLanes, sweepIdleLanes,
} from '../../src/lanes.js'
import { inferScope } from '../../src/scope.js'

function fresh() {
  return openDb()
}

test('线：同 key 复用，不同 key 分开', () => {
  const db = fresh()
  const a = ensureLane(db, { key: 'session:s1' })
  const b = ensureLane(db, { key: 'session:s1' })
  const c = ensureLane(db, { key: 'session:s2' })
  assert.equal(a.id, b.id)
  assert.notEqual(a.id, c.id)
  assert.equal(a.scopeMode, 'suggest')
  assert.equal(getLaneByKey(db, 'owner', 'session:s1').id, a.id)
  db.close()
})

test('线内串行：占用后第二次占用失败，释放后可再占用', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1' })
  assert.equal(claimLane(db, lane.id, 'wi_a'), true)
  assert.equal(claimLane(db, lane.id, 'wi_b'), false)
  const released = releaseLane(db, lane.id)
  assert.equal(released.status, 'idle')
  assert.equal(claimLane(db, lane.id, 'wi_b'), true)
  db.close()
})

test('线上排队：FIFO 取最早的任务；上下文取最近完成', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1' })
  const mk = (text) => createWorkItem(db, { channel: 'gui', peer: 'owner', intent: text, laneId: lane.id }).item
  const one = mk('第一件')
  const two = mk('第二件')
  for (const it of [one, two]) {
    transition(db, it.id, 'triaged', { reason: 'r' })
    transition(db, it.id, 'queued', { reason: 'r' })
  }
  assert.equal(nextQueuedOnLane(db, lane.id).id, one.id)
  transition(db, one.id, 'running', { reason: 'r' })
  finishWorkItem(db, one.id, { result: '第一件做完了', artifacts: ['C:/out/a.txt'] })
  const ctx = laneContext(db, lane.id)
  assert.equal(ctx.length, 1)
  assert.match(ctx[0].result, /第一件/)
  assert.deepEqual(ctx[0].artifacts, ['C:/out/a.txt'])
  db.close()
})

test('空闲线：保留 session_id（身份不随空闲丢）', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1', now: Date.now() - 60 * 60 * 1000 })
  db.prepare('UPDATE lanes SET session_id = ?, status = ?, last_used_at = ? WHERE id = ?')
    .run('session-old', 'idle', Date.now() - 60 * 60 * 1000, lane.id)
  const idle = sweepIdleLanes(db, { ttlMs: 30 * 60 * 1000 })
  assert.equal(idle.length, 1)
  const after = getLaneById(db, lane.id)
  assert.equal(after.sessionId, 'session-old')
  assert.equal(after.status, 'idle')
  db.close()
})

test('卡住的线：当前任务已终态 → 自动释放', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1' })
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '卡住的任务', laneId: lane.id })
  transition(db, item.id, 'triaged', { reason: 'r' })
  transition(db, item.id, 'queued', { reason: 'r' })
  claimLane(db, lane.id, item.id)
  transition(db, item.id, 'running', { reason: 'r' })
  finishWorkItem(db, item.id, { result: 'done' })
  const repaired = repairStuckLanes(db)
  assert.equal(repaired, 1)
  assert.equal(getLaneById(db, lane.id).status, 'idle')
  db.close()
})

test('laneKey：会话优先，否则频道+对方', () => {
  assert.equal(laneKeyFor({ sessionId: 's1', channel: 'gui', peer: 'owner' }), 'session:s1')
  assert.equal(laneKeyFor({ channel: 'mock', peer: 'tester' }), 'peer:mock:tester')
})

test('scope 推断：绝对路径 → 项目根 + 相对目录（auto 高置信直接生效）', () => {
  const cfg = { workspaceRoot: 'E:/ws', defaultScopeMode: 'suggest' }
  const r = inferScope({ text: '把 E:/ws/pass/plugin/src/db.js 改一下', cfg })
  assert.equal(r.projectRoot, 'E:/ws')
  assert.equal(r.scope, 'pass/plugin/src')
  assert.equal(r.confidence, 0.9)
  assert.equal(r.source, 'suggest')

  const auto = inferScope({ text: '改 /root/proj/a/b.md', cfg: { workspaceRoot: '/root/proj', defaultScopeMode: 'auto' } })
  assert.equal(auto.source, 'auto')
  assert.equal(auto.scope, 'a')
})

test('scope 推断：manual 档不推断；无路径按项目名只给建议', () => {
  const manual = inferScope({ text: '改 E:/ws/x/y.js', cfg: { workspaceRoot: 'E:/ws' }, lane: { scopeMode: 'manual' } })
  assert.equal(manual.projectRoot, null)
  assert.equal(manual.source, 'manual')

  const byName = inferScope({ text: '把 pass 里那个脚本跑一下', cfg: { workspaceRoot: 'E:/ws', projects: [{ name: 'pass', root: 'E:/ws/pass' }] } })
  assert.equal(byName.projectRoot, 'E:/ws/pass')
  assert.equal(byName.confidence, 0.6)
  assert.equal(byName.source, 'suggest')
})

test('登记已有会话：任何会话都能挂到线上，meta 记 adopt/backfill', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1' })
  const after = adoptSession(db, lane.id, 'session-old-worker', { label: '老会话', backfill: true })
  assert.equal(after.sessionId, 'session-old-worker')
  assert.equal(after.label, '老会话')
  assert.equal(after.meta.adopted, true)
  assert.equal(after.meta.backfill, true)
  // 释放后会话仍在（不被清掉）
  releaseLane(db, lane.id)
  assert.equal(getLaneById(db, lane.id).sessionId, 'session-old-worker')
  db.close()
})
test('findLaneRef：认 lane id，也认上一单 wi_xxx', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1' })
  const { item } = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '接着写材料', laneId: lane.id })
  assert.equal(findLaneRef(db, lane.id).id, lane.id)
  assert.equal(findLaneRef(db, item.id).id, lane.id)
  assert.equal(findLaneRef(db, 'wi_notexist'), null)
  assert.equal(findLaneRef(db, '随便什么'), null)
  assert.equal(findLaneRef(db, ''), null)
  db.close()
})

test('laneSummary：带任务数和最近一单，供 secretary_lanes 用', () => {
  const db = fresh()
  const lane = ensureLane(db, { key: 'session:s1', workspace: '/root/example' })
  createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '第一单', laneId: lane.id, ts: Date.now() - 1000 })
  const latest = createWorkItem(db, { channel: 'gui', peer: 'owner', intent: '第二单', laneId: lane.id, ts: Date.now() }).item
  const s = laneSummary(db, getLaneById(db, lane.id))
  assert.equal(s.id, lane.id)
  assert.equal(s.workspace, '/root/example')
  assert.equal(s.tasks, 2)
  assert.equal(s.lastTask.id, latest.id)
  assert.match(s.lastTask.intent, /第二单/)
  db.close()
})
