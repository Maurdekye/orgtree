import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { open, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { TOKEN_HEADER } from './policy'
import type { LoginProvider, ProviderLoginStatus } from '../../../packages/contracts/index'

// Sign in to a provider CLI from the app (D-231), spawned HERE and only
// here. The engine (Python) may be a MANAGED child of this very process —
// in which case it already runs in this user's interactive session and
// spawning from either side would be fine — OR an ATTACHED boot-host
// engine started by the operator's scheduled task under Windows S4U
// (tools/boot-engine-task.ps1: `<LogonType>S4U</LogonType>`), which has NO
// interactive desktop to open a browser into and may not even be running
// as this user. `Engine.attach` in engine.ts prefers exactly that boot-host
// whenever one is publishing a verified descriptor, so "the engine is
// attached, not managed" is the ORDINARY case, not a rare one. This main
// process, by contrast, only exists because a user is running the desktop
// app interactively — there is no other way for it to start — so it is
// the one place a login child's browser-opening step is guaranteed to
// work. The engine still owns provider DETECTION (this module resolves the
// CLI path and verifies success by reading its existing `/api/providers` —
// never by spawning from its side). That route is NOT unauthenticated:
// launch.py's TokenGate wraps the whole ASGI app and requires
// X-Orgtree-Desktop-Token on every request — missed in the first pass, so
// every fetch here carries `engineToken` (the same credential engine.ts
// already holds for its own /api/desktop/* calls).

const PASTE_PROMPT = 'Paste code here if prompted > '
// mutable for tests only (`_setTimeoutMsForTests`) — production never
// changes this away from the real ceiling.
let TOTAL_TIMEOUT_MS = 300_000
const OUTPUT_TAIL = 4000
const VERIFY_RETRIES = 5
const VERIFY_RETRY_DELAY_MS = 200

interface Door {
  /** The provider id `/api/providers` uses — Codex's is "openai", Antigravity's
   *  is "google", never "codex"/"antigravity"; kept as an internal mapping so
   *  the REST of this module and the bridge's own vocabulary can stay in the
   *  user-facing name. */
  apiId: 'claude' | 'openai' | 'google'
  supportsCode: boolean
  extraArgs: string[]
}
const DOORS: Record<LoginProvider, Door> = {
  claude: { apiId: 'claude', supportsCode: true, extraArgs: ['auth', 'login', '--claudeai'] },
  codex: { apiId: 'openai', supportsCode: false, extraArgs: ['login'] },
  // extraArgs is unused for antigravity — it never goes through LoginSession
  // (see launchAntigravityTerminal below) — kept empty for the Door shape.
  antigravity: { apiId: 'google', supportsCode: false, extraArgs: [] },
}

/** The argv for spawning `exe` — a `.py` path (the test double,
 *  tests/providerlogin.test.mjs) runs under `python`, the same test-double
 *  convention the Python side already uses (`codex_argv`/`_login_argv`).
 *
 *  ⚠ `.cmd`/`.bat` (redteam-opus A2, measured on a real machine): Node's
 *  `child_process.spawn` REFUSES to exec a `.CMD`/`.BAT` file directly on
 *  Windows — it throws `EINVAL` before the file is ever read, because a
 *  batch file is not a real PE executable and needs cmd.exe to interpret
 *  it. This is exactly the shape `/api/providers`' `path` field is in
 *  practice whenever the private CLI pin is absent: `shutil.which('claude')`
 *  resolves the global npm install's `claude.CMD` shim
 *  (`providers.claude_install_state`'s own fallback order), which is the
 *  common case, not an edge one. `providers.py`'s `_claude_argv` already
 *  solves this for the engine's own spawns with `["cmd", "/c", exe]`; this
 *  mirrors that. Safe here specifically because the extra args are FIXED,
 *  short, code-controlled strings ("auth login --claudeai" / "login") —
 *  never the free-form, possibly-multiline agent prompts that make
 *  `supervisor._claude_argv` avoid `cmd /c` for TURN spawns. */
function resolveArgv(exe: string, extra: string[]): string[] {
  if (exe.toLowerCase().endsWith('.py')) return ['python', exe, ...extra]
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) return ['cmd', '/c', exe, ...extra]
  return [exe, ...extra]
}

