// THE UPDATE REHEARSAL — drives the app's own in-app update route end to end
// against an isolated loopback feed, with the harmless fixture standing in for
// an installer.
//
//   node tools/package-rehearsal.mjs                   (once, to build the target)
//   node tools/build-update-fixture.mjs                (once, to build the fixture)
//   node tools/run-rehearsal.mjs                       (the rehearsal itself)
//
// See docs/update-rehearsal.md for the operator walkthrough.
//
// ⚠ WHAT THIS DOES NOT DO, SAID UP FRONT. It installs nothing, elevates
// nothing, publishes nothing, and never touches the installed release, its data
// root or its uninstall key. It serves one directory on loopback, launches one
// executable it packaged itself, and stops only processes running out of that
// directory. Every one of those limits is enforced by tools/rehearsal-isolation.mjs
// and exercised by tests/update-rehearsal.test.mjs.
//
// ⚠ AND IT CANNOT FORCE THE APPLY. The in-app route fires on the application's
// own automatic path: automatic updates enabled, an idle organization, and
// powerMonitor.getSystemIdleTime() at sixty seconds or more — a full minute
// with no keyboard or mouse input on this machine. That last condition is not
// the rehearsal's to fake; faking it would mean the rehearsal no longer
// exercised the thing it exists to exercise. So: START IT AND LEAVE THE
// MACHINE ALONE. If the budget expires without a handoff, this reports exactly
// that rather than reporting a rehearsal that did not happen.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

import { isLoopbackFeedUrl, serveFeed, writeFeed } from './private-update-feed.mjs'
import {
  assertDestinationSafe, assertFixtureProvenance, assertNotElevated, assertRehearsalComposition,
  assertStorageSafe, releaseAll,
  assertRehearsalPackage, assertRehearsalTarget, compareSnapshots, DEFAULT_REHEARSAL_OUT,
  installedRootsFromRegistry, isInside, isolationChecks, isRehearsalProcessPath, overlaps,
  processesWithPaths, productionDataRoot, realPath, rehearsalDataRoot, releaseRehearsal,
  REHEARSAL_UPDATER_CACHE, report, reserveRehearsal, resolveInstalledRoot, snapshot,
} from './rehearsal-isolation.mjs'

export { REHEARSAL_UPDATER_CACHE }
export const FIXTURE_VERSION = '9.9.9-fixture'
export const DEFAULT_BUDGET_MS = 300000

/** ⚠ THE PATH GATE, SEPARATED SO IT CAN RUN BEFORE ANYTHING IS CREATED.
 *
 *  Review measured the ordering bug this exists to fix: the feed directory was
 *  written — copying the artifact into it — BEFORE the plan was consulted, so
 *  `--work "C:\Program Files\Orgtree\…"` wrote into the installation and only
 *  then got refused. A gate that runs after the first write is not a gate.
 *
 *  Every path the rehearsal will touch is checked here, with no filesystem and
 *  no network, so main() can call it as its very first act. */
export function assertRehearsalPaths({
  outDir, exe, fixture, workDir, env = process.env, installedRoot = null,
  installedRoots = [], fileSystem = fs,
}) {
  const resolvedOut = path.resolve(outDir)
  const resolvedExe = assertRehearsalTarget({
    exe, outDir: resolvedOut, env, installedRoot, installedRoots, fileSystem,
  })
  const resolvedFixture = path.resolve(fixture)
  const resolvedWork = workDir === undefined || workDir === null ? null : path.resolve(workDir)
  const where = { env, installedRoot, installedRoots, fileSystem }

  // ⚠ ONE POLICY, EVERY MUTABLE DESTINATION — physically, both directions,
  // against installations AND production data. These used to be three
  // differently-worded checks against two different lists, and the gaps between
  // them were exactly what review walked through.
  assertDestinationSafe('update artifact', resolvedFixture, where)
  // The working directory receives the feed (with a copy of the artifact in
  // it), the baseline and the evidence.
  if (resolvedWork !== null) assertDestinationSafe('rehearsal working directory', resolvedWork, where)

  const dataRoot = rehearsalDataRoot(env)
  const production = productionDataRoot(env)
  // ⚠ PHYSICAL, NOT LEXICAL. A junction at "Orgtree v2 Dev" pointing at
  // "Orgtree v2" is one directory with two names, and comparing the spellings
  // accepted it — after which the rehearsal would have run on the user's own
  // data through the dev name.
  if (overlaps(dataRoot, production, fileSystem)) {
    throw new Error(`the rehearsal data root [${dataRoot}] and the production data root `
      + `[${production}] are the same physical directory, or one contains the other `
      + `([${realPath(dataRoot, fileSystem)}] vs [${realPath(production, fileSystem)}])`)
  }

  return {
    outDir: resolvedOut,
    exe: resolvedExe,
    fixture: resolvedFixture,
    workDir: resolvedWork,
    dataRoot,
    productionDataRoot: production,
    updateLog: path.join(dataRoot, 'update-log.json'),
  }
}

