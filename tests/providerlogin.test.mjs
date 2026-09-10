import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

// Sign in to a provider CLI from the app (D-231) — the process/handshake
// contract now lives in apps/desktop/main/providerlogin.ts (moved out of
// the Python engine: see its module docstring for why). Every case here
// spawns a FIXTURE CLI double (tests/fixtures/fake_*_login.py) via a real
// child process, never the real claude/codex binaries: no real login is
// started, no real browser opens, no real credential is touched. Success
// verification is checked against a LOCAL mock `/api/providers` server
// this file controls, exactly mirroring the real contract (main asks the
// engine's existing, unauthenticated `/api/providers` whether the sign-in
// actually landed — never the child's bare exit code).

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-providerlogin-test-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const providerlogin = await load('providerlogin')

const REPO = path.resolve('tests/fixtures')
const CLAUDE_FIXTURE = path.join(REPO, 'fake_claude_auth_login.py')
const CODEX_FIXTURE = path.join(REPO, 'fake_codex_login.py')
const CLAUDE_CMD_FIXTURE = path.join(REPO, 'fake_claude_auth_login.cmd')
// never a real path a real `cmd /c start` would try to launch — the
// antigravity spawn seam below is always substituted before this runs, so
// nothing ever actually execs this string.
const ANTIGRAVITY_FIXTURE = 'C:\\fake\\agy.exe'

// Antigravity opens a VISIBLE terminal window by design (user-approved UX,
// 2026-09-09) — the one path in this module the automated suite must never
// actually run for real, or every test run would pop a window. This double
// replaces the real spawn for that path ONLY; Claude/Codex still spawn
// genuinely hidden, piped fixture children exactly as above.
let antigravitySpawnImpl = () => ({ unref() {} })
const antigravitySpawnCalls = []
providerlogin._setAntigravitySpawnForTests((cmd, args, opts) => {
  antigravitySpawnCalls.push({ cmd, args, opts })
  return antigravitySpawnImpl(cmd, args, opts)
})

// Observes (but always forwards to) the real `taskkill` spawn inside
// `killTree` — lets a test prove taskkill was, or was not, actually
// invoked (redteam-opus BLOCKING, measured on 2bf84b7: killTree used to
// hand taskkill a done session's pid with no liveness check, and Windows
// can have already recycled that number for an unrelated process).
const taskkillSpawnCalls = []
providerlogin._setTaskkillSpawnForTests((cmd, args, opts) => {
  taskkillSpawnCalls.push({ cmd, args, opts })
  return spawn(cmd, args, opts)
})

// The real engine's launch.py wraps its WHOLE app in TokenGate, requiring
// X-Orgtree-Desktop-Token on every request — missed in the first pass of
// providerlogin.ts (nothing in api.py itself checks it, and that's as far
// as that pass had read). This mock ENFORCES the same gate — a positive
// control: a version of providerlogin.ts that forgets the header fails
// every test here with a 401, exactly as it would against the real engine,
// instead of silently passing against an unauthenticated stand-in.
const TOKEN = 'test-engine-token'

function providersServer(state, { forceDelayMs = 0 } = {}) {
  const requests = []
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, at: Date.now() })
      if (!request.url.startsWith('/api/providers') && !request.url.startsWith('/api/accounts/')) { response.writeHead(404); response.end(); return }
      if (request.headers['x-orgtree-desktop-token'] !== TOKEN) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ detail: 'invalid desktop token' }))
        return
      }
      if (request.url.startsWith('/api/accounts/')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ auth: state.profileAuth ?? 'unauthenticated' }))
        return
      }
      const respond = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          providers: [
            { id: 'claude', status: state.claude },
            { id: 'openai', status: state.codex },
            { id: 'google', status: state.antigravity },
          ],
        }))
      }
      // artificial delay ONLY on force=true reads — gives a test a
      // reliable window to cancel mid-verification-loop before the
      // response (and thus the loop's next iteration) lands
      if (forceDelayMs > 0 && request.url.includes('force=true')) setTimeout(respond, forceDelayMs)
      else respond()
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, requests }))
  })
}