/** Antigravity has no scriptable login door (investigated directly against
 *  the real CLI: `agy changelog` and `agy --help` for every subcommand —
 *  there is no headless/app-driven auth contract to spawn-and-pipe the way
 *  Claude's `--claudeai` code paste or Codex's local redirect server work).
 *  User-approved UX (2026-09-09, resolving the pending Antigravity
 *  decision): the app opens a VISIBLE terminal running the installed CLI's
 *  own normal interactive entry point — bare `agy`, no args — and the user
 *  signs in inside it exactly as if they had opened it themselves. There is
 *  nothing to pipe, detect or cancel from this side, so this is
 *  fire-and-forget and deliberately never becomes a `LoginSession`.
 *
 *  Windows-only: `start` is a cmd.exe builtin that opens a NEW, separate,
 *  console window and returns immediately — needed because this Electron
 *  process has no console of its own for a spawned console app to inherit
 *  (a GUI-subsystem app has none by default). The `""` is `start`'s own
 *  documented window-title slot; omitting it risks `start` mistaking a
 *  quoted command path for the title instead. This mirrors `resolveArgv`'s
 *  reasoning for why `.cmd`/`.bat` needs `cmd /c` at all, but goes one step
 *  further since the goal here is a visible, detached window, not a piped
 *  child. No other platform is covered — nothing elsewhere in this module
 *  has a non-Windows spawn path to mirror, and pretending one works without
 *  being able to verify it here would be worse than an honest error. */
// test-only seam, kept SEPARATE from the plain `spawn` import LoginSession
// itself uses (Claude/Codex still spawn genuinely hidden, piped children
// under test, unchanged): this is the one path in this module that
// intentionally pops a VISIBLE window, and the automated suite must never
// actually do that — it substitutes a no-window double here specifically.
// Production never calls the setter, so this is always the real `spawn`.
let terminalSpawn: typeof spawn = spawn
export function _setAntigravitySpawnForTests(fn: typeof spawn): void { terminalSpawn = fn }

// test-only seam for `killTree`'s external `taskkill` call (redteam-opus,
// measured on 2bf84b7): lets a test observe/count whether taskkill was
// actually invoked — e.g. to prove the `exited` guard genuinely suppresses
// it for a done session — without spawning a real `taskkill.exe`.
// Production never calls the setter, so this is always the real `spawn`.
let taskkillSpawn: typeof spawn = spawn
export function _setTaskkillSpawnForTests(fn: typeof spawn): void { taskkillSpawn = fn }

