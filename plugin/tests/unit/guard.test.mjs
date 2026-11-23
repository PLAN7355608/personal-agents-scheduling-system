import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWorkerPermission, relayDenialMessage, relayToolAllowed, workerDenialMessage, workerToolAllowed } from '../../src/guard.js'

test('Relay 白名单：传话类放行', () => {
  for (const n of ['secretary_create_task', 'secretary_wait', 'present', 'bagu_guard', 'bagu_meme', 'ask_user_question', 'todo_write']) {
    assert.equal(relayToolAllowed(n), true, n)
  }
})

test('Relay 白名单：重活类拒绝', () => {
  for (const n of ['edit_image', 'generate_image', 'ego_cli', 'ego_screenshot', 'pwsh', 'write', 'read_image', 'printer_print', 'ksp_control', 'dsh_im_group_history', 'web_fetch']) {
    assert.equal(relayToolAllowed(n), false, n)
  }
})

test('拦截提示写清原因与替代路径', () => {
  const msg = relayDenialMessage('edit_image')
  assert.match(msg, /Relay 只负责传话/)
  assert.match(msg, /secretary_create_task/)
})

test('Worker 权限档：合法值直通、非法值回退默认', () => {
  assert.equal(normalizeWorkerPermission('danger-full-access', 'workspace-write'), 'danger-full-access')
  assert.equal(normalizeWorkerPermission('auto-review', 'workspace-write'), 'auto-review')
  assert.equal(normalizeWorkerPermission('hacked', 'workspace-write'), 'workspace-write')
  assert.equal(normalizeWorkerPermission('', 'read-only'), 'read-only')
  assert.equal(normalizeWorkerPermission('', 'nonsense'), 'workspace-write')
})

test('工人白名单：干活类放行', () => {
  for (const n of ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash', 'read_image', 'web_search', 'web_fetch', 'secretary_work_finish', 'secretary_work_fail', 'skill', 'todo_write', 'univer_sheet', 'office_status']) {
    assert.equal(workerToolAllowed(n), true, n)
  }
})

test('工人白名单：逃生口/外联类拒绝', () => {
  for (const n of ['ego_cli', 'ego_click', 'dsh_im_return_file', 'printer_print', 'scanner_scan', 'ksp_control', 'plugin_manager', 'plugin_market', 'subagent', 'subagent_fork', 'present', 'ask_user_question']) {
    assert.equal(workerToolAllowed(n), false, n)
  }
  assert.match(workerDenialMessage('ego_cli'), /不该用这个工具/)
})
test('Relay 白名单：审批/收养/清理类必须拒绝（P0-1 回归）', () => {
  for (const n of ['secretary_decide_tool_request', 'secretary_adopt', 'secretary_prune', 'secretary_request_tool', 'secretary_work_finish', 'secretary_work_fail']) {
    assert.equal(relayToolAllowed(n), false, n)
  }
  assert.equal(relayToolAllowed('secretary_create_task'), true)
})