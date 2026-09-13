import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const installer = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8')
const macroStart = installer.indexOf('!macro orgtreeRemoveLegacyShortcuts')
const macroEnd = installer.indexOf('!macroend', macroStart)
assert.ok(macroStart >= 0 && macroEnd > macroStart, 'shortcut cleanup macro must exist')
const macro = installer.slice(macroStart, macroEnd)

// Execute the macro's filesystem effects against isolated all-users/current
// Start Menu roots. This checks resolved `$SMPROGRAMS` paths and context
// transitions, rather than only asserting that strings occur in the NSIS file.
function runCleanup(installMode, roots) {
  let context = installMode === 'all' ? 'all' : 'current'
  let activeBranch = null
  for (const line of macro.split(/\r?\n/)) {
    const condition = line.trim()
    if (condition === '${if} $installMode == "all"') {
      activeBranch = installMode === 'all'
      continue
    }
    if (condition === '${else}') {
      activeBranch = !activeBranch
      continue
    }
    if (condition === '${endif}') {
      activeBranch = null
      continue
    }
    if (activeBranch === false) continue
    const select = line.match(/^\s*SetShellVarContext\s+(all|current)\s*$/)
    if (select) {
      context = select[1]
      continue
    }
    const deletion = line.match(/^\s*Delete\s+"\$SMPROGRAMS\\(.+)"\s*$/)
    if (deletion) fs.rmSync(path.join(roots[context], deletion[1].replaceAll('\\', path.sep)), { force: true })
  }
  return context
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-shortcut-scope-'))
  const roots = { all: path.join(base, 'all'), current: path.join(base, 'current') }
  for (const root of Object.values(roots)) {
    fs.mkdirSync(path.join(root, 'Orgtree'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Orgtree v2.lnk'), 'legacy')
    fs.writeFileSync(path.join(root, 'Orgtree', 'Orgtree v2.lnk'), 'legacy')
    fs.writeFileSync(path.join(root, 'Orgtree.lnk'), 'branded')
  }
  return { base, roots }
}

test('all-users cleanup resolves and removes both Start Menu scopes', () => {
  const { base, roots } = fixture()
  try {
    assert.equal(runCleanup('all', roots), 'all', 'all-users install restores all-users context')
    for (const root of Object.values(roots)) {
      assert.equal(fs.existsSync(path.join(root, 'Orgtree v2.lnk')), false)
      assert.equal(fs.existsSync(path.join(root, 'Orgtree', 'Orgtree v2.lnk')), false)
      assert.equal(fs.readFileSync(path.join(root, 'Orgtree.lnk'), 'utf8'), 'branded')
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})

test('per-user cleanup resolves only the per-user Start Menu scope', () => {
  const { base, roots } = fixture()
  try {
    assert.equal(runCleanup('CurrentUser', roots), 'current')
    for (const relative of ['Orgtree v2.lnk', path.join('Orgtree', 'Orgtree v2.lnk')]) {
      assert.equal(fs.existsSync(path.join(roots.current, relative)), false)
      assert.equal(fs.existsSync(path.join(roots.all, relative)), true)
    }
    assert.equal(fs.readFileSync(path.join(roots.current, 'Orgtree.lnk'), 'utf8'), 'branded')
    assert.equal(fs.readFileSync(path.join(roots.all, 'Orgtree.lnk'), 'utf8'), 'branded')
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