function launchAntigravityTerminal(exe: string): { started: boolean; error?: string } {
  if (process.platform !== 'win32') {
    return { started: false, error: 'opening a terminal is only supported on Windows' }
  }
  try {
    const child = terminalSpawn('cmd', ['/c', 'start', '""', exe], {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    child.unref()
    return { started: true }
  } catch (e) {
    return { started: false, error: e instanceof Error ? `failed to start: ${e.message}` : 'failed to start' }
  }
}

interface ProviderRow { id: string; status: { installed?: boolean; path?: string | null; connected?: boolean } }
async function fetchProviders(
  engineOrigin: string, engineToken: string, force = false, cancelSignal?: AbortSignal,
  forceProvider?: Door['apiId'],
): Promise<ProviderRow[]> {
  // ⚠ launch.py's TokenGate wraps the WHOLE app and requires this header on
  // EVERY request, not only /api/desktop/* — missed in the first pass
  // (nothing in api.py itself checks it, and that's as far as I'd read).
  // ⚠ `redirect: 'error'` — fetch() FOLLOWS redirects by default, which
  // would silently replay the token header at wherever a 3xx pointed
  // (engine.ts's own /api/desktop/* calls already refuse this the same
  // way; missed here in the first pass of the token fix).
  // ⚠ `force` (redteam-opus A3): codex_status/antigravity_status cache for
  // 60s. Post-login VERIFICATION must punch through that cache or a login
  // that just landed still reads the pre-login snapshot and reports
  // failure — measured against a real Codex sign-in.
  // ⚠ `forceProvider` (coordinator review, measured): a bare `force=true`
  // punches through BOTH caches, forcing a real Antigravity CLI probe
  // (measured up to ~45s) as a side effect of verifying a CLAUDE login
  // that has nothing to do with it. Naming the door being verified scopes
  // the punch-through to just that one — see providers_payload's docstring.
  // ⚠ `cancelSignal` (redteam-opus, measured on a615252): without this, a
  // cancel arriving mid-verification does not stop the retry loop — each
  // `force=true` read spawns a real provider CLI probe and measured
  // 1.9–5.6s, so an ignored cancel left several of those running to
  // completion for no reason after the user had already moved on. Combined
  // with the per-call timeout via `AbortSignal.any` (Node 20.3+, safe here
  // — Electron 44 bundles Node 24+) rather than replacing it.
  const timeoutSignal = AbortSignal.timeout(10000)
  const signal = cancelSignal ? AbortSignal.any([timeoutSignal, cancelSignal]) : timeoutSignal
  const query = force ? `?force=true${forceProvider ? `&force_provider=${forceProvider}` : ''}` : ''
  const r = await fetch(engineOrigin + '/api/providers' + query, {
    headers: { [TOKEN_HEADER]: engineToken },
    signal, redirect: 'error',
  })
  if (!r.ok) throw new Error(`providers lookup failed: ${r.status}`)
  const doc = await r.json() as { providers?: ProviderRow[] }
  return doc.providers ?? []
}

class LoginSession {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private awaitingCode = false
  private codeSent = false
  private done = false
  private ok: boolean | null = null
  private timedOut = false
  // ⚠ set the instant the OS reports this pid gone (redteam-opus,
  // measured on 2bf84b7): Node retains `this.proc.pid` after exit, and
  // `taskkill /pid` takes a bare number with no handle behind it — so
  // without this flag, `killTree()` on an already-exited session (e.g.
  // the quit handler's unconditional `cancelProviderLogin` after a
  // successful, still-cached login) hands taskkill a PID Windows may
  // have already recycled for an unrelated process, and `/t /f` kills
  // that process's whole tree too. `this.proc.kill()` itself is immune
  // to this — Node holds the real handle — only the external `taskkill`
  // call needs the guard.
  private exited = false
  private readonly startedAt = Date.now()
  private readonly timer: NodeJS.Timeout
  // ⚠ separate from the timeout/abort signals in providerlogin's module
  // scope — THIS one bounds the verification retry loop below (redteam-
  // opus, measured on a615252): without it, cancelling mid-verification
  // left up to VERIFY_RETRIES more `force=true` reads running to
  // completion in the background after the user had already moved on —
  // each one a real provider CLI probe, measured 1.9–5.6s apiece.
  private readonly cancelSignal = new AbortController()

  constructor(private readonly door: Door, argv: string[],
    private readonly engineOrigin: string, private readonly engineToken: string,
    private readonly profileDir?: string,
    private readonly accountId?: string) {
    // multi-account (D4): a PROFILE login runs the same CLI flow with the
    // provider's profile selector pointed at the account's directory —
    // sign-in-as-account is the parameterized form of the ambient flow,
    // never a different flow. Absent profileDir keeps ambient semantics
    // byte-for-byte.
    const env: NodeJS.ProcessEnv | undefined = profileDir
      ? { ...process.env,
          ...(this.door.apiId === 'openai'
            ? { CODEX_HOME: profileDir }
            : { CLAUDE_CONFIG_DIR: profileDir }) }
      : accountId && this.door.apiId === 'claude' ? { ...process.env } : undefined
    // An account without a directory selector is the imported default
    // Claude login; discard a host override before starting its login.
    if (env && accountId && !profileDir && this.door.apiId === 'claude') {
      delete env.CLAUDE_CONFIG_DIR
    }
    this.proc = spawn(argv[0], argv.slice(1),
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        ...(env ? { env } : {}) })
    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buf = (this.buf + chunk.toString('utf8')).slice(-OUTPUT_TAIL)
      if (this.door.supportsCode && !this.codeSent && this.buf.includes(PASTE_PROMPT)) this.awaitingCode = true
    })
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.buf = (this.buf + chunk.toString('utf8')).slice(-OUTPUT_TAIL)
    })
    this.proc.on('exit', code => { this.exited = true; void this.finish(code === 0) })
    this.proc.on('error', () => { this.exited = true; void this.finish(false) })
    this.timer = setTimeout(() => { this.timedOut = true; this.cancel() }, TOTAL_TIMEOUT_MS)
  }

  private async finish(exitedClean: boolean): Promise<void> {
    if (this.done) return
    clearTimeout(this.timer)
    let ok = exitedClean
    if (ok && this.accountId) {
      // a PROFILE login must verify against ITS OWN profile — the global
      // provider status describes the ambient login and would answer a
      // false positive (ambient already connected) or negative (profile
      // login invisible to it). The per-account identity endpoint reads
      // exactly the directory this session signed into.
      ok = false
      for (let i = 0; i < VERIFY_RETRIES && !this.cancelSignal.signal.aborted; i++) {
        try {
          const timeoutSignal = AbortSignal.timeout(10000)
          const signal = AbortSignal.any([timeoutSignal, this.cancelSignal.signal])
          const r = await fetch(
            this.engineOrigin + `/api/accounts/${this.accountId}/identity`,
            { headers: { [TOKEN_HEADER]: this.engineToken },
              signal, redirect: 'error' })
          if (r.ok) {
            const doc = await r.json() as { auth?: string }
            if (doc.auth === 'authenticated') { ok = true; break }
          }
        } catch { /* aborted, or engine mid-restart — bounded retry */ }
        if (this.cancelSignal.signal.aborted) break
        await new Promise(resolve => setTimeout(resolve, VERIFY_RETRY_DELAY_MS))
      }
    } else if (ok) {
      ok = false
      for (let i = 0; i < VERIFY_RETRIES && !this.cancelSignal.signal.aborted; i++) {
        try {
          const rows = await fetchProviders(
            this.engineOrigin, this.engineToken, true, this.cancelSignal.signal, this.door.apiId)
          const row = rows.find(p => p.id === this.door.apiId)
          if (row?.status.connected) { ok = true; break }
        } catch { /* aborted by cancel, or the engine may be mid-restart — either way, retry (bounded by the loop/signal) is the recovery */ }
        if (this.cancelSignal.signal.aborted) break
        await new Promise(resolve => setTimeout(resolve, VERIFY_RETRY_DELAY_MS))
      }
    }
    // ⚠ a concurrent `cancel()` may have already settled this (its own
    // `finish(false)` runs synchronously to completion — see `cancel`'s
    // comment) WHILE this call was suspended mid-verification above; its
    // late result must not overwrite what cancel already decided.
    if (this.done) return
    this.done = true
    this.ok = ok
    this.awaitingCode = false
  }

  sendCode(code: string): void {
    if (this.done || this.codeSent || !this.door.supportsCode) return
    this.codeSent = true
    this.awaitingCode = false
    // ⚠ the code is written to the child's stdin and NOWHERE else — never
    // appended to `this.buf`, never logged. Do not add a log line here.
    try { this.proc.stdin.write(code + '\n') } catch { /* a dead pipe is reported via exit, not here */ }
  }

  /** Kills the WHOLE process tree, not just `this.proc` (coordinator
   *  review — a real Windows gotcha): `resolveArgv` wraps a `.cmd`/`.bat`
   *  CLI as `cmd /c <exe>` (A2), which is the COMMON real shape (global
   *  npm install, no private pin) — so on that path `this.proc` IS
   *  cmd.exe, and `ChildProcess.kill()` only terminates that one PID.
   *  Windows gives no automatic teardown of processes a killed process
   *  spawned. Left to plain `.kill()`, a cancelled or timed-out login on
   *  the .cmd shape leaves the actual CLI process running underneath,
   *  still holding its own browser tab and stdin wait — exactly the
   *  orphan the charter rules out. `taskkill /t` kills the whole tree and
   *  is a no-op superset on a leaf process too, so this replaces plain
   *  kill() unconditionally rather than branching on whether THIS
   *  particular spawn happened to go through cmd. */
  private killTree(waitForExit = false): void {
    if (this.proc.pid == null || this.exited) return
    if (process.platform !== 'win32') {
      try { this.proc.kill() } catch { /* already gone */ }
      return
    }
    if (waitForExit) {
      // Quit must wait for taskkill: a detached kill can die with Electron.
      try { execFileSync('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'],
        { windowsHide: true, stdio: 'ignore', timeout: 5000 }) } catch { /* already exited or unavailable */ }
      return
    }
    try {
      taskkillSpawn('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { /* best effort — the process may already be gone */ })
    } catch { /* already gone */ }
  }

  cancel(waitForExit = false): void {
    this.cancelSignal.abort()
    this.killTree(waitForExit)
    // ⚠ don't wait for the process's own 'exit' event to settle the
    // session (redteam-opus A5, measured): Windows can take a moment to
    // actually tear a killed process down, and until it does the session
    // still reads 'starting' — which blocks a same-provider restart the
    // instant after a user clicks Cancel then Sign in again. `finish`
    // guards on `this.done`, so the REAL exit event arriving later is a
    // harmless no-op; this makes cancel instant instead of eventual.
    void this.finish(false)
  }

  snapshot(): ProviderLoginStatus {
    return {
      phase: this.done ? 'done' : this.awaitingCode ? 'awaiting_code' : 'starting',
      ok: this.ok,
      timedOut: this.timedOut,
      output: this.buf,
      ageMs: Date.now() - this.startedAt,
    }
  }
}

