import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-tray-harnesses-'))
const out = path.join(temp, 'harnesses.cjs')
await build({ entryPoints: ['apps/desktop/main/harnesses.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
const { detectHarnesses, readHarnessRegistry, harnessSetupMenu } = createRequire(import.meta.url)(out)
const fallback = () => detectHarnesses('', {})
const labels = menu => menu.map(r => r.type === 'separator' ? '---' : r.label.split(':')[0])
const response = harnesses => ({ ok: true, json: async () => ({ harnesses }) })
const row = (id, name, installed, install_url) => ({ id, name, installed, install_url })
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))

test('offline fallback includes all five official setup actions in registry order', async () => {
  assert.equal(await readHarnessRegistry(null, '', () => { throw new Error('must not fetch') }), null)
  const opened = [], menu = harnessSetupMenu(null, fallback(), url => opened.push(url))
  assert.deepEqual(labels(menu), ['Claude Code', 'Codex', 'OpenCode (ACP)', 'Antigravity', 'Muse Code'])
  assert.ok(menu.every(r => r.label.includes('not detected') && typeof r.click === 'function'))
  menu.forEach(r => r.click())
  assert.deepEqual(opened.slice(2), ['https://opencode.ai/docs/', 'https://antigravity.google/download', 'https://dev.meta.ai/docs/muse-code#install'])
})

test('shell detection sees Muse and opencode fixtures without executing them', () => {
  for (const name of ['muse', 'opencode']) fs.writeFileSync(path.join(temp, name + (process.platform === 'win32' ? '.exe' : '')), 'not executable; presence only')
  const rows = detectHarnesses(temp, {})
  assert.equal(rows.find(r => r.id === 'muse').detected, true)
  assert.equal(rows.find(r => r.id === 'opencode').detected, true)
  assert.deepEqual(labels(harnessSetupMenu(null, rows, () => {})), ['OpenCode (ACP)', 'Muse Code', '---', 'Claude Code', 'Codex', 'Antigravity'])
})

test('registry detection and wording win; future entries appear and one separator splits groups', async () => {
  const rows = await readHarnessRegistry('http://127.0.0.1:7777', 'test-only', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:7777/api/harnesses')
    assert.equal(options.headers['X-Orgtree-Desktop-Token'], 'test-only')
    assert.equal(options.redirect, 'error'); assert.ok(options.signal)
    return response([row('claude-code', 'Claude Code', false, 'https://code.claude.com/docs/en/setup'), row('codex-cli', 'Codex', true, 'https://developers.openai.com/codex/cli'), row('opencode', 'OpenCode (ACP)', true, 'https://opencode.ai/docs/'), row('antigravity', 'Antigravity', false, 'https://antigravity.google/download'), row('muse', 'Muse Code', true, null), row('future', 'Future CLI', true, 'https://example.test/setup')])
  })
  const local = fallback().map(r => ({ ...r, detected: !rows.find(h => h.name === r.name)?.detected }))
  const opened = [], menu = harnessSetupMenu(rows, local, url => opened.push(url))
  assert.deepEqual(labels(menu), ['Codex', 'OpenCode (ACP)', 'Muse Code', 'Future CLI', '---', 'Claude Code', 'Antigravity'])
  menu.find(r => r.label?.startsWith('Muse Code')).click()
  assert.deepEqual(opened, ['https://dev.meta.ai/docs/muse-code#install'])
})

test('unreachable, old, malformed or unsafe registry falls back without unsafe actions', async () => {
  for (const request of [async () => { throw new Error('offline') }, async () => ({ ok: false }), async () => response([]), async () => response([row('muse', 'Muse Code', 'yes', null)]), async () => response([row('future', 'Future', true, 'file:///tmp/a')])]) {
    const rows = await readHarnessRegistry('http://127.0.0.1:7777', 'test-only', request)
    assert.equal(rows, null)
    assert.equal(harnessSetupMenu(rows, fallback(), () => {}).length, 5)
  }
})

test('partial older registry stays complete; no separator at either edge', () => {
  const partial = [{ id: 'codex-cli', name: 'Codex', url: 'https://developers.openai.com/codex/cli', detected: true }]
  const menu = harnessSetupMenu(partial, fallback(), () => {})
  assert.equal(menu.filter(r => r.type !== 'separator').length, 5)
  assert.equal(menu[0].label.startsWith('Codex: detected'), true)
  for (const detected of [false, true]) assert.equal(harnessSetupMenu(null, fallback().map(r => ({ ...r, detected })), () => {}).some(r => r.type === 'separator'), false)
})