async function eventually(predicate, { timeout = 8000, interval = 20, message = 'condition did not become true' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

function freshState() {
  return {
    claude: { installed: true, path: CLAUDE_FIXTURE, connected: false },
    codex: { installed: true, path: CODEX_FIXTURE, connected: false },
    antigravity: { installed: true, path: ANTIGRAVITY_FIXTURE, connected: false },
  }
}

let handle
test.beforeEach(async () => {
  handle = await providersServer(freshState())
  providerlogin._resetForTests()
  antigravitySpawnImpl = () => ({ unref() {} })
  antigravitySpawnCalls.length = 0
  taskkillSpawnCalls.length = 0
})
test.afterEach(async () => {
  providerlogin.cancelProviderLogin('claude')
  providerlogin.cancelProviderLogin('codex')
  providerlogin._resetForTests()
  await new Promise(resolve => handle.server.close(resolve))
})

test('claude: a wrong or missing desktop token is refused, matching the real TokenGate', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  const r = await providerlogin.startProviderLogin(handle.origin, 'not-the-real-token', 'claude')
  assert.equal(r.phase, 'error')
  assert.match(r.error, /401/)
})

test('claude: missing CLI is refused, not spawned', async () => {
  const state = freshState(); state.claude.installed = false; state.claude.path = null
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  const r = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(r.phase, 'error')
  assert.equal(r.error, 'not-installed')
  assert.equal((await providerlogin.getProviderLoginStatus('claude')).phase, 'idle')
})

test('claude: happy path reveals the code field then confirms via /api/providers, never the exit code alone', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude.json')
  const r = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(r.started, true)
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code',
    { message: 'fixture never reached the code prompt' })
  // the real contract: the ENGINE reports connected once the sign-in landed
  state.claude.connected = true
  const r2 = providerlogin.submitProviderLoginCode('claude', '123456')
  // sending the code clears `awaitingCode` immediately (we are no longer
  // waiting for one) — the snapshot reads 'starting' until the child exits
  assert.equal(r2.phase, 'starting')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  const final = await providerlogin.getProviderLoginStatus('claude')
  assert.equal(final.ok, true)
})

test('claude: exit 0 but /api/providers still says not connected is NOT treated as success (positive control)', async () => {
  const state = freshState() // connected stays false throughout
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'no_write'
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  providerlogin.submitProviderLoginCode('claude', 'anything')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  const final = await providerlogin.getProviderLoginStatus('claude')
  assert.equal(final.ok, false, 'a clean exit with no confirmed connection must read as failure')
})

test('claude: invalid code reports failure', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'invalid_code'
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  providerlogin.submitProviderLoginCode('claude', '000000')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  assert.equal((await providerlogin.getProviderLoginStatus('claude')).ok, false)
})

test('claude: the pasted code never appears in the captured output', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude2.json')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  const secret = 'super-secret-one-time-code-should-not-leak'
  providerlogin.submitProviderLoginCode('claude', secret)
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  const final = await providerlogin.getProviderLoginStatus('claude')
  assert.equal(final.output.includes(secret), false)
})

test('codex: has no code endpoint — submitting a code is refused', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success' // codex fixture blocks on stdout only, never asks for stdin
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'codex')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('codex')).phase === 'starting')
  assert.throws(() => providerlogin.submitProviderLoginCode('codex', '123456'))
  providerlogin.cancelProviderLogin('codex')
})

test('codex: immediate crash is reported, not hung', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'crash'
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'codex')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('codex')).phase === 'done')
  assert.equal((await providerlogin.getProviderLoginStatus('codex')).ok, false)
})

test('repeated start reuses the in-flight session instead of spawning a second child', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude3.json')
  const r1 = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(r1.started, true)
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  const r2 = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(r2.started, false)
  providerlogin.cancelProviderLogin('claude')
})

test('cancel reads back as idle immediately, not left hanging (updated for A5: cancel now frees the slot rather than lingering as done)', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude4.json')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  providerlogin.cancelProviderLogin('claude')
  // no `eventually` needed — cancel's own finish(false) call is synchronous
  // (see LoginSession.cancel's comment), and the slot is deleted in the
  // same call, so this must already be true, not eventually true
  assert.equal((await providerlogin.getProviderLoginStatus('claude')).phase, 'idle')
})

test('a hung login is killed by the timeout watchdog on its own', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude5.json')
  providerlogin._setTimeoutMsForTests(300)
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  // never submit a code — the watchdog must end it on its own
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done',
    { timeout: 5000, message: 'timeout watchdog never fired' })
  const final = await providerlogin.getProviderLoginStatus('claude')
  assert.equal(final.ok, false)
  assert.equal(final.timedOut, true)
  providerlogin._setTimeoutMsForTests(300_000)
})

