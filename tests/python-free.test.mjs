// 4.6.1: Orgtree carries no Python (docs/python-removal.md). These guards keep
// it that way: no tracked .py file, no Python runtime in the Windows package,
// no Python in the build workflows. The 3.x process-name strings that let an
// installer recognise an old 3.x install are data, not Python, and stay.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })

test('the repository tracks no Python source', () => {
  // ls-files lists the engine/mailhub gitlink, never the submodule's own files.
  const python = git(['ls-files', '--', '*.py', '*.pyw', '*.pyi']).split(/\r?\n/).filter(Boolean)
  assert.deepEqual(python, [], `tracked Python files: ${python.join(', ')}`)
})

test('the Windows package ships no Python runtime, backend or Python-era payload', () => {
  const build = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build
  const text = JSON.stringify(build.extraResources)
  for (const banned of ['runtime/**', 'backend/**', 'native/**', 'pypg', 'pg-custodian', '.py']) {
    assert.ok(!text.includes(banned), `package.json extraResources still packages ${banned}`)
  }
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts
  for (const [name, command] of Object.entries(scripts)) assert.doesNotMatch(command, /\bpython\b|\.py\b/, `npm script ${name} runs Python`)
})

test('the installer relaunches through the Rust helper, not pythonw', () => {
  const nsh = fs.readFileSync(path.join(ROOT, 'build/installer.nsh'), 'utf8')
  const instructions = nsh.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(instructions, /pythonw|python\.exe|\.py\b/i)
  assert.match(instructions, /orgtree-installer-relaunch\.exe/)
})

test('no build workflow sets up or runs Python', () => {
  const dir = path.join(ROOT, '.github', 'workflows')
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.yml'))) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).filter(line => !/^\s*#/.test(line))
    assert.doesNotMatch(lines.join('\n'), /setup-python|\bpython3? |\bpip install/, `${name} still uses Python`)
  }
})

test('the 3.x upgrade traps are kept: old Python process and task names are still recognised', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'tools/boot-engine-task.ps1'), 'utf8')
  assert.match(boot, /runtime\\python\.exe/, 'boot-engine-task.ps1 must still recognise a 3.x boot task')
  assert.match(boot, /service_host\.py/, 'boot-engine-task.ps1 must still recognise a 3.x boot task')
  const upgrade = fs.readFileSync(path.join(ROOT, 'tools/installer-upgrade.ps1'), 'utf8')
  assert.match(upgrade, /'PYTHON\.EXE', 'PYTHONW\.EXE'/, 'installer-upgrade.ps1 must still stop a 3.x engine tree')
})
