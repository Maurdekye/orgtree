import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-desktop-test-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const policy = await load('policy'), { Preferences } = await load('preferences'), { detectHarnesses } = await load('harnesses'), { NotificationGate } = await load('notifications')

const defaults = { notifyQuestions: true, notifyUrgentMail: true, notifyDocketAttention: true, notifyAllMail: false, notifyDocuments: false, notifyFrozen: false, notifyWhileFocused: false }

test('notification preferences migrate safely and every independent choice survives restart', () => {
  const file = path.join(temp, 'notifications.json')
  fs.writeFileSync(file, JSON.stringify({ routineNotifications: true, visualTheme: 'codex' }))
  const prefs = new Preferences(file)
  for (const [key, value] of Object.entries(defaults)) assert.equal(prefs.get()[key], key === 'notifyAllMail' ? true : value)
  for (const [key, value] of Object.entries(defaults)) {
    prefs.set({ [key]: !value })
    assert.equal(new Preferences(file).get()[key], !value)
    const bytes = fs.readFileSync(file, 'utf8')
    assert.throws(() => prefs.set({ [key]: 'true' }), /Invalid/)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
  prefs.set({ notifyAllMail: false })
  assert.equal(new Preferences(file).get().notifyAllMail, false, 'explicit off wins over legacy opt-in')
  assert.equal(new Preferences(file).get().visualTheme, 'codex')
})

test('preferences default close-to-tray/login and retain explicit off across reload', () => {
  const file = path.join(temp, 'prefs.json'), prefs = new Preferences(file)
  assert.deepEqual(prefs.get(), { ...defaults, visualTheme: 'orgtree', contrastTheme: 'charcoal', agentColorSource: 'provider', visualThemeExplicit: false, exitOnClose: false, startAtLogin: true, automaticUpdates: true, routineNotifications: false, onboarded: false })
  prefs.set({ exitOnClose: true, startAtLogin: false })
  assert.deepEqual(new Preferences(file).get(), { ...defaults, visualTheme: 'orgtree', contrastTheme: 'charcoal', agentColorSource: 'provider', visualThemeExplicit: false, exitOnClose: true, startAtLogin: false, automaticUpdates: true, routineNotifications: false, onboarded: false })
  // first-run setup completion persists like any preference and reloads
  assert.equal(prefs.set({ onboarded: true }).onboarded, true)
  assert.equal(new Preferences(file).get().onboarded, true)
  assert.throws(() => prefs.set({ onboarded: 'yes' }), /Invalid preference/)
  for (const bad of [[], null, { startAtLogin: 'false' }, { token: true }, { toString: true }]) assert.throws(() => prefs.set(bad))
  assert.equal(policy.closeAction(false, false), 'hide')
  assert.equal(policy.closeAction(true, false), 'quit')
  assert.equal(policy.closeAction(false, true), 'close')
  assert.equal(policy.closeAction(true, false, 1), 'hide', 'closing main cannot quit while another view remains')
  assert.equal(policy.closeAction(true, false, 0), 'quit', 'last visible view honors preference')
})
test('resolved v2 root refuses v1 root and overlap before any engine import', () => {
  const old = path.join(temp, 'v1'); fs.mkdirSync(old)
  const next = path.join(temp, 'v2')
  assert.equal(policy.validateDataRoot(next, old), path.join(fs.realpathSync.native(temp), 'v2'))
  for (const bad of [old, path.join(old, 'child'), temp, 'relative']) assert.throws(() => policy.validateDataRoot(bad, old))
})
test('readiness validates protocol, pid, port, exact absolute root; other log lines ignored', () => {
  const ready = { type: 'ready', protocol: 1, port: 1234, pid: 44, dataRootId: temp }
  assert.deepEqual(policy.parseReady(JSON.stringify(ready), temp, 44), ready)
  assert.equal(policy.parseReady('arbitrary log line', temp, 44), null)
  for (const delta of [{ protocol: 2 }, { pid: 45 }, { port: 0 }, { port: 65536 }, { port: '1234' }, { dataRootId: path.join(temp, 'other') }, { dataRootId: '.' }]) assert.throws(() => policy.parseReady(JSON.stringify({ ...ready, ...delta }), temp, 44))
})
test('auth covers HTTP WS assets and strips credentials on all other destinations', () => {
  const origin = 'http://127.0.0.1:4321'
  for (const url of [origin + '/api/orgs', origin + '/assets/index.js', 'ws://127.0.0.1:4321/api/orgs/test/ws']) assert.equal(policy.scopedHeaders({}, url, origin, 'secret')[policy.TOKEN_HEADER], 'secret')
  for (const url of ['http://127.0.0.1:4322/', 'http://localhost:4321/', 'https://example.com/', 'http://evil@127.0.0.1:4321/', 'file:///x', 'https://127.0.0.1:4321/']) assert.deepEqual(policy.scopedHeaders({ 'x-orgtree-desktop-token': 'old', Accept: '*/*' }, url, origin, 'secret'), { Accept: '*/*' })
  assert.equal(policy.trustedUiUrl(origin + '/#org', origin), true)
  assert.equal(policy.trustedUiUrl(origin + '/api/docs/hostile.html', origin), false)
  assert.equal(policy.trustedUiUrl('about:blank', origin), false)
  for (const route of ['/o/team', '/o/team@old']) assert.equal(policy.trustedUiUrl(origin + route, origin), true)
  for (const route of ['/o/', '/o/team/child', '/o/team%2fartifact', '/api/orgs/team/documents/x/mockup']) assert.equal(policy.trustedUiUrl(origin + route, origin), false)
  for (const url of ['http://example.com/path?q=1#top', 'https://docs.example.test/']) assert.equal(policy.externalHttpUrl(url), true)
  for (const url of ['about:blank', 'file:///tmp/x', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:test@example.com', 'https://user:pass@example.com/']) assert.equal(policy.externalHttpUrl(url), false)
})
test('harness detection has positive fixture and never executes it', () => {
  const name = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  fs.writeFileSync(path.join(temp, name), 'must never execute')
  const rows = detectHarnesses(temp, {})
  assert.equal(rows.find(r => r.id === 'codex').detected, true)
  assert.equal(rows.find(r => r.id === 'claude').detected, false)
  assert.equal(rows.length, 3)
  assert.equal(rows.find(r => r.id === 'antigravity').detected, false)
  fs.writeFileSync(path.join(temp, process.platform === 'win32' ? 'agy.exe' : 'agy'), 'presence only')
  assert.equal(detectHarnesses(temp, {}).find(r => r.id === 'antigravity').detected, true, 'actual AGY executable name')
  assert.equal(detectHarnesses('', { antigravity: path.join(temp, name) }).find(r => r.id === 'antigravity').detected, true, 'known native install location outside PATH')
})

test('native notification defaults are attention-only, with validated identity dedup', () => {
  const gate = new NotificationGate(), base = { id: 'n1', org: 'org', title: 'Title', body: 'Body', kind: 'routine' }
  assert.equal(gate.take(base, defaults), null)
  assert.ok(gate.take(base, { ...defaults, notifyAllMail: true }))
  assert.equal(gate.take(base, { ...defaults, notifyAllMail: true }), null)
  assert.ok(gate.take({ ...base, org: 'other' }, { ...defaults, notifyAllMail: true }), 'same local id in another org is distinct')
  for (const kind of ['question', 'urgent-mail', 'work-attention']) assert.ok(gate.take({ ...base, id: kind, kind }, defaults))
  for (const patch of [{ kind: 'arbitrary' }, { icon: 'file:///private' }, { body: 'x'.repeat(2001) }]) assert.throws(() => gate.take({ ...base, ...patch }, defaults))
})


test('all themes persist; invalid themes reject atomically and old preferences migrate', () => {
  const file = path.join(temp, 'theme-prefs.json')
  fs.writeFileSync(file, JSON.stringify({startAtLogin:false,exitOnClose:true}))
  const prefs = new Preferences(file)
  assert.equal(prefs.get().visualTheme, 'orgtree')
  const freshFile = path.join(temp, 'fresh.json'), legacyNeutral = path.join(temp, 'legacy-neutral.json'), legacyCodex = path.join(temp, 'legacy-codex.json')
  fs.writeFileSync(legacyNeutral, JSON.stringify({visualTheme:'orgtree'}))
  fs.writeFileSync(legacyCodex, JSON.stringify({visualTheme:'codex'}))
  assert.equal(new Preferences(freshFile).get().visualThemeExplicit, false)
  assert.equal(new Preferences(legacyNeutral).get().visualThemeExplicit, true)
  fs.writeFileSync(path.join(temp, 'legacy-unset.json'), JSON.stringify({visualTheme:'orgtree',visualThemeExplicit:false}))
  assert.equal(new Preferences(path.join(temp, 'legacy-unset.json')).get().visualThemeExplicit, false)
  for (const visualTheme of ['orgtree','claude','codex','antigravity','openrouter']) {
    prefs.set({visualTheme})
    assert.deepEqual(new Preferences(file).get(), {...defaults,visualTheme,contrastTheme:'charcoal',agentColorSource:'provider',visualThemeExplicit:true,startAtLogin:false,exitOnClose:true,automaticUpdates:true,routineNotifications:false,onboarded:false})
  }
  const bytes = fs.readFileSync(file, 'utf8')
  for (const visualTheme of ['unknown', '', true, null, {}, '__proto__']) {
    assert.throws(() => prefs.set({startAtLogin:true, visualTheme}))
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
})


test('contrast choices persist independently, migrate old files to Charcoal and reject invalid writes atomically', () => {
  const file = path.join(temp, 'contrast-prefs.json')
  fs.writeFileSync(file, JSON.stringify({visualTheme:'custom:#8435cf', startAtLogin:false}))
  const prefs = new Preferences(file)
  assert.equal(prefs.get().contrastTheme, 'charcoal')
  for (const contrastTheme of ['charcoal', 'light', 'solarized-light', 'obsidian-black']) {
    prefs.set({contrastTheme})
    const restored = new Preferences(file).get()
    assert.equal(restored.contrastTheme, contrastTheme)
    assert.equal(restored.visualTheme, 'custom:#8435cf')
    assert.equal(restored.visualThemeExplicit, true)
    assert.equal(restored.startAtLogin, false)
  }
  prefs.set({visualTheme:'codex'})
  assert.equal(new Preferences(file).get().contrastTheme, 'obsidian-black')
  const bytes = fs.readFileSync(file, 'utf8'), previous = prefs.get()
  for (const contrastTheme of ['unknown', '', true, null, {}, '__proto__']) {
    assert.throws(() => prefs.set({visualTheme:'claude', contrastTheme}), /Invalid contrast theme/)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    assert.deepEqual(prefs.get(), previous)
  }
  const fresh = new Preferences(path.join(temp, 'contrast-only-prefs.json'))
  fresh.set({contrastTheme:'light'})
  assert.equal(fresh.get().visualThemeExplicit, false, 'choosing brightness does not pin the detected accent')
})

test('agent coloring defaults to providers, persists both choices, and never changes theme or contrast', () => {
  const file = path.join(temp, 'agent-color-prefs.json')
  fs.writeFileSync(file, JSON.stringify({visualTheme:'custom:#8435cf', contrastTheme:'solarized-light', visualThemeExplicit:true}))
  const prefs = new Preferences(file)
  assert.equal(prefs.get().agentColorSource, 'provider')
  for (const agentColorSource of ['organization', 'provider']) {
    prefs.set({agentColorSource})
    const restored = new Preferences(file).get()
    assert.equal(restored.agentColorSource, agentColorSource)
    assert.equal(restored.visualTheme, 'custom:#8435cf')
    assert.equal(restored.contrastTheme, 'solarized-light')
  }
  const bytes = fs.readFileSync(file, 'utf8'), original = prefs.get()
  for (const agentColorSource of ['unknown', '', true, null, {}, '__proto__']) {
    assert.throws(() => prefs.set({visualTheme:'claude', agentColorSource}), /Invalid agent color source/)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    assert.deepEqual(prefs.get(), original)
  }
  const fresh = new Preferences(path.join(temp, 'agent-colors-only.json'))
  fresh.set({agentColorSource:'organization'})
  assert.equal(fresh.get().visualThemeExplicit, false)
})

test('automatic updates default on for old preferences and explicit off survives reload', () => {
  const file = path.join(temp, 'automatic-prefs.json')
  fs.writeFileSync(file, JSON.stringify({ startAtLogin: false }))
  const prefs = new Preferences(file)
  assert.equal(prefs.get().automaticUpdates, true)
  assert.equal(prefs.get().startAtLogin, false)
  prefs.set({ automaticUpdates: false })
  assert.equal(new Preferences(file).get().automaticUpdates, false)
  assert.throws(() => prefs.set({ automaticUpdates: 'false' }), /Invalid preference/)
  prefs.set({ automaticUpdates: true })
  assert.equal(new Preferences(file).get().automaticUpdates, true)
})