test('cancel with no session in progress is a harmless no-op', async () => {
  const r = providerlogin.cancelProviderLogin('claude')
  assert.equal(r.phase, 'idle')
})

// ── redteam-opus A2/A3/A4/A5 — measured against 77ed6cb, fixed in 6aff5a8+1 ──

test('claude: a .cmd-resolved path (the common real shape — global npm install, no private pin) is spawned via cmd /c, not directly (A2)', async () => {
  // POSITIVE CONTROL, run once here so a regression is unmissable: Node
  // refuses to exec a .cmd directly on Windows at all.
  assert.throws(() => { spawn(CLAUDE_CMD_FIXTURE, ['x']) }, /EINVAL/)
  const state = freshState(); state.claude.path = CLAUDE_CMD_FIXTURE
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-cmd.json')
  const r = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(r.started, true)
  assert.notEqual(r.phase, 'error', `spawning the .cmd path must not fail: ${r.error}`)
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code',
    { message: 'the .cmd-wrapped fixture never reached the code prompt' })
  state.claude.connected = true
  providerlogin.submitProviderLoginCode('claude', '123456')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  assert.equal((await providerlogin.getProviderLoginStatus('claude')).ok, true)
})

test('claude: cancelling a .cmd-wrapped login kills the WHOLE process tree, not just the cmd.exe wrapper (owned cmd child-tree, coordinator review)', async () => {
  // ⚠ CANNOT use CLAUDE_CMD_FIXTURE/fake_claude_auth_login.py for this one:
  // measured directly (throwaway script, not this suite) that killing only
  // the wrapping cmd.exe still lets that fixture finish normally and write
  // its config — NOT because the grandchild survived unkilled, but because
  // it blocks on `sys.stdin.readline()`, and killing cmd.exe closes ITS
  // duplicate handle onto the inherited pipe, which is enough to hand the
  // grandchild an EOF and let it complete its own success path on its own.
  // A fixture whose liveness depends on stdin can't tell "orphaned but
  // alive" apart from "completed via EOF", so THIS fixture never touches
  // stdin at all — it just writes an incrementing heartbeat file, which
  // only a real kill (of it specifically, not just its parent) can stop.
  const heartbeat = path.join(temp, 'treekill-heartbeat.txt')
  fs.writeFileSync(heartbeat, '')
  const pyPath = path.join(temp, 'treekill_fixture.py')
  fs.writeFileSync(pyPath, [
    'import os, sys, time',
    'sys.stdout.write(f"pid:{os.getpid()}\\n")',
    'sys.stdout.write("Visit https://example.invalid/authorize?state=fixture in your browser to continue.\\n")',
    'sys.stdout.write("Paste code here if prompted > ")',
    'sys.stdout.flush()',
    `marker = r"${heartbeat}"`,
    'for i in range(150):',   // ~30s of heartbeats — well beyond this test's own window
    '    with open(marker, "a") as f:',
    '        f.write(str(i) + "\\n")',
    '    time.sleep(0.2)',
  ].join('\n'))
  const cmdPath = path.join(temp, 'treekill_fixture.cmd')
  fs.writeFileSync(cmdPath, `@echo off\r\npython "${pyPath}" %*\r\n`)

  const state = freshState(); state.claude.path = cmdPath
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  const linesAtCancel = fs.readFileSync(heartbeat, 'utf8').trim().split('\n').length
  assert.ok(linesAtCancel >= 1, 'setup: the heartbeat fixture must actually be running before cancel')
  providerlogin.cancelProviderLogin('claude', true)
  // give taskkill a moment, then confirm the heartbeat has genuinely
  // stopped advancing — not just that the app's OWN bookkeeping moved on
  const linesAfterGrace = fs.readFileSync(heartbeat, 'utf8').trim().split('\n').length
  await new Promise(resolve => setTimeout(resolve, 800))
  const linesLater = fs.readFileSync(heartbeat, 'utf8').trim().split('\n').length
  assert.equal(linesLater, linesAfterGrace,
    `the real CLI process kept running after cancel — killing only the cmd.exe wrapper leaves an orphan (heartbeat: ${linesAfterGrace} then ${linesLater} lines)`)
})