/** ⚠ EVERY REFUSAL IN ONE PLACE, and pure so the tests can drive it with
 *  production-shaped inputs and watch it refuse. main() executes exactly the
 *  plan this returns, so a rule proved here is a rule the rehearsal obeys —
 *  rather than a rule written down next to code that does something else.
 *
 *  The paths are re-checked here rather than trusted from the earlier pass: the
 *  cost is nothing and it means this function is a complete gate on its own.
 *
 *  Throws with the reason. Returns the plan when everything is safe. */
export function planRehearsal({
  outDir, exe, fixture, workDir, feedUrl, packagedInfo,
  env = process.env, installedRoot = null, installedRoots = [],
  isLoopback = isLoopbackFeedUrl, fileSystem = fs,
}) {
  if (!isLoopback(feedUrl)) {
    throw new Error(`refusing to rehearse against [${feedUrl}]: the feed must be an `
      + 'isolated loopback URL, so a private test can never reach a public release feed')
  }
  assertRehearsalPackage(packagedInfo)
  const paths = assertRehearsalPaths({
    outDir, exe, fixture, workDir, env, installedRoot, installedRoots, fileSystem,
  })
  return { ...paths, feedUrl, version: packagedInfo.version }
}

/** ⚠ ONLY LOG ENTRIES FROM *THIS* RUN COUNT.
 *
 *  The update log is append-only and lives in a data root that may survive from
 *  an earlier rehearsal, so the watcher was reading somebody else's history as
 *  its own result. Review measured it: a handoff entry dated in the year 2000,
 *  with no receipt at all, produced exit 0 and "the fixture update was applied".
 *
 *  An entry with no timestamp, or one that cannot be parsed, is treated as OLD.
 *  That is the safe direction — the failure mode of the strict reading is a run
 *  reported as not-applied when it was, and the failure mode of the loose one
 *  is a rehearsal that never happened being reported as a success. */
export function isFreshEntry(entry, since) {
  const at = Date.parse(entry?.at ?? '')
  return Number.isFinite(at) && at >= since
}

export const HANDOFF_STAGES = ['update-fixture-handoff', 'update-fixture-completed']

/** ⚠ AND A LOG LINE IS NOT A RESULT. The fixture writes a receipt whose LAST
 *  record is `[fixture-complete] <token>`, written only after everything else
 *  succeeded and carrying the token of the attempt that produced it. Requiring
 *  a matching pair means the claim rests on the fixture's own terminal record
 *  rather than on the app's account of having launched something. */
export function receiptToken(body) {
  const lines = String(body ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const complete = lines[lines.length - 1]?.match(/^\[fixture-complete\]\s+(\S+)$/)
  if (!complete) return null
  const declared = lines.find(line => line.startsWith('[fixture-token]'))
    ?.match(/^\[fixture-token\]\s+(\S+)$/)
  // The terminal record must agree with the token the same receipt declares:
  // a truncated or hand-edited receipt does not get to certify a run.
  return declared && declared[1] === complete[1] ? complete[1] : null
}

/** ⚠ WHICH FILE WOULD PROVE *THIS* ATTEMPT — read out of the app's own handoff
 *  record, not guessed from what is lying in the data directory.
 *
 *  This is the binding review required. The token is minted per attempt by the
 *  app; the app now names the receipt path it gave the fixture, so the runner
 *  knows the one file that can settle this attempt before that file exists.
 *  Without it, "a recent file whose two internal lines agree" was the whole
 *  test — which an unpublished `.txt.partial`, or a receipt from an unrelated
 *  attempt, satisfies just as well. */
export function expectedReceiptFrom(detail) {
  const match = String(detail ?? '')
    .match(/its receipt for this attempt is \[([^\]]+)\]/)
  return match ? match[1] : null
}

export function receiptTokenFromName(file) {
  // Exactly the published shape. `update-fixture-<token>.txt.partial` — which
  // the fixture writes BEFORE its error check and rename, and deletes if either
  // fails — does not match, and must not: announcing completion for a receipt
  // the fixture explicitly never published is the failure this prevents.
  return path.basename(String(file ?? '')).match(/^update-fixture-(.+)\.txt$/)?.[1] ?? null
}

