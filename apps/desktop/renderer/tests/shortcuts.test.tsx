// shortcuts.test.tsx — the Keyboard shortcuts list matches the real bindings.
//
// User 2026-10-14: "we need a keyboard shortcuts explainer somewhere in the
// app" — a read-only section in App settings. The list (src/shortcuts.ts) is
// checked against the source both ways: every key a file binds has an entry
// naming that file, and every entry's key is still bound in a file it names.
//
// Run:  node apps/desktop/renderer/tests/run.mjs shortcuts
import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN, isMacPlatform, keyCaps, NON_SHORTCUT_BINDINGS, shortcutGroups } from '../src/shortcuts'
import type { Shortcut } from '../src/shortcuts'
import { ShortcutsSettings } from '../src/canvas/shortcutsettings'

declare const __SRC_DIR__: string
const DESKTOP = path.join(__SRC_DIR__, '..', '..')
const ROOTS = ['renderer/src', 'main']
const SELF = 'renderer/src/shortcuts.ts'
const TYPEAHEAD = 'A-Z'

const NAMED = new Set(['Escape', 'Enter', 'Tab', ' ', 'Backspace', 'Delete', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift', 'Control',
  'Alt', 'Meta', 'Insert', 'ContextMenu', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)])
const norm = (k: string) => k.length === 1 ? k.toLowerCase() : k
const isKey = (k: string) => NAMED.has(k) || /^[a-z0-9]$/i.test(k)

