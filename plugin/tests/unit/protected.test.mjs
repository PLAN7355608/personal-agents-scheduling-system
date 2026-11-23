import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProtectedPath, escalationReason, protectedBoundaryReason } from '../../src/protected.js'

test('isProtectedPath 拦系统目录', () => {
  assert.equal(isProtectedPath('C:\\Windows\\System32\\drivers\\etc\\hosts'), true)
  assert.equal(isProtectedPath('C:/Windows/Temp/x.txt'), true)
  assert.equal(isProtectedPath('C:\\Program Files\\x'), true)
  assert.equal(isProtectedPath('C:\\ProgramData\\x'), true)
  assert.equal(isProtectedPath('E:\\workspace\\PASS\\x.txt'), false)
})

test('escalationReason 拦提权与系统修改命令', () => {
  assert.ok(escalationReason('Start-Process powershell -Verb RunAs -ArgumentList x'))
  assert.ok(escalationReason('schtasks /create /tn x /tr y'))
  assert.ok(escalationReason('takeown /f C:\\Windows\\System32\\x'))
  assert.ok(escalationReason('reg add HKLM\\Software\\x /v y'))
  assert.ok(escalationReason('Set-Content C:\\Windows\\System32\\drivers\\etc\\hosts -Value x'))
  assert.equal(escalationReason('Get-ChildItem E:\\workspace'), null)
})

test('protectedBoundaryReason 按工具和参数判断', () => {
  assert.deepEqual(protectedBoundaryReason('write', { file_path: 'C:\\Windows\\x.txt' }), { kind: 'path', detail: '写入系统目录：C:\\Windows\\x.txt' })
  assert.equal(protectedBoundaryReason('write', { file_path: 'E:\\tmp\\x.txt' }), null)
  assert.ok(protectedBoundaryReason('pwsh', { command: 'Start-Process cmd -Verb RunAs' }))
  assert.equal(protectedBoundaryReason('pwsh', { command: 'Get-Date' }), null)
})