/** The complete admission test for a receipt, as a pure function so every
 *  rejection can be driven directly. Returns {ok, reason, token}. */
export function judgeReceipt({
  file, body, mtimeMs, expectedPath, startedAt, unpacked, fixture,
}) {
  const no = (reason) => ({ ok: false, reason, token: null })
  if (!expectedPath) {
    return no('this run observed no handoff naming a receipt path, so no file can prove it')
  }
  if (path.resolve(file).toLowerCase() !== path.resolve(expectedPath).toLowerCase()) {
    return no(`[${file}] is not the receipt this attempt named (${expectedPath})`)
  }
  const nameToken = receiptTokenFromName(file)
  if (!nameToken) return no(`[${file}] is not a published receipt (an unpublished partial?)`)
  const token = receiptToken(body)
  if (!token) return no('the receipt has no terminal [fixture-complete] agreeing with its token')
  if (token !== nameToken) {
    return no(`the receipt's token [${token}] does not match its own filename [${nameToken}]`)
  }
  if (!(mtimeMs >= startedAt)) return no('the receipt predates this run')
  // Written by the fixture from what it was ACTUALLY given, so these tie the
  // receipt to this run's directories rather than to any rehearsal's.
  const lines = String(body ?? '').split(/\r?\n/).map(line => line.trim())
  const instdir = lines.find(l => l.startsWith('[fixture-instdir]'))?.slice('[fixture-instdir]'.length).trim()
  if (!instdir || path.resolve(instdir).toLowerCase() !== path.resolve(unpacked).toLowerCase()) {
    return no(`the receipt reports install directory [${instdir}], not this run's [${unpacked}]`)
  }
  const cmdline = lines.find(l => l.startsWith('[fixture-cmdline]')) ?? ''
  if (!cmdline.toLowerCase().includes(path.resolve(fixture).toLowerCase())) {
    return no('the receipt does not name this run\'s fixture in its command line')
  }
  return { ok: true, reason: null, token }
}

/** Cleanup is deletion, so it gets its own guard. Only the two directories the
 *  rehearsal itself creates may be removed, identified by their own names —
 *  never the production data root, never anything passed in by accident. */
export function assertRemovable(target, { env = process.env } = {}) {
  const resolved = path.resolve(String(target ?? ''))
  const allowed = [
    path.resolve(rehearsalDataRoot(env)),
    path.resolve(path.join(env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE)),
  ]
  if (!allowed.some(a => a.toLowerCase() === resolved.toLowerCase())) {
    throw new Error(`refusing to remove [${resolved}]: rehearsal cleanup may only remove `
      + `the rehearsal's own data root and updater cache`)
  }
  return resolved
}

// ------------------------------------------------------------------ helpers

/** ⚠ ENUMERATED BY PATH, NOT BY NAME. Filtering on '*Orgtree*' missed this
 *  run's own engine and its helpers, which run out of the same directory under
 *  names like python.exe — so cleanup left them alive. Everything inside the
 *  output directory is this run's; nothing outside it ever is. */