test('cancelling an already-completed session never runs taskkill — its real pid may already be recycled (redteam-opus BLOCKING, measured on 2bf84b7)', async () => {
  // The bug this guards: a completed session STAYS in `sessions` (nothing
  // removes it on success), and the app-quit handler calls
  // `cancelProviderLogin('claude')`/`('codex')` UNCONDITIONALLY on every
  // quit — "sign in, keep working, quit later" is the ordinary case, not
  // a rare one. Without a liveness guard, that path hands `taskkill /pid`
  // a long-dead pid Windows may have already reused for an unrelated
  // process, and `/t /f` kills that process's whole tree too.
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-done-cancel.json')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  state.claude.connected = true
  providerlogin.submitProviderLoginCode('claude', '123456')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  assert.equal((await providerlogin.getProviderLoginStatus('claude')).ok, true,
    'setup: the session must have actually completed successfully before this test cancels it')
  taskkillSpawnCalls.length = 0
  // mirrors exactly what the before-quit handler does on every ordinary quit
  providerlogin.cancelProviderLogin('claude')
  assert.equal(taskkillSpawnCalls.length, 0,
    `a completed session's real process already exited; taskkill must never be invoked against its (possibly recycled) pid: ${JSON.stringify(taskkillSpawnCalls)}`)
})

test('claude: the post-login verification read forces a fresh /api/providers, never the 60s cache (A3)', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-force.json')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  state.claude.connected = true
  providerlogin.submitProviderLoginCode('claude', '123456')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
  assert.ok(handle.requests.some(r => r.url.includes('force=true')),
    `no verification request carried force=true — requests seen: ${JSON.stringify(handle.requests)}`)
  assert.ok(handle.requests.some(r => r.url.includes('force_provider=claude')),
    `verification never named the provider it was checking, forcing every provider's cache as a side effect — requests seen: ${JSON.stringify(handle.requests)}`)
})

test('two concurrent starts for the same provider spawn exactly one child, not two (A4)', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-concurrent.json')
  const [r1, r2] = await Promise.all([
    providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude'),
    providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude'),
  ])
  const started = [r1, r2].filter(r => r.started === true)
  assert.equal(started.length, 1, `expected exactly one spawn, got: ${JSON.stringify([r1, r2])}`)
  providerlogin.cancelProviderLogin('claude')
})

test('cancel frees the slot immediately — a retry right after cancel is not silently ignored (A5)', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-retry.json')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  providerlogin.cancelProviderLogin('claude')
  // no `eventually` here on purpose — the whole point is this must work
  // in the SAME tick as cancel, not after waiting for an exit event
  const retry = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(retry.started, true, 'a start immediately after cancel must not be silently ignored')
  providerlogin.cancelProviderLogin('claude')
})

test('cancelling a login that is still PENDING (no session exists yet) stops it from ever spawning (root follow-up review of a615252)', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-cancel-pending.json')
  // NOT awaited: this call is still resolving fetchProviders() (an async
  // network round-trip) when the very next line runs, so it is genuinely
  // PENDING — no LoginSession/entry in `sessions` exists for it yet.
  const startPromise = providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  providerlogin.cancelProviderLogin('claude')
  const result = await startPromise
  assert.equal(result.started, false, 'a login cancelled while pending must not report started')
  assert.equal(result.error, 'cancelled')
  // and nothing was left running or registered because of it
  assert.equal((await providerlogin.getProviderLoginStatus('claude')).phase, 'idle')
  // proves the slot is truly free, not just reporting idle while still occupied
  const retry = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(retry.started, true)
  providerlogin.cancelProviderLogin('claude')
})

test('an immediate retry is not blocked while the cancelled attempt\'s own fetch is still outstanding (root follow-up review of a615252)', async () => {
  const state = freshState()
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-retry-outstanding.json')
  const firstStart = providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude') // not awaited
  providerlogin.cancelProviderLogin('claude') // aborts it; its fetchProviders() may still be in flight
  // retry BEFORE awaiting firstStart — the real scenario is a second click
  // before the first attempt's network call has settled, not after
  const retryResult = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  assert.equal(retryResult.started, true,
    'a retry issued before the cancelled attempt\'s own fetch resolved must not be blocked')
  const firstResult = await firstStart
  assert.equal(firstResult.started, false)
  assert.equal(firstResult.error, 'cancelled')
  // the retry's own session must still be the one tracked, not clobbered
  // by the first (cancelled) call's belated cleanup
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  providerlogin.cancelProviderLogin('claude')
})

