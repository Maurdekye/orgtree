import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { artifactThemeKeeper, type ThemedContents } from '../../main/frametheme'

// "Open in a new window" shows an HTML presentation in a native viewer with
// no app bridge. Native injects the same --orgtree-* colors the inline reader
// posts into its frame, and replaces them in place on a theme switch (USER
// 2026-10-27 m4e1fae02a0ca, m164909566caf).

declare const __SRC_DIR__: string

/** A viewer's webContents reduced to what the keeper uses. Each load is a new
 *  document without our sheet; an insertion lands in the document that was
 *  current when it started, after `delay` ms. */
function viewer(delay = 0) {
  const listeners = new Map<string, Array<() => void>>()
  let next = 0, destroyed = false, documentId = 0
  const sheets = new Map<string, string>(), calls: string[] = []
  const contents: ThemedContents & { emit(event: string): void; destroy(): void } = {
    insertCSS: (css) => {
      calls.push('insert')
      const key = 'sheet-' + ++next, into = documentId
      return new Promise(resolve => setTimeout(() => { if (into === documentId) sheets.set(key, css); resolve(key) }, delay))
    },
    removeInsertedCSS: async (key) => { calls.push('remove'); sheets.delete(key) },
    isDestroyed: () => destroyed,
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    once: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    emit: (event) => {
      if (event === 'dom-ready') { documentId++; sheets.clear() }
      for (const listener of listeners.get(event) ?? []) listener()
    },
    destroy: () => { destroyed = true; contents.emit('destroyed') },
  }
  return { contents, sheets: () => [...sheets.values()], calls }
}
const settle = (ms = 10) => new Promise(r => setTimeout(r, ms))
const dark = { colorScheme: 'dark', colors: { accent: '#d97757', accentSoft: 'rgba(217, 119, 87, 0.16)', bg: '#1f1f1f' } }
const light = { colorScheme: 'light', colors: { accent: '#89391f', bg: '#f6f7f9' } }
const DARK_CSS = ':where(:root){--orgtree-accent:#d97757;--orgtree-accent-soft:rgba(217, 119, 87, 0.16);--orgtree-bg:#1f1f1f;--orgtree-color-scheme:dark}'
const LIGHT_CSS = ':where(:root){--orgtree-accent:#89391f;--orgtree-bg:#f6f7f9;--orgtree-color-scheme:light}'

test('a presentation window gets the colors once its page is ready, and a theme switch replaces them in place', async () => {
  const themes = artifactThemeKeeper(), v = viewer()
  themes.set(dark)
  themes.follow(v.contents)
  await settle()
  assert.deepEqual(v.calls, [], 'nothing before the page exists')
  v.contents.emit('dom-ready'); await settle()
  assert.deepEqual(v.sheets(), [DARK_CSS])
  themes.set(light); await settle()
  assert.deepEqual(v.sheets(), [LIGHT_CSS], 'one sheet: the old one is removed')
  const calls = v.calls.length
  themes.set(light); await settle()
  assert.equal(v.calls.length, calls, 'an unchanged report does nothing')
  v.contents.emit('dom-ready'); await settle()
  assert.deepEqual(v.sheets(), [LIGHT_CSS], 'a reloaded page is painted again')
})

test('a switch or a reload while a sheet is still being inserted never leaves the older colors or two sheets', async () => {
  const themes = artifactThemeKeeper(), v = viewer(20)
  themes.set(dark); themes.follow(v.contents); v.contents.emit('dom-ready')
  await settle(5)
  themes.set(light)
  await settle(80)
  assert.deepEqual(v.sheets(), [LIGHT_CSS], 'the newer colors land last')
  v.contents.emit('dom-ready')
  await settle(5)
  themes.set(dark)
  await settle(5)
  v.contents.emit('dom-ready')
  await settle(120)
  assert.deepEqual(v.sheets(), [DARK_CSS], 'the current document holds exactly the current sheet')
})

test('a malformed report is refused and changes nothing; a closed window is forgotten', async () => {
  const themes = artifactThemeKeeper(), v = viewer()
  themes.set(dark); themes.follow(v.contents); v.contents.emit('dom-ready'); await settle()
  for (const bad of [null, 'dark', { colorScheme: 'dim', colors: {} }, { colorScheme: 'dark', colors: { bogus: '#000000' } },
    { colorScheme: 'dark', colors: { bg: '#1f1f1f;}body{display:none' } }, { colorScheme: 'dark', colors: { bg: 'red' } },
    { colorScheme: 'dark', colors: { bg: 'rgba(300, 0, 0, 0.5)' } }, { colorScheme: 'dark', colors: {}, extra: 1 }]) {
    assert.throws(() => themes.set(bad), /Unknown frame theme/, JSON.stringify(bad))
  }
  await settle()
  assert.deepEqual(v.sheets(), [DARK_CSS])
  v.contents.destroy()
  const calls = v.calls.length
  themes.set(light); await settle()
  assert.equal(v.calls.length, calls, 'a closed viewer is not painted')
})

test('native follows every presentation window before it loads, and the bridge reports colors on its own channel', () => {
  const desktop = path.join(__SRC_DIR__, '..', '..')
  const main = readFileSync(path.join(desktop, 'main', 'index.ts'), 'utf8')
  const preload = readFileSync(path.join(desktop, 'preload', 'index.ts'), 'utf8')
  assert.match(main, /handleApp\('desktop:set-frame-theme', value => artifactThemes\.set\(value\)\)/)
  const open = main.slice(main.indexOf('const openArtifact = (url: string) => {'))
  const follow = open.indexOf('artifactThemes.follow(viewer.webContents)'), load = open.indexOf('viewer.loadURL(url)')
  assert.ok(follow > 0 && follow < load, 'the viewer is followed before its page loads')
  assert.match(preload, /setFrameTheme: theme => ipcRenderer\.invoke\('desktop:set-frame-theme', theme\)/)
})