/** The keys one file binds: what its keyboard handlers compare against. */
function scanKeys(text: string): Set<string> {
  const found = new Set<string>()
  const add = (k: string) => { if (isKey(k)) found.add(norm(k)) }
  // e.key === 'Escape', input.key !== 'Enter', event.key == 'n'
  for (const m of text.matchAll(/\.key\s*[!=]==?\s*(['"])(.*?)\1/g)) add(m[2]!)
  // event.key.toLowerCase() !== 'z'
  for (const m of text.matchAll(/\.key\.toLowerCase\(\)\s*[!=]==?\s*(['"])(.*?)\1/g)) add(m[2]!)
  // const key = event.key.toLowerCase(); if (key === 'z') ...
  // Only aliases read from an event key count, not arbitrary local strings.
  for (const alias of text.matchAll(/\bconst\s+(\w+)\s*=\s*\w+\.key(?:\.toLowerCase\(\))?/g))
    for (const m of text.matchAll(new RegExp(`\\b${alias[1]}\\s*[!=]==?\\s*(['"])(.*?)\\1`, 'g'))) add(m[2]!)
  // ['ArrowLeft', 'Home'].includes(e.key)
  for (const m of text.matchAll(/\[([^\]]*)\]\.includes\(\s*\w+\.key\s*\)/g))
    for (const s of m[1]!.matchAll(/(['"])(.*?)\1/g)) add(s[2]!)
  // Electron menu accelerators: 'CmdOrCtrl+X'
  for (const m of text.matchAll(/accelerator:\s*(['"])(.*?)\1/g)) add(m[2]!.split('+').pop()!)
  // a key table its own matcher reads: { keys: ['F1', 'Shift+F10'] } beside `.keys.includes(`
  if (/\.keys\.includes\(/.test(text))
    for (const m of text.matchAll(/keys:\s*\[([^\]]*)\]/g))
      for (const s of m[1]!.matchAll(/(['"])(.*?)\1/g)) add(s[2]!.split('+').pop()!)
  // letter typeahead: any printable key
  if (/\.key\.length\s*!==\s*1/.test(text)) found.add(TYPEAHEAD)
  return found
}

/** Delegation is a binding only with the actual import, call and key listener.
 * Toasts request undo only; the durable surface handles both directions. */
function historyBindingKeys(text: string, classifier: Set<string>): Set<string> {
  if (!/import\s*\{[^}]*\bhistoryShortcut\b[^}]*\}\s*from\s*['"]\.\/undokeys['"]/.test(text)
    || !/\bhistoryShortcut\(\s*\w+\s*,/.test(text)
    || !/\.addEventListener\(\s*['"]keydown['"]/.test(text)) return new Set()
  const undoOnly = /historyShortcut\([^\n]*\)\s*!==\s*['"]undo['"]/.test(text)
  return new Set([...classifier].filter(k => !undoOnly || k === 'z'))
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(DESKTOP, rel))) {
      const r = `${rel}/${name}`
      if (statSync(path.join(DESKTOP, r)).isDirectory()) walk(r)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)
        && r !== SELF) out.push(r)
    }
  }
  ROOTS.forEach(walk)
  return out
}

function scanAll(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const classifier = scanKeys(readFileSync(path.join(DESKTOP, 'renderer/src/undokeys.ts'), 'utf8'))
  for (const f of sourceFiles()) {
    const text = readFileSync(path.join(DESKTOP, f), 'utf8')
    const keys = new Set([...scanKeys(text), ...historyBindingKeys(text, classifier)])
    if (keys.size) out.set(f, keys)
  }
  return out
}

const baseKey = (combo: string) => {
  const k = combo.split('+').pop()!
  return k === 'Space' ? ' ' : k === TYPEAHEAD ? k : norm(k)
}
const allEntries = (): Shortcut[] => [
  ...shortcutGroups('send').flatMap(g => g.items),
  ...shortcutGroups('newline').flatMap(g => g.items),
  ...BUILTIN,
]

/** bound keys with no entry naming their file */
function unlisted(scan: Map<string, Set<string>>, entries: Shortcut[]): string[] {
  const missing: string[] = []
  const excluded = new Set(NON_SHORTCUT_BINDINGS.flatMap(e =>
    e.keys.map(key => `${e.source}:${baseKey(key)}`)))
  for (const [file, keys] of scan) for (const key of keys) {
    if (!excluded.has(`${file}:${key}`)
      && !entries.some(e => e.sources.includes(file) && e.keys.some(c => baseKey(c) === key)))
      missing.push(`${file}: ${JSON.stringify(key)}`)
  }
  return missing
}

/** listed keys that no named file binds, and named files that bind none of the entry's keys */
function stale(scan: Map<string, Set<string>>, entries: Shortcut[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    for (const combo of e.keys) {
      if (!e.sources.some(f => scan.get(f)?.has(baseKey(combo))))
        out.push(`${e.action}: ${combo} is bound in none of ${e.sources.join(', ')}`)
    }
    for (const f of e.sources) {
      if (!e.keys.some(c => scan.get(f)?.has(baseKey(c))))
        out.push(`${e.action}: ${f} binds none of ${e.keys.join(', ')}`)
    }
  }
  return out
}

test('the scanner reads each binding form and ignores non-key comparisons', () => {
  const keys = scanKeys(`
    if (e.key === 'Escape') x()
    if (input.type === 'keyDown' && input.key === 'Escape') y()
    if (e.altKey && (e.key === 'n' || e.key === 'N')) z()
    if (!(event.ctrlKey) || event.key.toLowerCase() !== 'z') return
    if (['ArrowLeft', 'Home'].includes(e.key)) w()
    { label: 'Copy', accelerator: 'CmdOrCtrl+C' }
    if (e.key.length !== 1 || e.key === ' ') return
    if (e.key === STORAGE_KEY || e.key === null) read()
    if (f.key === 'sections' || key === 'codex') q()
  `)
  assert.deepEqual([...keys].sort(), [' ', TYPEAHEAD, 'ArrowLeft', 'Escape', 'Home', 'c', 'n', 'z'].sort())
  // a table counts only where a matcher reads it
  const table = `const T = [{ keys: ['F1'] }, { keys: ['Shift+F10'] }]`
  assert.deepEqual([...scanKeys(table)], [])
  assert.deepEqual([...scanKeys(table + ' T.find(r => r.keys.includes(key))')].sort(), ['F1', 'F10'])
  assert.deepEqual([...scanKeys(`const key = event.key.toLowerCase(); if (key === 'z' || key === 'y') run()`)].sort(), ['y', 'z'])
  assert.deepEqual([...scanKeys(`const key = 'z'; if (key === 'z') run()`)], [])
  const helper = `import { historyShortcut } from './undokeys';
    const keydown = event => { if (historyShortcut(event, doc) !== 'undo') return; run() };
    win.addEventListener('keydown', keydown)`
  assert.deepEqual([...historyBindingKeys(helper, new Set(['y', 'z']))], ['z'])
  assert.deepEqual([...historyBindingKeys(helper.replace("!== 'undo'", "=== null"), new Set(['y', 'z']))].sort(), ['y', 'z'])
  for (const broken of [helper.replace('import { historyShortcut }', 'import { somethingElse }'),
    helper.replace('historyShortcut(event, doc)', 'somethingElse(event, doc)'),
    helper.replace("addEventListener('keydown'", "addEventListener('click'")])
    assert.deepEqual([...historyBindingKeys(broken, new Set(['y', 'z']))], [])
})

test('the scan reaches the real bindings (not a vacuous pass)', () => {
  const scan = scanAll()
  assert.ok(scan.size >= 30, `bindings found in ${scan.size} files`)
  assert.ok(scan.get('renderer/src/canvas/desk.tsx')?.has('n'), 'desk Alt+N')
  assert.ok(scan.get('renderer/src/toasts.tsx')?.has('z'), 'toast Ctrl+Z')
  assert.equal(scan.get('renderer/src/toasts.tsx')?.has('y'), false, 'transient toast has no redo')
  assert.deepEqual([...scan.get('renderer/src/undokeys.ts') ?? []].sort(), ['y', 'z'], 'shared undo/redo classifier')
  assert.deepEqual([...scan.get('renderer/src/historyui.tsx') ?? []].sort(), ['y', 'z'], 'durable undo/redo listener')
  assert.ok(scan.get('main/editmenu.ts')?.has('c'), 'edit menu accelerator')
  assert.ok(scan.get('main/index.ts')?.has('Escape'), 'tray pop-up Escape')
  assert.ok(scan.get('renderer/src/canvas/docket.tsx')?.has(TYPEAHEAD), 'recipient typeahead')
})

test('every key the app binds is in the list, under the file that binds it', () => {
  assert.deepEqual(unlisted(scanAll(), allEntries()), [])
})

test('documented non-shortcut exclusions match their source file exactly', () => {
  const scan = scanAll()
  for (const exclusion of NON_SHORTCUT_BINDINGS) {
    assert.ok(exclusion.reason.trim(), `${exclusion.source} exclusion needs a reason`)
    assert.deepEqual([...exclusion.keys].sort(), [...(scan.get(exclusion.source) ?? [])].sort(),
      `${exclusion.source} key literals changed; review whether they are app shortcuts`)
    assert.ok(!allEntries().some(entry => entry.sources.includes(exclusion.source)),
      `${exclusion.source} cannot be both listed and excluded`)
  }
})

test('every listed key is still bound in a file the entry names', () => {
  for (const e of allEntries()) for (const f of e.sources)
    assert.ok(sourceFiles().includes(f), `${e.action}: ${f} does not exist`)
  assert.deepEqual(stale(scanAll(), allEntries()), [])
})

test('red control: a binding whose entry is removed is reported', () => {
  const scan = scanAll()
  const entries = allEntries().filter(e => !e.keys.includes('Alt+N'))
  assert.ok(unlisted(scan, entries).some(m => m.startsWith('renderer/src/canvas/desk.tsx: "n"')))
  const ghost: Shortcut = { keys: ['Mod+K'], action: 'ghost', sources: ['renderer/src/toasts.tsx'] }
  assert.ok(stale(scan, [ghost]).some(m => m.includes('Mod+K')))
})

test('composer rows follow the Enter key setting', () => {
  const rows = (b: 'send' | 'newline') =>
    shortcutGroups(b).find(g => g.title === 'Writing a message')!.items
  assert.deepEqual(rows('send').find(i => i.action === 'Send')!.keys, ['Enter', 'Mod+Enter'])
  assert.deepEqual(rows('send').find(i => i.action === 'New line')!.keys, ['Shift+Enter'])
  assert.deepEqual(rows('newline').find(i => i.action === 'Send')!.keys, ['Mod+Enter'])
  assert.deepEqual(rows('newline').find(i => i.action === 'New line')!.keys, ['Enter'])
})

test('key names are platform-correct', () => {
  assert.deepEqual(keyCaps('Mod+Enter', false), ['Ctrl', 'Enter'])
  assert.deepEqual(keyCaps('Mod+Enter', true), ['⌘', 'Enter'])
  assert.deepEqual(keyCaps('Alt+ArrowUp', true), ['⌥', '↑'])
  assert.deepEqual(keyCaps('Escape', false), ['Esc'])
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true)
  assert.equal(isMacPlatform({ platform: 'Win32' }), false)
})

test('the section renders every group as rows of keycaps', async () => {
  for (const mac of [false, true]) {
    const view = await mountView(<div className="settings"><ShortcutsSettings mac={mac} /></div>, el => el)
    try {
      await inAct(() => {})
      const heads = [...view.el.querySelectorAll('.set-group-head')].map(h => h.textContent)
      assert.deepEqual(heads, shortcutGroups().map(g => g.title))
      const undo = [...view.el.querySelectorAll('.set-row')]
        .find(r => r.querySelector('.set-label')?.textContent?.startsWith('Undo'))!
      assert.deepEqual([...undo.querySelectorAll('kbd')].map(k => k.textContent), [mac ? '⌘' : 'Ctrl', 'Z'])
      const redo = [...view.el.querySelectorAll('.set-row')]
        .find(r => r.querySelector('.set-label')?.textContent?.startsWith('Redo'))!
      assert.ok(redo, 'durable redo is explained alongside undo')
      assert.deepEqual([...redo.querySelectorAll('kbd')].map(k => k.textContent),
        ['Ctrl', 'Y', mac ? '⌘' : 'Ctrl', mac ? '⇧' : 'Shift', 'Z'])
      assert.equal(view.el.querySelectorAll('.set-row').length,
        shortcutGroups().reduce((n, g) => n + g.items.length, 0))
      assert.equal(view.el.querySelectorAll('input, select, button').length, 0, 'read-only: no controls')
    } finally { await view.unmount() }
  }
})