function stopRehearsalProcesses(outDir) {
  const stopped = []
  for (const proc of processesWithPaths()) {
    if (!isRehearsalProcessPath(proc.Path, outDir)) continue
    stopped.push({ id: proc.Id, name: proc.ProcessName, path: proc.Path })
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Stop-Process -Id ${Number(proc.Id)} -Force -ErrorAction SilentlyContinue`],
      { encoding: 'utf8', windowsHide: true })
  }
  return stopped
}

// --------------------------------------------------------------------- main
//
// ⚠ EVERY EFFECT IS INJECTABLE, AND THAT IS NOT A STYLE CHOICE. Two review
// rounds found defects here that pure-predicate tests and source-shape
// assertions both passed over, because the bugs were in the COMPOSITION —
// what got written before what was checked, what got stopped when nothing had
// been started, which file was believed. tests/update-rehearsal.test.mjs runs
// this exact function with inert filesystem, process and feed effects and
// asserts on the launches, writes, deletions and result it produces. Nothing in
// those tests can start a real process or touch a real directory.

/** The real effects. Replaced wholesale by the tests. */
export function realEffects() {
  return {
    fileSystem: fs,
    spawnProcess: spawn,
    runPowerShell: (script) => execFileSync('powershell', ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true }),
    stopProcess: (id) => spawnSync('powershell', ['-NoProfile', '-Command',
      `Stop-Process -Id ${Number(id)} -Force -ErrorAction SilentlyContinue`],
      { encoding: 'utf8', windowsHide: true }),
    writeFeed,
    serveFeed,
    now: () => Date.now(),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    isAlive: (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } },
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  }
}

function value(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const fx = { ...realEffects(), ...injected }
  const {
    fileSystem, spawnProcess, runPowerShell, stopProcess, now, sleep, env, out, err, repoRoot,
  } = fx

  const outDir = path.resolve(repoRoot, value(argv, '--out', DEFAULT_REHEARSAL_OUT))
  const exe = path.join(outDir, 'win-unpacked', 'Orgtree Dev.exe')
  const unpacked = path.join(outDir, 'win-unpacked')
  const fixture = path.resolve(repoRoot,
    value(argv, '--fixture', 'dist/update-fixture/orgtree-update-fixture.exe'))
  const workDir = path.resolve(repoRoot, value(argv, '--work', 'dist/rehearsal'))
  const budgetMs = Number(value(argv, '--budget', String(DEFAULT_BUDGET_MS / 1000))) * 1000
  const keep = argv.includes('--keep')
  // ⚠ --adopt IS AN EXPLICIT STATEMENT THAT THE EXISTING DEV STORAGE IS YOURS
  // TO USE. Without it, a pre-existing dev data root or updater cache refuses
  // the run: a rehearsal wears the dev identity, so that storage may belong to
  // somebody's ordinary dev build, and running ON it is worse than the earlier
  // bug of merely declining to delete it. With it, nothing there is deleted.
  const adopt = argv.includes('--adopt')
  // ⚠ RECOVERY IS DELIBERATE, NEVER AUTOMATIC. A claim whose owner is gone is
  // probably a crashed rehearsal — but "probably" is how two live runs both
  // acquired in the version review measured. This flag is the operator saying
  // they have checked.
  const reclaim = argv.includes('--reclaim')
  // ⚠ --dry-run EXISTS SO THE GUARDS CAN BE EXERCISED WITHOUT THE REHEARSAL.
  // A real run needs a minute of untouched machine, which makes it the wrong
  // thing to reach for when what you want to know is whether this machine is in
  // a state where rehearsing would be safe. Everything up to and including the
  // plan, the preflight and the baseline happens; nothing is launched.
  const dryRun = argv.includes('--dry-run')

  for (const [label, target, hint] of [
    ['the rehearsal build', exe, 'node tools/package-rehearsal.mjs'],
    ['the update fixture', fixture, 'node tools/build-update-fixture.mjs'],
  ]) {
    if (!fileSystem.existsSync(target)) {
      err(`${label} is missing at ${target}\n  build it first:  ${hint}`)
      return 2
    }
  }

  const evidence = { at: new Date(now()).toISOString(), steps: [] }
  const step = (name, detail) => {
    evidence.steps.push({ name, detail })
    out(`· ${name}\n    ${detail}`)
  }

  // ⚠ EVERYTHING THAT CAN BE JUDGED BEFORE A SINGLE BYTE IS WRITTEN IS JUDGED
  // HERE. The feed directory receives a copy of the artifact, so creating it
  // before this ran meant a refused --work had already written into whatever it
  // named. Elevation is refused here too, for the same reason.
  let paths
  let installedRoot
  let installedRoots
  let packagedInfo
  try {
    assertNotElevated(runPowerShell)
    installedRoot = resolveInstalledRoot({ env, run: runPowerShell })
    installedRoots = installedRootsFromRegistry({ run: runPowerShell })
    paths = assertRehearsalPaths({
      outDir, exe, fixture, workDir, env, installedRoot, installedRoots, fileSystem,
    })
    // ⚠ THE STORAGE IS JUDGED HERE TOO, AND --adopt CANNOT WAIVE IT. Adoption
    // says existing rehearsal storage is yours to reuse; it cannot say that
    // storage may be a junction into Program Files or into the production data
    // directory. Review measured both of those launching and returning zero.
    const storage = assertStorageSafe({ env, installedRoot, installedRoots, fileSystem })
    step('the rehearsal storage is outside every protected location',
      `data root ${storage.dataRoot}\n    updater cache ${storage.updaterCache}`)
    packagedInfo = assertRehearsalComposition(unpacked, fileSystem)
    const provenance = assertFixtureProvenance(paths.fixture, { repoRoot, fileSystem })
    step('the artifact is this repository\'s fixture',
      `sha256 ${provenance.sha256.slice(0, 16)}…, built from ${provenance.source}`)
  } catch (error) {
    err(`REFUSED: ${error?.message ?? error}`)
    err('Nothing was created, launched, stopped or removed.')
    return 1
  }

  // ⚠ THE RESERVATION COMES BEFORE THE FEED, because it is the thing that makes
  // "every process under the output directory is mine" safe against a SECOND
  // rehearsal starting a moment from now — which no snapshot of running
  // processes can see.
  let reservation
  try {
    reservation = reserveRehearsal(paths.outDir, {
      fileSystem, env, isAlive: fx.isAlive, pid: fx.pid ?? process.pid, reclaim,
    })
    step('reserved', reservation.claims.map(c => `${c.file} (${c.taken})`).join('\n    '))
  } catch (error) {
    err(`REFUSED: ${error?.message ?? error}`)
    err('Nothing was created, launched, stopped or removed.')
    return 1
  }

  let server = null
  let plan
  let child
  let exitCode = 1
  let preexistingDataRoot = true
  let preexistingCache = true
  let dryRunComplete = false
  // Set by cleanup when a process would not die or residue could not be
  // removed. Applied to the exit code after the comparison, so both still run.
  let cleanupFailed = false
  // ⚠ NOTHING DESTRUCTIVE HAPPENS UNLESS A LAUNCH ACTUALLY HAPPENED. Review
  // measured both halves of this: a refused plan still reached Stop-Process
  // with the UNVALIDATED output directory, and --dry-run — which promises it
  // launched nothing — stopped a pre-existing process and deleted an existing
  // updater cache. Cleanup now only ever cleans up after something this run did.
  let launched = false
  try {
    fileSystem.mkdirSync(paths.workDir, { recursive: true })
    const written = fx.writeFeed({
      directory: path.join(paths.workDir, 'feed'),
      artifact: paths.fixture,
      version: FIXTURE_VERSION,
      releaseDate: new Date(now()).toISOString(),
    })
    server = await fx.serveFeed(written.directory)
    evidence.feed = server.url
    out(`· loopback feed ${server.url} offering ${written.version} `
      + `(${written.file}, ${written.size} bytes)`)

    // ⚠ THE PLAN IS THE GATE. Nothing below launches anything until every
    // refusal in planRehearsal has declined to fire.
    plan = planRehearsal({
      outDir, exe, fixture, workDir, feedUrl: server.url, packagedInfo, env,
      installedRoot, installedRoots, fileSystem,
    })
    step('plan accepted', `${plan.version} from ${plan.exe}\n    data root ${plan.dataRoot}`)

    const pre = isolationChecks({
      feed: server.url, env, installedRoot, run: runPowerShell, fileSystem,
      isLoopback: isLoopbackFeedUrl, outDir: plan.outDir, adopt,
    })
    // Recorded, not just acted on: the evidence file should say WHICH check
    // stopped a run, rather than leaving that only in the console output of a
    // session nobody kept.
    evidence.preflight = pre
    if (!report(pre, { label: 'before launch', out, err })) {
      throw new Error('preflight isolation checks failed; nothing was launched: '
        + pre.filter(row => !row.ok).map(row => `${row.name} — ${row.detail}`).join(' | '))
    }
    const baseline = snapshot({ env, installedRoot, run: runPowerShell, fileSystem })
    // ⚠ WHAT WAS ALREADY THERE DECIDES WHAT CLEANUP MAY DELETE. With --adopt the
    // operator has said this storage is theirs to reuse; this run still removes
    // only what it created.
    preexistingDataRoot = baseline.rehearsalDataExists
    preexistingCache = baseline.rehearsalCacheExists
    fileSystem.writeFileSync(path.join(plan.workDir, 'baseline.json'),
      JSON.stringify({ at: new Date(now()).toISOString(), snapshot: baseline }, null, 2))
    step('baseline captured', path.join(plan.workDir, 'baseline.json'))

    if (dryRun) {
      step('DRY RUN — nothing was launched',
        'every guard and every isolation check passed; a real run would start '
        + `${plan.exe} now. No process was stopped and nothing was removed.`)
      // ⚠ NOT `return` — the comparison in `finally` can still fail, and a
      // return here would capture 0 before it ran and report success over the
      // top of it. Measured by review.
      exitCode = 0
      dryRunComplete = true
    }

    if (!dryRunComplete) await attempt()

    // ⚠ THE LAUNCH AND EVERYTHING THAT WATCHES IT. A function rather than a
    // straight line so the dry run can decline it WITHOUT returning early:
    // returning from inside the try captured the exit code before `finally`
    // could fail the comparison, and review measured a dry run reporting 0 over
    // the top of a failed one.
    async function attempt() {
      // ⚠ THE CLOCK STARTS BEFORE THE LAUNCH, not after, and it is the floor for
      // what counts as this run's evidence. A log entry or receipt older than
      // this belongs to some earlier rehearsal that shared the data root.
      const startedAt = now()

      // --background suppresses the main window. The environment carries the feed
      // and the fixture; a build not composed for rehearsal ignores both.
      child = spawnProcess(plan.exe, ['--background'], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...env, ORGTREE_UPDATE_FEED: plan.feedUrl, ORGTREE_UPDATE_FIXTURE: plan.fixture },
      })
      launched = true
      // ⚠ A SPAWN FAILURE ARRIVES ASYNCHRONOUSLY and the surrounding try/catch
      // cannot see it: without this listener a failed launch became an
      // uncaughtException, and the run would otherwise sit out its whole budget
      // waiting for a process that never started.
      let spawnError = null
      child.on('error', (error) => { spawnError = error })
      child.unref?.()
      step('rehearsal launched', `pid ${child.pid}, --background`)
      out(`\n  ⚠ LEAVE THE MACHINE ALONE NOW. The apply needs 60 seconds of no\n`
        + `    keyboard or mouse input; the budget is ${Math.round(budgetMs / 1000)}s.\n`)

      // ⚠ THE RECEIPT THIS ATTEMPT NAMED, AND ONLY THAT ONE. The app records the
      // receipt path it handed the fixture, so the file that can settle this
      // attempt is known before it exists. Freshness plus two agreeing lines
      // inside a file was not identity: review drove an unpublished
      // `.txt.partial` with a complete-looking body, and an unrelated recent
      // receipt, straight through to exit 0.
      let expectedReceipt = null
      let rejected = null
      const judge = () => {
        if (!expectedReceipt || !fileSystem.existsSync(expectedReceipt)) return null
        let body
        let mtimeMs
        try {
          body = fileSystem.readFileSync(expectedReceipt, 'utf8')
          mtimeMs = fileSystem.statSync(expectedReceipt).mtimeMs
        } catch { return null }
        const verdict = judgeReceipt({
          file: expectedReceipt, body, mtimeMs, expectedPath: expectedReceipt,
          startedAt, unpacked: path.join(plan.outDir, 'win-unpacked'), fixture: plan.fixture,
        })
        if (!verdict.ok) { rejected = verdict.reason; return null }
        return { file: expectedReceipt, body, token: verdict.token }
      }

      const seen = new Set()
      let handedOff = false
      let receipt = null
      const deadline = now() + budgetMs
      while (now() < deadline && !receipt && !spawnError) {
        await sleep(3000)
        if (fileSystem.existsSync(plan.updateLog)) {
          let entries = []
          try { entries = JSON.parse(fileSystem.readFileSync(plan.updateLog, 'utf8')) }
          catch { entries = [] }
          for (const entry of Array.isArray(entries) ? entries : []) {
            const key = `${entry.stage}:${entry.at ?? ''}`
            if (seen.has(key)) continue
            seen.add(key)
            // Stale entries are shown, and labelled, rather than hidden: seeing
            // an older rehearsal's history is useful, believing it is not.
            const fresh = isFreshEntry(entry, startedAt)
            out(`    [update-log]${fresh ? '' : ' (stale)'} ${entry.stage} `
              + `${JSON.stringify(entry.detail ?? '').slice(0, 200)}`)
            if (fresh && HANDOFF_STAGES.includes(entry.stage)) {
              handedOff = true
              expectedReceipt = expectedReceipt ?? expectedReceiptFrom(entry.detail)
            }
          }
        }
        if (handedOff) receipt = judge()
      }
      const applied = !spawnError && handedOff && !!receipt
      evidence.applied = applied
      evidence.handedOff = handedOff
      evidence.expectedReceipt = expectedReceipt
      if (rejected) evidence.receiptRejected = rejected
      if (spawnError) evidence.spawnError = String(spawnError?.message ?? spawnError)
      step(applied ? 'THE FIXTURE UPDATE WAS APPLIED' : 'the fixture update was NOT applied',
        applied
          ? `the in-app route reached the fixture and it completed; nothing was installed\n`
            + `    receipt ${receipt.file}\n    token ${receipt.token}`
          : spawnError
            ? `the rehearsal build could not be started: ${spawnError.message ?? spawnError}`
          : handedOff
            // ⚠ A HANDOFF WITHOUT ITS OWN PUBLISHED RECEIPT IS NOT A SUCCESS.
            // The app says it launched something; the receipt is the fixture
            // saying it ran, and only the named one speaks for this attempt.
            ? 'a handoff was recorded but this attempt\'s receipt did not arrive: '
              + (rejected ?? `nothing at ${expectedReceipt ?? '(no path was named)'}`)
            : `waited ${Math.round(budgetMs / 1000)}s with no fresh handoff — most often this `
              + 'means the machine was in use, so the 60s idle condition never held')

      // ---------------------------------------------------------- the evidence
      const capture = {}
      capture.updateLog = fileSystem.existsSync(plan.updateLog)
        ? JSON.parse(fileSystem.readFileSync(plan.updateLog, 'utf8')) : null
      capture.dataRootEntries = fileSystem.existsSync(plan.dataRoot)
        ? fileSystem.readdirSync(plan.dataRoot) : []
      capture.receipt = receipt ? { name: path.basename(receipt.file), body: receipt.body } : null
      capture.otherFixtureFiles = capture.dataRootEntries
        .filter(name => name.startsWith('update-fixture-')
          && (!receipt || name !== path.basename(receipt.file)))
      // ⚠ A PROGRAMMATIC ENUMERATION, NOT AN OBSERVATION OF THE SCREEN. It says
      // whether a process has a main window title; it cannot see a tray icon, and
      // it must never be reported as "I watched the screen".
      capture.processes = processesWithPaths(runPowerShell)
        .filter(p => /orgtree/i.test(p.ProcessName) || isInside(p.Path, plan.outDir))
        .map(p => ({
          id: p.Id, name: p.ProcessName, mainWindowTitle: p.MainWindowTitle, path: p.Path,
          rehearsal: isRehearsalProcessPath(p.Path, plan.outDir),
        }))
      evidence.capture = capture
      step('evidence captured',
        `${receipt ? 'this attempt\'s receipt' : 'NO receipt for this attempt'}`
        + `${capture.otherFixtureFiles.length
          ? ` (${capture.otherFixtureFiles.length} other fixture file(s) ignored)` : ''}, `
        + `${(capture.updateLog ?? []).length} update-log entries`)
      if (receipt) out(`\n--- ${path.basename(receipt.file)}\n${receipt.body.trim()}\n---`)

      exitCode = applied ? 0 : 3
    }
  } catch (error) {
    step('REFUSED', String(error?.message ?? error))
    exitCode = 1
  } finally {
    // ⚠ ONLY IF THIS RUN LAUNCHED SOMETHING, and only ever against the
    // VALIDATED output directory from the plan. Falling back to the raw
    // `outDir` here was the hole: a plan refused for naming Program Files still
    // reached Stop-Process with Program Files.
    // ⚠ ATTEMPTED TERMINATION IS NOT OBSERVED TERMINATION. Calling
    // Stop-Process and recording the process as "stopped" is a claim about
    // what was ASKED FOR. Review measured a failed stop being reported as a
    // success, with the live process named in evidence.stopped and the run
    // still exiting zero. Every process is now re-enumerated afterwards, and
    // only the ones that actually went are called stopped.
    if (launched && plan) {
      const mine = () => processesWithPaths(runPowerShell)
        .filter(proc => isRehearsalProcessPath(proc.Path, plan.outDir))
      const before = mine()
      for (const proc of before) stopProcess(proc.Id)
      // Give them a moment to exit, then look again rather than assume.
      let survivors = before.length ? mine() : []
      for (let attempt = 0; attempt < 5 && survivors.length; attempt += 1) {
        await sleep(500)
        survivors = mine()
      }
      const surviving = new Set(survivors.map(proc => String(proc.Id)))
      evidence.stopped = before
        .filter(proc => !surviving.has(String(proc.Id)))
        .map(proc => ({ id: proc.Id, name: proc.ProcessName, path: proc.Path }))
      evidence.stillRunning = survivors
        .map(proc => ({ id: proc.Id, name: proc.ProcessName, path: proc.Path }))
      step('rehearsal processes stopped',
        evidence.stopped.length
          ? evidence.stopped.map(s => `${s.id} (${s.path})`).join(', ')
          : 'none were running')
      if (survivors.length) {
        // ⚠ AND A SURVIVOR FAILS THE RUN. It is still using the storage below,
        // so nothing may be deleted either.
        cleanupFailed = true
        step('⚠ PROCESSES THIS RUN STARTED ARE STILL RUNNING',
          `${evidence.stillRunning.map(s => `${s.id} ${s.name} (${s.path})`).join(', ')} — `
          + 'they did not exit when asked. Nothing has been removed, because they may still '
          + 'be writing to it. Stop them by hand and re-check before trusting this machine')
      }
    } else {
      evidence.stopped = []
      step('no process was stopped',
        'this run launched nothing, so there is nothing of its own to stop — and it '
        + 'does not get to stop anything it did not start')
    }
    if (server) {
      await server.close()
      step('feed server closed', 'the loopback listener is gone')
    }

    if (!launched) {
      step('nothing was removed',
        'cleanup removes this run\'s residue; a run that launched nothing produced none')
    } else if (cleanupFailed) {
      evidence.removed = []
      step('nothing was removed — a process this run started is still alive',
        'deleting storage underneath a running process is worse than leaving residue')
    } else if (!keep) {
      // ⚠ ONLY WHAT THIS RUN CREATED. The baseline recorded whether each of
      // these existed beforehand; anything that did belongs to somebody's
      // ordinary dev build, not to this test.
      const targets = []
      const cache = path.join(env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE)
      if (preexistingCache) {
        step('the updater cache was left alone',
          `${cache} existed before this run, so it is not this rehearsal's residue`)
      } else {
        targets.push(cache)
      }
      if (preexistingDataRoot) {
        step('the dev data root was left alone',
          `${rehearsalDataRoot(env)} existed before this run, so it is somebody's dev build `
          + 'data and not this rehearsal\'s residue')
      } else {
        targets.push(rehearsalDataRoot(env))
      }
      const removed = []
      const leftBehind = []
      for (const target of targets) {
        try {
          const safe = assertRemovable(target, { env })
          if (!fileSystem.existsSync(safe)) continue
          fileSystem.rmSync(safe, { recursive: true, force: true })
          // ⚠ CONFIRMED, NOT ASSUMED — rmSync with force swallows a good deal,
          // and a removal that quietly left the directory in place used to
          // still be counted as removed.
          if (fileSystem.existsSync(safe)) {
            leftBehind.push({ path: safe, reason: 'it is still there after removal' })
          } else {
            removed.push(safe)
          }
        } catch (error) {
          leftBehind.push({ path: target, reason: String(error?.code ?? error?.message ?? error) })
        }
      }
      evidence.removed = removed
      evidence.residue = leftBehind
      step('rehearsal residue removed', removed.length ? removed.join(', ') : 'nothing to remove')
      if (leftBehind.length) {
        // ⚠ RESIDUE IS A FAILURE, AND IT IS NAMED. 'cleanup refused: EACCES'
        // buried in the steps while the run returned zero was review's finding:
        // the operator reads the exit code, not the log.
        cleanupFailed = true
        step('⚠ REHEARSAL RESIDUE REMAINS ON THIS MACHINE',
          leftBehind.map(r => `${r.path} (${r.reason})`).join('; ')
          + ' — remove it by hand; the run is reported as failed for this reason alone')
      }
    } else {
      step('residue kept', '--keep was given; the rehearsal data root and updater cache remain')
    }

    // Only this invocation's own claims, verified by pid before each removal.
    if (reservation) evidence.released = releaseAll(reservation, { fileSystem })

    // ⚠ AND A COMPARISON THAT DID NOT HAPPEN IS NOT A PASS. Both the failing
    // and the missing case force a non-zero exit: an exit code of 0 from this
    // tool means the installed release was checked and found unchanged, never
    // that nobody looked.
    try {
      const before = JSON.parse(
        fileSystem.readFileSync(path.join(paths.workDir, 'baseline.json'), 'utf8')).snapshot
      const rows = compareSnapshots(before,
        snapshot({ env, installedRoot, run: runPowerShell, fileSystem }))
      evidence.comparison = rows
      if (!report(rows, { label: 'after', out, err })) exitCode = 1
    } catch (error) {
      step('NO BASELINE COMPARISON — the installed release was NOT verified unchanged',
        String(error?.message ?? error))
      evidence.comparison = null
      exitCode = 1
    }

    // ⚠ CLEANUP FAILURE IS RUN FAILURE, applied AFTER the comparison so the
    // comparison still runs and is still recorded. A surviving process or
    // residue left on the machine is not something an operator should have to
    // find by reading the log of a run that told them it succeeded.
    if (cleanupFailed) {
      evidence.cleanupFailed = true
      exitCode = exitCode === 0 ? 4 : exitCode
    }

    try {
      fileSystem.writeFileSync(path.join(paths.workDir, 'evidence.json'),
        JSON.stringify(evidence, null, 2))
      out(`\nevidence written to ${path.join(paths.workDir, 'evidence.json')}`)
    } catch (error) { err(`evidence could not be written: ${error?.message ?? error}`) }
  }
  return exitCode
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try { return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url)) }
  catch { return false }
}

if (isMain()) process.exit(await main())