const sessions = new Map<LoginProvider, LoginSession>()
// ⚠ CLAIMED SYNCHRONOUSLY, before the first `await` below (redteam-opus
// A4, measured): the dedup check against `sessions` alone has a TOCTOU gap
// — two concurrent `startProviderLogin` calls for the same provider can
// both read "no existing session" before either has reached `sessions.set`
// (which sits after an `await fetchProviders`), and both spawn a child.
// `pending` closes that window: `has`+`set` happen with no `await` between
// them, so the second concurrent call always sees the first one's claim.
//
// ⚠ Also carries an AbortController (root's follow-up review of a615252,
// measured): cancelling while a start is STILL PENDING — the network
// fetch or the spawn itself hasn't resolved yet, so there is no
// LoginSession in `sessions` for `cancelProviderLogin` to find — used to
// be silently ignored; the pending start would go on to spawn a child
// anyway. The controller lets a concurrent cancel reach a start that
// hasn't produced a session yet.
const pending = new Map<LoginProvider, AbortController>()

async function verifyProfileWritable(profileDir: string): Promise<void> {
  // fs.access(W_OK) does not check Windows DACL write permission. Exercise
  // the actual desktop user's write before sending them through OAuth.
  const probe = path.join(profileDir, `.orgtree-login-write-${randomUUID()}`)
  const file = await open(probe, 'wx', 0o600)
  try { await file.writeFile('') }
  finally { await file.close(); await unlink(probe) }
}

