import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeDeletionCommand } from '../../src/deletion-guard.js'

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'del-ws-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'x')
  writeFileSync(join(root, 'sub', 'b.txt'), 'x')
  return root
}

test('删除护栏：非删除命令放行', () => {
  const ws = makeWorkspace()
  for (const cmd of ['ls -la', 'cat a.txt', 'grep -r foo .', 'python3 build.py']) {
    assert.equal(analyzeDeletionCommand(cmd, { workspaceRoot: ws }).kind, 'none')
  }
})

test('删除护栏：工作区内小删除放行并统计', () => {
  const ws = makeWorkspace()
  const r = analyzeDeletionCommand('rm -f a.txt', { workspaceRoot: ws })
  assert.equal(r.kind, 'delete')
  assert.equal(r.action, 'allow')
  assert.equal(r.count, 1)
  assert.deepEqual(r.targets, [join(ws, 'a.txt')])
})

test('删除护栏：工作区外/根/通配/变量 → 拒绝', () => {
  const ws = makeWorkspace()
  assert.equal(analyzeDeletionCommand('rm -rf /root/deploy/plugin.tar.gz', { workspaceRoot: ws }).action, 'deny')
  assert.equal(analyzeDeletionCommand('rm -rf /', { workspaceRoot: ws }).action, 'deny')
  assert.equal(analyzeDeletionCommand('rm -rf *', { workspaceRoot: ws }).action, 'deny')
  assert.equal(analyzeDeletionCommand('rm -rf $HOME/x', { workspaceRoot: ws }).action, 'deny')
  assert.equal(analyzeDeletionCommand('dd if=/dev/zero of=/dev/sda', { workspaceRoot: ws }).action, 'deny')
  assert.equal(analyzeDeletionCommand('find / -delete', { workspaceRoot: ws }).action, 'deny')
  // 删除工作区根本身
  assert.equal(analyzeDeletionCommand('rm -rf ' + ws, { workspaceRoot: ws }).action, 'deny')
})

test('删除护栏：大删除转审批；searchDirs 内的共享目录允许', () => {
  const ws = makeWorkspace()
  const share = mkdtempSync(join(tmpdir(), 'del-share-'))
  const bigDir = join(share, 'sub')
  mkdirSync(bigDir, { recursive: true })
  for (let i = 0; i < 60; i += 1) writeFileSync(join(bigDir, 'f' + i + '.txt'), 'x')
  const big = analyzeDeletionCommand('rm -rf ' + join(share, '*'), { workspaceRoot: ws, searchDirs: [share] })
  // 通配会被拒；改用明确目录
  assert.equal(big.action, 'deny')
  // 共享目录根本身不允许删
  assert.equal(analyzeDeletionCommand('rm -rf ' + share, { workspaceRoot: ws, searchDirs: [share] }).action, 'deny')
  const dirCase = analyzeDeletionCommand('rm -rf ' + bigDir, { workspaceRoot: ws, searchDirs: [share] })
  assert.equal(dirCase.action, 'escalate')
  assert.ok(dirCase.count > 50)
})

test('删除护栏：目标解析不到（变量/管道）转审批', () => {
  const ws = makeWorkspace()
  const r = analyzeDeletionCommand('rm -rf "$TARGET_DIR"', { workspaceRoot: ws })
  assert.equal(r.kind, 'delete')
  assert.notEqual(r.action, 'allow')
})

test('删除护栏：命令里的 cd 要被跟踪（相对路径按 cd 之后解析）', () => {
  const ws = makeWorkspace()
  // cd 到工作区外再相对删除 → 拒绝
  const outside = analyzeDeletionCommand('cd /tmp && rm -rf zz && mkdir zz', { workspaceRoot: ws })
  assert.equal(outside.kind, 'delete')
  assert.equal(outside.action, 'deny', JSON.stringify(outside))
  // cd 到工作区内再相对删除 → 放行
  const inside = analyzeDeletionCommand('cd ' + ws + ' && rm -f a.txt', { workspaceRoot: ws })
  assert.equal(inside.action, 'allow')
  assert.deepEqual(inside.targets, [join(ws, 'a.txt')])
})
test('删除护栏：~ 家目录写法一律拒绝（P0-2 回归）', () => {
  const ws = makeWorkspace()
  for (const cmd of ['rm -rf ~/x', 'rm -rf ~', 'rm -rf ~user/x', 'rm -rf $HOME/x', 'del %USERPROFILE%\\x']) {
    const r = analyzeDeletionCommand(cmd, { workspaceRoot: ws })
    assert.equal(r.kind, 'delete', cmd)
    assert.equal(r.action, 'deny', cmd + ' → ' + JSON.stringify(r))
  }
})

test('删除护栏：Windows 命令族与不可解析形态', () => {
  const ws = makeWorkspace()
  assert.equal(analyzeDeletionCommand('rd /s /q ' + ws, { workspaceRoot: ws }).action, 'deny')
  assert.equal(analyzeDeletionCommand('erase ' + join(ws, 'a.txt'), { workspaceRoot: ws }).action, 'allow')
  assert.equal(analyzeDeletionCommand('find . -exec rm -rf {} \\;', { workspaceRoot: ws }).action, 'escalate')
  assert.equal(analyzeDeletionCommand('pwsh -File kill.ps1', { workspaceRoot: ws }).action, 'escalate')
  assert.equal(analyzeDeletionCommand('git clean -fdx', { workspaceRoot: ws }).action, 'escalate')
})
test('删除护栏：python 里 dd=... 不误判成 dd 命令', () => {
  const ws = makeWorkspace()
  const cmd = 'cd /tmp && CID=d64e1defe && curl -s "https://example.com/search/$CID" -o a1.json && python3 -c "import json;d=json.load(open(\'a1.json\'));dd=d.get(\'data\',{});print(dd)"'
  const r = analyzeDeletionCommand(cmd, { workspaceRoot: ws })
  assert.equal(r.kind, 'none')
})

test('删除护栏：工作区内通配（任务临时图/脚本）按规模放行', () => {
  const ws = makeWorkspace()
  for (let i = 0; i < 3; i += 1) writeFileSync(join(ws, 'sub', 'tb-' + i + '.png'), 'x')
  const r = analyzeDeletionCommand('cd ' + join(ws, 'sub') + ' && rm -f tb-*.png', { workspaceRoot: ws, maxFilesAuto: 50 })
  assert.equal(r.kind, 'delete')
  assert.equal(r.action, 'allow')
  assert.equal(r.count, 3)
})

test('删除护栏：通配没有匹配到文件则拒绝', () => {
  const ws = makeWorkspace()
  const r = analyzeDeletionCommand('cd ' + join(ws, 'sub') + ' && rm -f nope-*.png', { workspaceRoot: ws })
  assert.equal(r.kind, 'delete')
  assert.equal(r.action, 'deny')
})

test('删除护栏：find -exec rm 仍转审批', () => {
  const ws = makeWorkspace()
  const r = analyzeDeletionCommand('find . -name "x" -exec rm {} \\;', { workspaceRoot: ws })
  assert.equal(r.kind, 'delete')
  assert.equal(r.action, 'escalate')
})