test('cancel during the post-exit verification loop stops it — no further force=true reads after cancel (redteam-opus, measured on a615252)', async () => {
  const state = freshState() // connected stays false: the loop keeps retrying rather than succeeding on read 1
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state, { forceDelayMs: 150 })
  process.env.FIXTURE_MODE = 'success'
  process.env.FIXTURE_CONFIG_PATH = path.join(temp, 'claude-cancel-verify.json')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude')
  await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
  providerlogin.submitProviderLoginCode('claude', '123456')
  // let the verification loop actually begin (its first force=true request lands)
  await eventually(() => handle.requests.filter(r => r.url.includes('force=true')).length >= 1)
  const countAtCancel = handle.requests.filter(r => r.url.includes('force=true')).length
  providerlogin.cancelProviderLogin('claude')
  // several retry-cycles' worth of time — without the fix the loop would
  // have fired all VERIFY_RETRIES (5) requests well within this window
  await new Promise(resolve => setTimeout(resolve, 1200))
  const finalCount = handle.requests.filter(r => r.url.includes('force=true')).length
  assert.ok(finalCount <= countAtCancel + 1,
    `verification loop kept running after cancel: ${countAtCancel} force=true requests at cancel time, ${finalCount} after waiting 1.2s (expected at most one straggler already in flight)`)
})

// ── Antigravity: user-approved UX (2026-09-09) — a visible terminal, not a
// spawn-and-pipe door. No `awaiting_code`/`starting` phase exists for it:
// providerlogin.ts resolves the instant a terminal opens, unverified. ──

test('antigravity: sign-in opens a detached terminal via cmd /c start and resolves immediately with ok:null (no verification loop)', async () => {
  const r = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'antigravity')
  assert.equal(r.started, true)
  assert.equal(r.phase, 'done')
  assert.equal(r.ok, null, 'antigravity never verifies a sign-in — ok must stay null, not true/false')
  assert.equal(antigravitySpawnCalls.length, 1)
  const call = antigravitySpawnCalls[0]
  assert.equal(call.cmd, 'cmd')
  assert.deepEqual(call.args, ['/c', 'start', '""', ANTIGRAVITY_FIXTURE])
  assert.equal(call.opts.detached, true)
  assert.equal(call.opts.windowsHide, false, 'the whole point is a VISIBLE window — windowsHide must be false')
  // nothing is tracked in `sessions` for it — confirms this never goes
  // through the same machinery a real verification loop would poll
  assert.equal((await providerlogin.getProviderLoginStatus('antigravity')).phase, 'idle')
})

test('antigravity: missing CLI is refused, no terminal is ever launched', async () => {
  const state = freshState(); state.antigravity.installed = false; state.antigravity.path = null
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  const r = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'antigravity')
  assert.equal(r.phase, 'error')
  assert.equal(r.error, 'not-installed')
  assert.equal(antigravitySpawnCalls.length, 0)
})

test('antigravity: a spawn failure is reported as an error, not a hang (positive control for the catch branch)', async () => {
  antigravitySpawnImpl = () => { throw new Error('no shell available') }
  const r = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'antigravity')
  assert.equal(r.phase, 'error')
  assert.equal(r.started, false)
  assert.match(r.error, /no shell available/)
})

test('antigravity: has no code door — submitting a code is refused', async () => {
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'antigravity')
  assert.throws(() => providerlogin.submitProviderLoginCode('antigravity', '123456'))
})

test('antigravity: cancel with nothing tracked is a harmless no-op, before or after opening the terminal', async () => {
  assert.equal(providerlogin.cancelProviderLogin('antigravity').phase, 'idle')
  await providerlogin.startProviderLogin(handle.origin, TOKEN, 'antigravity')
  assert.equal(providerlogin.cancelProviderLogin('antigravity').phase, 'idle')
})