export async function startProviderLogin(
  engineOrigin: string, engineToken: string, provider: LoginProvider,
  opts?: { profileDir?: string; accountId?: string },
): Promise<ProviderLoginStatus> {
  const existing = sessions.get(provider)
  if (existing) {
    const snap = existing.snapshot()
    if (snap.phase !== 'done') return { ...snap, started: false }
  }
  if (pending.has(provider)) {
    return { phase: 'starting', ok: null, timedOut: false, output: '', ageMs: 0, started: false }
  }
  const controller = new AbortController()
  pending.set(provider, controller)
  try {
    const door = DOORS[provider]
    if (opts?.profileDir) {
      try { await verifyProfileWritable(opts.profileDir) }
      catch {
        return { phase: 'error', ok: false, timedOut: false, output: '', ageMs: 0, started: false,
          error: 'The selected account profile is not writable. Its folder permissions must allow your Windows user before signing in.' }
      }
    }
    let rows: ProviderRow[]
    try {
      // the pending controller's signal ties the CLI-path lookup itself to
      // cancel, not just the check after it — cancelling while this is
      // still in flight ends the request immediately instead of leaving it
      // to run for up to its own 10s timeout for a result nobody reads.
      rows = await fetchProviders(engineOrigin, engineToken, false, controller.signal)
    } catch (e) {
      if (controller.signal.aborted) {
        return { phase: 'done', ok: false, timedOut: false, output: '', ageMs: 0, started: false, error: 'cancelled' }
      }
      return { phase: 'error', ok: false, timedOut: false, output: '', ageMs: 0, started: false,
        error: e instanceof Error ? e.message : 'could not reach the engine' }
    }
    if (controller.signal.aborted) {
      // ⚠ THE ONLY CHECK NEEDED, deliberately: everything from here to
      // `sessions.set` below — `resolveArgv` and `new LoginSession`'s own
      // constructor — is fully SYNCHRONOUS, no `await` anywhere in it. A
      // cancel arriving from another IPC call cannot interleave into a
      // synchronous stretch of code, so a second check after constructing
      // the session would only ever see what this one already saw. (A
      // first draft had that second check anyway — verified dead by hand:
      // removing it changed no test's outcome, because this check always
      // fires first when it fires at all.)
      return { phase: 'done', ok: false, timedOut: false, output: '', ageMs: 0, started: false, error: 'cancelled' }
    }
    const row = rows.find(p => p.id === door.apiId)
    const exe = row?.status.path
    if (!row?.status.installed || !exe) {
      return { phase: 'error', ok: false, timedOut: false, output: '', ageMs: 0, started: false, error: 'not-installed' }
    }
    if (provider === 'antigravity') {
      const launch = launchAntigravityTerminal(exe)
      if (!launch.started) {
        return { phase: 'error', ok: false, timedOut: false, output: '', ageMs: 0, started: false, error: launch.error }
      }
      // ⚠ `ok: null`, not `true` — nothing here VERIFIED a sign-in, only
      // that a terminal window was opened. `null` is the renderer's signal
      // to show "click Refresh once you're done" instead of a pass/fail
      // result; it never enters `sessions`, so `getProviderLoginStatus`/
      // `cancelProviderLogin` correctly see this as already idle again —
      // there is nothing left here for either of them to act on.
      return { phase: 'done', ok: null, timedOut: false, output: '', ageMs: 0, started: true }
    }
    let session: LoginSession
    try {
      session = new LoginSession(door, resolveArgv(exe, door.extraArgs),
        engineOrigin, engineToken, opts?.profileDir, opts?.accountId)
    } catch (e) {
      return { phase: 'error', ok: false, timedOut: false, output: '', ageMs: 0, started: false,
        error: e instanceof Error ? `failed to start: ${e.message}` : 'failed to start' }
    }
    sessions.set(provider, session)
    return { ...session.snapshot(), started: true }
  } finally {
    // ⚠ IDENTITY-CHECKED, not a bare delete (root's follow-up review,
    // measured): `cancelProviderLogin` may already have deleted THIS
    // entry — and by the time this `finally` runs, a brand-new
    // `startProviderLogin` call may have claimed the slot again with its
    // OWN controller. An unconditional `pending.delete(provider)` here
    // would clobber that newer claim, reopening the exact TOCTOU window
    // the `pending` map exists to close (A4). Only remove the entry if it
    // is still the one this call created.
    if (pending.get(provider) === controller) pending.delete(provider)
  }
}

