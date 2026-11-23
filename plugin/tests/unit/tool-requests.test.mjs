import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import {
  countPendingToolRequests, createToolRequest, decideToolRequest, getToolRequest,
  hasToolGrant, learnedToolGrant, listToolRequests, toolRequestForbidden,
} from '../../src/tool-requests.js'

function fresh() { return openDb() }

test('黑名单工具：直接 forbidden，不可申请', () => {
  assert.equal(toolRequestForbidden('ego_cli'), true)
  assert.equal(toolRequestForbidden('plugin_manager'), true)
  assert.equal(toolRequestForbidden('dsh_im_return_file'), true)
  assert.equal(toolRequestForbidden('printer_print'), true)
  assert.equal(toolRequestForbidden('ksp_control'), true)
  assert.equal(toolRequestForbidden('subagent_fork'), true)
  assert.equal(toolRequestForbidden('write'), false)
  const db = fresh()
  const r = createToolRequest(db, { tool: 'ego_cli', reason: '想走捷径' })
  assert.equal(r.status, 'forbidden')
  assert.throws(() => decideToolRequest(db, r.id, { approve: true }), /黑名单/)
  db.close()
})

test('申请：pending；批准 once → 只对那个任务有效；拒绝 → denied', () => {
  const db = fresh()
  const req = createToolRequest(db, { tool: 'ext_tool_a', workitemId: 'wi_1', laneId: 'lane_1', reason: '要打印', wantScope: 'once' })
  assert.equal(req.status, 'pending')
  assert.equal(countPendingToolRequests(db), 1)

  const allowed = decideToolRequest(db, req.id, { approve: true })
  assert.equal(allowed.status, 'allowed')
  assert.equal(allowed.scopeGranted, 'once')
  assert.equal(hasToolGrant(db, { tool: 'ext_tool_a', workitemId: 'wi_1' }), true)
  assert.equal(hasToolGrant(db, { tool: 'ext_tool_a', workitemId: 'wi_2' }), false)

  const req2 = createToolRequest(db, { tool: 'ext_tool_b', workitemId: 'wi_1', reason: '扫描' })
  const denied = decideToolRequest(db, req2.id, { approve: false })
  assert.equal(denied.status, 'denied')
  assert.equal(hasToolGrant(db, { tool: 'ext_tool_b', workitemId: 'wi_1' }), false)
  assert.equal(countPendingToolRequests(db), 0)
  db.close()
})

test('lane 范围：同线有效、别线无效', () => {
  const db = fresh()
  const req = createToolRequest(db, { tool: 'ext_tool_c', laneId: 'lane_a', workitemId: 'wi_x', reason: 'office 工具' })
  decideToolRequest(db, req.id, { approve: true, scope: 'lane' })
  assert.equal(hasToolGrant(db, { tool: 'ext_tool_c', laneId: 'lane_a', workitemId: 'wi_y' }), true)
  assert.equal(hasToolGrant(db, { tool: 'ext_tool_c', laneId: 'lane_b', workitemId: 'wi_y' }), false)
  db.close()
})

test('同一任务同一工具重复申请复用 pending；处理过的不复用', () => {
  const db = fresh()
  const a = createToolRequest(db, { tool: 'ext_tool_a', workitemId: 'wi_1', reason: 'a' })
  const b = createToolRequest(db, { tool: 'ext_tool_a', workitemId: 'wi_1', reason: 'b' })
  assert.equal(a.id, b.id)
  decideToolRequest(db, a.id, { approve: false })
  const c = createToolRequest(db, { tool: 'ext_tool_a', workitemId: 'wi_1', reason: 'c' })
  assert.notEqual(c.id, a.id)
  assert.equal(c.status, 'pending')
  db.close()
})

test('申请列表按状态过滤', () => {
  const db = fresh()
  const a = createToolRequest(db, { tool: 'ext_tool_a', workitemId: 'wi_1', reason: 'a' })
  createToolRequest(db, { tool: 'ext_tool_a', workitemId: 'wi_2', reason: 'b' })
  decideToolRequest(db, a.id, { approve: true })
  assert.equal(listToolRequests(db, { status: 'pending' }).length, 1)
  assert.equal(listToolRequests(db, { status: 'allowed' }).length, 1)
  assert.equal(getToolRequest(db, a.id).status, 'allowed')
  db.close()
})

test('M3 学习：同线批准过的工具自动放行；别的线不沾光；global 全局放行', () => {
  const db = fresh()
  // lane 批准
  const r = createToolRequest(db, { tool: 'ext_tool_l', laneId: 'lane_l1', workitemId: 'wi_1', reason: '这线要用' })
  decideToolRequest(db, r.id, { approve: true, scope: 'lane' })
  assert.deepEqual(learnedToolGrant(db, { tool: 'ext_tool_l', laneId: 'lane_l1' }), { allow: true, source: 'lane' })
  assert.equal(learnedToolGrant(db, { tool: 'ext_tool_l', laneId: 'lane_l2' }), null)
  assert.equal(learnedToolGrant(db, { tool: 'ext_tool_l' }), null)

  // global 批准：非低危工具自动降级为 lane（不能一次长期免审）
  const g = createToolRequest(db, { tool: 'ext_tool_g', reason: '长期要用' })
  const decided = decideToolRequest(db, g.id, { approve: true, scope: 'global' })
  assert.equal(decided.scopeGranted, 'lane')
  assert.equal(learnedToolGrant(db, { tool: 'ext_tool_g', laneId: 'any' }), null)

  // 低危只读工具才允许 global
  const rg = createToolRequest(db, { tool: 'read', reason: '经常读文件' })
  const rd = decideToolRequest(db, rg.id, { approve: true, scope: 'global' })
  assert.equal(rd.scopeGranted, 'global')
  assert.deepEqual(learnedToolGrant(db, { tool: 'read', laneId: 'any' }), { allow: true, source: 'global' })

  // 拒绝过的不会被学习
  const d = createToolRequest(db, { tool: 'ext_tool_d', laneId: 'lane_l1', reason: '不要' })
  decideToolRequest(db, d.id, { approve: false })
  assert.equal(learnedToolGrant(db, { tool: 'ext_tool_d', laneId: 'lane_l1' }), null)
  db.close()
})