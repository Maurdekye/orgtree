// launchagent-detect.test.mjs — the three-layer, exit-code-first
// classification launchagent-mac.ts's detectState uses to tell
// not-installed / disabled / ok apart (Pattern 3, corrected from D-04). No
// real launchctl/sfltool call happens in this file — a mocked
// execFileSyncImpl drives every case. The real gated OS round-trip lives in
// tests/disruptive/launchagent-install.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const repo = path.resolve(import.meta.dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-launchagent-detect-'))
const outfile = path.join(root, 'launchagent-mac.cjs')
await build({ entryPoints: [path.join(repo, 'apps/desktop/main/launchagent-mac.ts')], outfile, bundle: true, format: 'cjs', platform: 'node' })
const { detectState, autostartRemediationDialog, LOGIN_ITEMS_SETTINGS_URL } = createRequire(import.meta.url)(outfile)

const LABEL = 'com.maurdekye.orgtree.boot-engine'

/** Builds a mocked execFileSyncImpl. Each entry is either a Buffer-like
 *  return value or an Error to throw, keyed by the launchctl/sfltool
 *  subcommand (`print`, `print-disabled`, `dumpbtm`). Anything not listed
 *  succeeds with empty output. */
function mockExec(behaviors = {}) {
  return (command, args) => {
    const key = args[0]
    const behavior = behaviors[key]
    if (behavior instanceof Error) throw behavior
    return Buffer.from(behavior ?? '')
  }
}

test('a throwing print call means not-installed', () => {
  const exec = mockExec({ print: new Error('Could not find service') })
  assert.equal(detectState(LABEL, { execFileSyncImpl: exec, uid: 501 }), 'not-installed')
})

test('print-disabled output naming the label means disabled', () => {
  const exec = mockExec({ 'print-disabled': `${LABEL} -> disabled` })
  assert.equal(detectState(LABEL, { execFileSyncImpl: exec, uid: 501 }), 'disabled')
})

test('a throwing print-disabled call means unknown, never a fall-through to ok', () => {
  const exec = mockExec({ 'print-disabled': new Error('unexpected') })
  assert.equal(detectState(LABEL, { execFileSyncImpl: exec, uid: 501 }), 'unknown')
})

test('an sfltool BTM block naming the label as disallowed means disabled', () => {
  const exec = mockExec({
    dumpbtm: `Other Item\nDisposition: [enabled, allowed, notified]\n\n${LABEL}\nDisposition: [disallowed]\n`,
  })
  assert.equal(detectState(LABEL, { execFileSyncImpl: exec, uid: 501 }), 'disabled')
})

test('a throwing sfltool call still means ok, not unknown and not a thrown exception', () => {
  const exec = mockExec({ dumpbtm: new Error('sfltool: command not found') })
  assert.equal(detectState(LABEL, { execFileSyncImpl: exec, uid: 501 }), 'ok')
})

test('print and print-disabled clean, no sfltool match, means ok', () => {
  const exec = mockExec({ dumpbtm: `Other Item\nDisposition: [enabled, allowed, notified]\n` })
  assert.equal(detectState(LABEL, { execFileSyncImpl: exec, uid: 501 }), 'ok')
})

test('autostartRemediationDialog("disabled") matches the crashReportDialog shape', () => {
  const dialog = autostartRemediationDialog('disabled')
  assert.deepEqual(dialog.buttons, ['Open Login Items Settings', 'Close'])
  assert.equal(dialog.defaultId, 0)
  assert.equal(dialog.cancelId, 1)
  assert.match(dialog.message, /turned off/)
})

test('autostartRemediationDialog("not-installed") names an unconfirmed install, not an active disable', () => {
  const dialog = autostartRemediationDialog('not-installed')
  assert.deepEqual(dialog.buttons, ['Open Login Items Settings', 'Close'])
  assert.equal(dialog.defaultId, 0)
  assert.equal(dialog.cancelId, 1)
  assert.match(dialog.message, /could not confirm/)
})

test('the two remediation states have distinct message text', () => {
  assert.notEqual(autostartRemediationDialog('disabled').message, autostartRemediationDialog('not-installed').message)
})

test('LOGIN_ITEMS_SETTINGS_URL is the literal Login Items & Extensions deep link', () => {
  assert.equal(LOGIN_ITEMS_SETTINGS_URL, 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension')
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