export function getProviderLoginStatus(provider: LoginProvider): ProviderLoginStatus {
  const session = sessions.get(provider)
  if (!session) return { phase: 'idle', ok: null, timedOut: false, output: '', ageMs: 0 }
  return session.snapshot()
}

export function submitProviderLoginCode(provider: LoginProvider, code: string): ProviderLoginStatus {
  if (!DOORS[provider].supportsCode) throw new Error(`${provider} does not use a pasted code`)
  const session = sessions.get(provider)
  if (!session) throw new Error('no login in progress')
  const snap = session.snapshot()
  if (snap.phase === 'done') throw new Error('this login already finished — start a new one')
  const trimmed = code.trim()
  if (!trimmed) throw new Error('code is empty')
  if (trimmed.length > 2048) throw new Error('code is too long')
  session.sendCode(trimmed)
  return session.snapshot()
}

export function cancelProviderLogin(provider: LoginProvider, waitForExit = false): ProviderLoginStatus {
  const session = sessions.get(provider)
  if (session) {
    // ⚠ a session already `done` (redteam-opus, measured on 2bf84b7) has
    // no live process left to kill — most commonly a completed, still-
    // cached successful login that the quit handler's unconditional
    // `cancelProviderLogin('claude')`/`('codex')` now reaches on every
    // ordinary quit. `session.cancel()` would call `killTree()` on it
    // regardless; the `exited` guard inside `killTree()` already covers
    // this, but skipping `cancel()` entirely here is a second, cheaper
    // belt that needs no process-exit timing to be correct.
    if (session.snapshot().phase !== 'done') session.cancel(waitForExit)
    // ⚠ freed IMMEDIATELY (redteam-opus A5, measured), not left for a
    // later `startProviderLogin` to find via its own `phase === 'done'`
    // check — without this a cancel-then-retry within the same tick sees
    // the dying session still occupying the slot and is silently ignored
    // (`started: false`) even though the user explicitly asked to retry.
    sessions.delete(provider)
  }
  // ⚠ a start still PENDING (no session exists yet — see `pending`'s own
  // comment) must also hear this cancel, or it spawns a child anyway a
  // moment later with nothing left to stop it.
  const controller = pending.get(provider)
  if (controller) {
    controller.abort()
    // ⚠ freed IMMEDIATELY, same reasoning as A5 above (root's follow-up
    // review, measured): left in place, the entry would keep `pending.has`
    // true — and an IMMEDIATE retry blocked with `started:false` — until
    // the aborted call's own `finally` gets around to removing it, which
    // can be seconds away if it is mid-network-call. The aborted call's
    // `finally` is identity-checked against `controller`, so deleting here
    // first is safe: it will not later delete a NEWER claim this retry
    // makes for the same provider.
    pending.delete(provider)
  }
  return { phase: 'idle', ok: null, timedOut: false, output: '', ageMs: 0 }
}

/** Test-only: drop all session state between cases without a process restart. */
export function _resetForTests(): void { sessions.clear(); pending.clear() }
/** Test-only: shrink the timeout watchdog so a stuck-login test does not
 *  need to wait five real minutes. */
export function _setTimeoutMsForTests(ms: number): void { TOTAL_TIMEOUT_MS = ms }