for (const provider of ['claude', 'codex']) {
  for (const profileOk of [true, false]) {
    test(`${provider}: redirected login verifies its own account despite opposite ambient status (${profileOk})`, async () => {
      const state = freshState()
      state[provider].connected = !profileOk
      state.profileAuth = profileOk ? 'authenticated' : 'unauthenticated'
      await new Promise(resolve => handle.server.close(resolve))
      handle = await providersServer(state)
      const profileDir = path.join(temp, `profile-${provider}-${profileOk}`)
      fs.mkdirSync(profileDir, { recursive: true })
      const probe = path.join(temp, `profile-env-${provider}-${profileOk}.json`)
      const oldProbe = process.env.FIXTURE_PROFILE_PROBE
      process.env.FIXTURE_PROFILE_PROBE = probe
      process.env.FIXTURE_MODE = 'no_write'
      try {
        await providerlogin.startProviderLogin(handle.origin, TOKEN, provider, { profileDir, accountId: 'selected-account' })
        if (provider === 'claude') {
          await eventually(async () => (await providerlogin.getProviderLoginStatus(provider)).phase === 'awaiting_code')
          providerlogin.submitProviderLoginCode(provider, 'fixture-only')
        }
        await eventually(async () => (await providerlogin.getProviderLoginStatus(provider)).phase === 'done')
        assert.equal((await providerlogin.getProviderLoginStatus(provider)).ok, profileOk)
        const env = JSON.parse(fs.readFileSync(probe, 'utf8'))
        assert.equal(env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], profileDir)
        assert.ok(handle.requests.some(r => r.url === '/api/accounts/selected-account/identity'))
        assert.equal(handle.requests.some(r => r.url.includes('force=true')), false)
      } finally {
        if (oldProbe === undefined) delete process.env.FIXTURE_PROFILE_PROBE
        else process.env.FIXTURE_PROFILE_PROBE = oldProbe
      }
    })
  }
}

test('an unwritable profile is reported before launching browser authentication', async () => {
  const profileDir = path.join(temp, 'not-a-profile-directory')
  fs.writeFileSync(profileDir, 'fixture-only')
  const result = await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude',
    { profileDir, accountId: 'selected-account' })
  assert.equal(result.started, false)
  assert.equal(result.phase, 'error')
  assert.match(result.error, /profile is not writable/)
  assert.equal(handle.requests.length, 0)
  assert.equal(providerlogin.getProviderLoginStatus('claude').phase, 'idle')
})


test('default Claude account login strips inherited selector and verifies selected account', async () => {
  const state = freshState()
  state.claude.connected = false
  state.profileAuth = 'authenticated'
  await new Promise(resolve => handle.server.close(resolve))
  handle = await providersServer(state)
  const probe = path.join(temp, 'default-profile-env.json')
  const oldProbe = process.env.FIXTURE_PROFILE_PROBE
  const oldSelector = process.env.CLAUDE_CONFIG_DIR
  process.env.FIXTURE_PROFILE_PROBE = probe
  process.env.CLAUDE_CONFIG_DIR = 'hostile-profile'
  process.env.FIXTURE_MODE = 'no_write'
  try {
    await providerlogin.startProviderLogin(handle.origin, TOKEN, 'claude', { accountId: 'selected-account' })
    await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'awaiting_code')
    providerlogin.submitProviderLoginCode('claude', 'fixture-only')
    await eventually(async () => (await providerlogin.getProviderLoginStatus('claude')).phase === 'done')
    assert.equal((await providerlogin.getProviderLoginStatus('claude')).ok, true)
    const env = JSON.parse(fs.readFileSync(probe, 'utf8'))
    assert.ok(!env.CLAUDE_CONFIG_DIR)
    assert.ok(handle.requests.some(r => r.url === '/api/accounts/selected-account/identity'))
  } finally {
    if (oldProbe === undefined) delete process.env.FIXTURE_PROFILE_PROBE
    else process.env.FIXTURE_PROFILE_PROBE = oldProbe
    if (oldSelector === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldSelector
  }
})


test('native login validation accepts every implemented provider and rejects unknown inputs', () => {
  for (const provider of ['claude', 'codex', 'antigravity']) {
    assert.equal(providerlogin.asLoginProvider(provider), provider)
  }
  for (const unknown of ['google', 'openai', 'constructor', '__proto__', '', null, {}, 1]) {
    assert.throws(() => providerlogin.asLoginProvider(unknown), /Unknown login provider/)
  }
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(main, /import \{ asLoginProvider,.*from '\.\/providerlogin'/)
  assert.equal((main.match(/asLoginProvider\(provider\)/g) ?? []).length, 4,
    'start, status, code and cancel all use the tested validator')
})
