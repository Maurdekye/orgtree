// Real presence scan and startup popup, with synthetic paths and no CLI execution.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { build, transformSync } from 'esbuild'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-harness-presence-'))
const out = path.join(root, 'harnesses.cjs')
await build({ entryPoints: ['apps/desktop/main/harnesses.ts'], outfile: out,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
const { detectHarnesses } = createRequire(import.meta.url)(out)
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

for (const kind of ['native', 'npm', 'missing']) {
  test(`desktop detects ${kind} Claude with empty PATH and a synthetic user profile`, t => {
    const profile = path.join(root, kind)
    const appdata = path.join(profile, 'AppData', 'Roaming')
    const localdata = path.join(profile, 'AppData', 'Local')
    const file = kind === 'npm' ? path.join(appdata, 'npm', 'claude.cmd')
      : path.join(profile, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (kind !== 'missing') fs.writeFileSync(file, 'presence-only fixture, never execute')
    t.mock.method(os, 'homedir', () => profile)
    const values = { APPDATA: appdata, LOCALAPPDATA: localdata,
      ORGTREE_MUSE_BIN: '', ORGTREE_CODEX: '', ORGTREE_ANTIGRAVITY: '' }
    const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]))
    try {
      Object.assign(process.env, values)
      assert.equal(detectHarnesses('').find(h => h.id === 'claude').detected,
        kind === 'native' || (kind === 'npm' && process.platform === 'win32'))
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
}

const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
const start = index.indexOf('      // Not awaited: start-up')
const end = index.indexOf('      const refresh = async () => {', start)
assert.ok(start >= 0 && end > start, 'execute the actual startup popup block')
const startup = transformSync(index.slice(start, end), { loader: 'ts', target: 'node22' }).code
const rows = detected => [{ id: 'claude-code', name: 'Claude Code', detected, url: 'https://example.test' }]
async function popup({ registry, local, background = false, closed = false }) {
  const messages = []
  let reads = 0
  vm.runInNewContext(startup, {
    process: { argv: background ? ['--background'] : [] }, quitting: false,
    first: { window: { isDestroyed: () => closed } },
    engine: { harnesses: async () => { reads++; return registry } },
    detectHarnesses: () => rows(local),
    dialog: { showMessageBox: async (_window, message) => { messages.push(message.message) } },
  })
  await new Promise(resolve => setImmediate(resolve))
  return { messages, reads }
}

test('startup prefers a working engine harness over a stale desktop PATH', async () => {
  assert.deepEqual(await popup({ registry: rows(true), local: false }), { messages: [], reads: 1 })
})
test('startup uses known local presence when the engine registry is unavailable', async () => {
  assert.deepEqual((await popup({ registry: null, local: true })).messages, [])
})
test('startup still warns when the engine confirms no harness', async () => {
  assert.deepEqual((await popup({ registry: rows(false), local: true })).messages, ['No agent harness was detected.'])
})
test('startup warns with no registry and no local harness', async () => {
  assert.deepEqual((await popup({ registry: null, local: false })).messages, ['No agent harness was detected.'])
})
test('background startup does not read or display the setup warning', async () => {
  assert.deepEqual(await popup({ registry: rows(false), local: false, background: true }), { messages: [], reads: 0 })
})
test('a window closed during the registry read receives no popup', async () => {
  assert.deepEqual((await popup({ registry: rows(false), local: false, closed: true })).messages, [])
})
