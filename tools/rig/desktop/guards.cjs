// tools/rig/desktop/guards.cjs: what keeps the rig's desktop harness
// (main.cjs) silent and off the real clipboard (team TEST WINDOW ISOLATION
// and SILENT TESTS; docket rig-proofs-never-open-an-unguarded-desk-window-b).
// main.cjs starts Chromium with MUTE_SWITCH and mutes its window, answers
// every clipboard permission request and check with "denied", runs
// CLIPBOARD_STUB at document start in every page, and refuses driver keys and
// raw CDP calls that would reach the OS clipboard. Pure functions, so the rig's
// unit test checks them without Electron.
'use strict'

const MUTE_SWITCH = 'mute-audio'

/** A permission the page may have: never the clipboard. */
function allowPermission(permission) {
  return !/clipboard/i.test(String(permission ?? ''))
}

// CDP Input modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8
const CTRL_OR_META = 2 | 4
const SHIFT = 8

/** A key the driver must not send: Ctrl/Meta+C/X/V, Ctrl/Shift+Insert and
 * Shift+Delete (cut on Windows) reach the OS clipboard through the editor's
 * own commands. */
function refusedKey({ key, code, modifiers = 0 } = {}) {
  const k = String(key ?? '').toLowerCase()
  const c = String(code ?? '')
  const letter = /^[cxv]$/.test(k) || /^Key[CXV]$/.test(c)
  const insert = k === 'insert' || c === 'Insert'
  const del = k === 'delete' || c === 'Delete'
  return ((modifiers & CTRL_OR_META) !== 0 && (letter || insert)) || ((modifiers & SHIFT) !== 0 && (insert || del))
}

/** A raw CDP call a page script must not make: a clipboard key, or a
 * clipboard permission grant. */
function refusedCdp(method, params = {}) {
  if (method === 'Input.dispatchKeyEvent') return refusedKey(params)
  if (method === 'Browser.grantPermissions') return (params.permissions ?? []).some(p => /clipboard/i.test(String(p)))
  if (method === 'Browser.setPermission') return /clipboard/i.test(String(params.permission?.name ?? ''))
  return false
}

// Runs before the page's own scripts (Page.addScriptToEvaluateOnNewDocument).
// navigator.clipboard becomes an in-memory one, so the app's copy buttons
// still work and can be read back; execCommand copy/cut/paste do nothing.
// No copy/cut/paste event listener: Chromium writes a prevented copy event's
// (empty) data to the system clipboard, so preventing it would CLEAR the real
// clipboard. The editor's own copy commands come only from keys, which the
// driver refuses (refusedKey).
const CLIPBOARD_STUB = `(() => {
  let text = ''
  const fake = {
    writeText: async t => { text = String(t) },
    readText: async () => text,
    write: async () => {},
    read: async () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
  }
  try { Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => fake }) } catch (e) {}
  const exec = Document.prototype.execCommand
  Document.prototype.execCommand = function (cmd, ...rest) {
    if (/^(copy|cut|paste)$/i.test(String(cmd))) return false
    return exec.call(this, cmd, ...rest)
  }
  window.__rigClipboardGuard = { installed: true, last: () => text }
})()`

module.exports = { MUTE_SWITCH, allowPermission, refusedKey, refusedCdp, CLIPBOARD_STUB }
