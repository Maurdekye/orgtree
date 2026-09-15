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
  assertNotElevated, assertRehearsalPackage, assertRehearsalTarget, compareSnapshots,
  assertFixtureProvenance, assertRehearsalComposition, DEFAULT_REHEARSAL_OUT, isInside,
  isolationChecks, isRehearsalProcessPath, installedRootsFromRegistry, overlaps,
  processesWithPaths, productionDataRoot, productionInstallRoots, rehearsalDataRoot,
  REHEARSAL_UPDATER_CACHE, report, resolveInstalledRoot, snapshot,
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

  const roots = productionInstallRoots(env, installedRoot, installedRoots)
  const withinAnInstall = (candidate) =>
    roots.some(root => overlaps(candidate, root, fileSystem))

  if (withinAnInstall(resolvedFixture)) {
    throw new Error(`refusing to offer [${resolvedFixture}] as the update artifact: it is `
      + 'inside an installed location, and the artifact served must be the harmless '
      + 'fixture this repository built, never anything from an installation')
  }
  // ⚠ THE WORKING DIRECTORY IS WRITTEN TO, so it is judged by the same rule as
  // everything else: the feed directory, the baseline and the evidence all land
  // inside it, and a copy of the artifact lands in the feed.
  if (resolvedWork !== null) {
    if (withinAnInstall(resolvedWork)) {
      throw new Error(`refusing to use [${resolvedWork}] as the rehearsal working `
        + 'directory: it overlaps an installed location, and this directory is written to')
    }
    if (overlaps(resolvedWork, productionDataRoot(env), fileSystem)) {
      throw new Error(`refusing to use [${resolvedWork}] as the rehearsal working `
        + 'directory: it overlaps the production data root')
    }
  }

  const dataRoot = rehearsalDataRoot(env)
  const production = productionDataRoot(env)
  if (path.resolve(dataRoot).toLowerCase() === path.resolve(production).toLowerCase()) {
    throw new Error('the rehearsal and production data roots resolve to the same path')
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

function value(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

// --------------------------------------------------------------------- main

export async function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const outDir = path.resolve(repoRoot, value(argv, '--out', DEFAULT_REHEARSAL_OUT))
  const exe = path.join(outDir, 'win-unpacked', 'Orgtree Dev.exe')
  const fixture = path.resolve(repoRoot,
    value(argv, '--fixture', 'dist/update-fixture/orgtree-update-fixture.exe'))
  const workDir = path.resolve(repoRoot, value(argv, '--work', 'dist/rehearsal'))
  const budgetMs = Number(value(argv, '--budget', String(DEFAULT_BUDGET_MS / 1000))) * 1000
  const keep = argv.includes('--keep')
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
    if (!fs.existsSync(target)) {
      console.error(`${label} is missing at ${target}\n  build it first:  ${hint}`)
      return 2
    }
  }

  const evidence = { at: new Date().toISOString(), steps: [] }
  const step = (name, detail) => {
    evidence.steps.push({ name, detail })
    console.log(`· ${name}\n    ${detail}`)
  }

  // ⚠ EVERYTHING THAT CAN BE JUDGED BEFORE A SINGLE BYTE IS WRITTEN IS JUDGED
  // HERE. The feed directory receives a copy of the artifact, so creating it
  // before this ran meant a refused --work had already written into whatever it
  // named. Elevation is refused here too, for the same reason.
  let paths
  let installedRoot
  let packagedInfo
  try {
    assertNotElevated()
    installedRoot = resolveInstalledRoot()
    const installedRoots = installedRootsFromRegistry()
    paths = assertRehearsalPaths({
      outDir, exe, fixture, workDir, installedRoot, installedRoots,
    })
    // What was COMPILED, not what build-info.json claims, and what the bytes
    // ARE, not where they sit.
    packagedInfo = assertRehearsalComposition(path.join(outDir, 'win-unpacked'))
    const provenance = assertFixtureProvenance(paths.fixture, { repoRoot })
    step('the artifact is this repository\'s fixture',
      `sha256 ${provenance.sha256.slice(0, 16)}…, built from ${provenance.source}`)
  } catch (error) {
    console.error(`REFUSED: ${error?.message ?? error}`)
    console.error('Nothing was created, launched, stopped or removed.')
    return 1
  }

  fs.mkdirSync(paths.workDir, { recursive: true })
  const written = writeFeed({
    directory: path.join(paths.workDir, 'feed'),
    artifact: paths.fixture,
    version: FIXTURE_VERSION,
    releaseDate: new Date().toISOString(),
  })
  const server = await serveFeed(written.directory)
  evidence.feed = server.url
  console.log(`· loopback feed ${server.url} offering ${written.version} `
    + `(${written.file}, ${written.size} bytes)`)

  let plan
  let child
  let exitCode = 1
  let preexistingDataRoot = true
  let preexistingCache = true
  let dryRunComplete = false
  // ⚠ NOTHING DESTRUCTIVE HAPPENS UNLESS A LAUNCH ACTUALLY HAPPENED. Review
  // measured both halves of this: a refused plan still reached Stop-Process
  // with the UNVALIDATED output directory, and --dry-run — which promises it
  // launched nothing — stopped a pre-existing process and deleted an existing
  // updater cache. Cleanup now only ever cleans up after something this run did.
  let launched = false
  try {
    // ⚠ THE PLAN IS THE GATE. Nothing below launches anything until every
    // refusal in planRehearsal has declined to fire.
    plan = planRehearsal({
      outDir, exe, fixture, workDir, feedUrl: server.url, packagedInfo, installedRoot,
      installedRoots: installedRootsFromRegistry(),
    })
    step('plan accepted', `${plan.version} from ${plan.exe}\n    data root ${plan.dataRoot}`)

    const pre = isolationChecks({
      feed: server.url, installedRoot, isLoopback: isLoopbackFeedUrl, outDir: plan.outDir,
    })
    if (!report(pre, { label: 'before launch' })) {
      throw new Error('preflight isolation checks failed; nothing was launched')
    }
    const baseline = snapshot({ installedRoot })
    // ⚠ WHAT WAS ALREADY THERE DECIDES WHAT CLEANUP MAY DELETE. A rehearsal
    // wears the dev identity, so the dev data root and the updater cache may
    // both belong to somebody's ordinary dev build — and destroying their data
    // to tidy up after a test would be far worse than leaving residue. This run
    // removes only what this run created.
    preexistingDataRoot = baseline.rehearsalDataExists
    preexistingCache = baseline.rehearsalCacheExists
    fs.writeFileSync(path.join(plan.workDir, 'baseline.json'),
      JSON.stringify({ at: new Date().toISOString(), snapshot: baseline }, null, 2))
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
      const startedAt = Date.now()

      // --background suppresses the main window. The environment carries the feed
      // and the fixture; a build not composed for rehearsal ignores both.
      child = spawn(plan.exe, ['--background'], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, ORGTREE_UPDATE_FEED: plan.feedUrl, ORGTREE_UPDATE_FIXTURE: plan.fixture },
      })
      launched = true
      // ⚠ A SPAWN FAILURE ARRIVES ASYNCHRONOUSLY and the surrounding try/catch
      // cannot see it: without this listener a failed launch became an
      // uncaughtException, and the run would otherwise sit out its whole budget
      // waiting for a process that never started.
      let spawnError = null
      child.on('error', (error) => { spawnError = error })
      child.unref()
      step('rehearsal launched', `pid ${child.pid}, --background`)
      console.log(`\n  ⚠ LEAVE THE MACHINE ALONE NOW. The apply needs 60 seconds of no\n`
        + `    keyboard or mouse input; the budget is ${Math.round(budgetMs / 1000)}s.\n`)

      // ⚠ FRESH RECEIPTS ONLY. A receipt file is this run's when it was written
      // after the launch AND its terminal record agrees with the token it
      // declares. Both halves matter: mtime alone would accept a touched file,
      // and the token pair alone would accept last week's success.
      const freshReceipts = () => {
        if (!fs.existsSync(plan.dataRoot)) return []
        return fs.readdirSync(plan.dataRoot)
          .filter(name => name.startsWith('update-fixture-'))
          .map((name) => {
            const file = path.join(plan.dataRoot, name)
            const body = fs.readFileSync(file, 'utf8')
            return { name, body, at: fs.statSync(file).mtimeMs, token: receiptToken(body) }
          })
          .filter(receipt => receipt.token && receipt.at >= startedAt)
      }

      const seen = new Set()
      let handedOff = false
      let receipts = []
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline && !(handedOff && receipts.length) && !spawnError) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        if (fs.existsSync(plan.updateLog)) {
          let entries = []
          try { entries = JSON.parse(fs.readFileSync(plan.updateLog, 'utf8')) } catch { entries = [] }
          for (const entry of Array.isArray(entries) ? entries : []) {
            const key = `${entry.stage}:${entry.at ?? ''}`
            if (seen.has(key)) continue
            seen.add(key)
            // Stale entries are shown, and labelled, rather than hidden: seeing
            // an older rehearsal's history is useful, believing it is not.
            const fresh = isFreshEntry(entry, startedAt)
            console.log(`    [update-log]${fresh ? '' : ' (stale)'} ${entry.stage} `
              + `${JSON.stringify(entry.detail ?? '').slice(0, 160)}`)
            if (fresh && HANDOFF_STAGES.includes(entry.stage)) handedOff = true
          }
        }
        if (handedOff) receipts = freshReceipts()
      }
      // ⚠ A FAILED LAUNCH IS NEVER A SUCCESS, whatever old evidence is lying
      // around in a shared data root.
      const applied = !spawnError && handedOff && receipts.length > 0
      evidence.applied = applied
      evidence.handedOff = handedOff
      if (spawnError) evidence.spawnError = String(spawnError?.message ?? spawnError)
      step(applied ? 'THE FIXTURE UPDATE WAS APPLIED' : 'the fixture update was NOT applied',
        applied
          ? `the in-app route reached the fixture and it completed; nothing was installed\n`
            + `    token ${receipts.map(r => r.token).join(', ')}`
          : spawnError
            ? `the rehearsal build could not be started: ${spawnError.message ?? spawnError}`
          : handedOff
            // ⚠ A HANDOFF WITHOUT A RECEIPT IS NOT A SUCCESS. The app says it
            // launched something; the receipt is the fixture saying it ran.
            ? 'a handoff was recorded but NO completed fixture receipt from this run was '
              + 'found — the app launched something and nothing confirmed running'
            : `waited ${Math.round(budgetMs / 1000)}s with no fresh handoff — most often this `
              + 'means the machine was in use, so the 60s idle condition never held')

      // ---------------------------------------------------------- the evidence
      const capture = {}
      capture.updateLog = fs.existsSync(plan.updateLog)
        ? JSON.parse(fs.readFileSync(plan.updateLog, 'utf8')) : null
      capture.dataRootEntries = fs.existsSync(plan.dataRoot) ? fs.readdirSync(plan.dataRoot) : []
      capture.receipts = freshReceipts()
      capture.staleReceiptCount = capture.dataRootEntries
        .filter(name => name.startsWith('update-fixture-')).length - capture.receipts.length
      // ⚠ A PROGRAMMATIC ENUMERATION, NOT AN OBSERVATION OF THE SCREEN. It says
      // whether a process has a main window title; it cannot see a tray icon, and
      // it must never be reported as "I watched the screen".
      capture.processes = processesWithPaths()
        .filter(p => /orgtree/i.test(p.ProcessName) || isInside(p.Path, plan.outDir))
        .map(p => ({
          id: p.Id, name: p.ProcessName, mainWindowTitle: p.MainWindowTitle, path: p.Path,
          rehearsal: isRehearsalProcessPath(p.Path, plan.outDir),
        }))
      evidence.capture = capture
      step('evidence captured', `${capture.receipts.length} fixture receipt(s) from this run`
        + `${capture.staleReceiptCount > 0 ? ` (${capture.staleReceiptCount} older, ignored)` : ''}, `
        + `${(capture.updateLog ?? []).length} update-log entries`)
      for (const receipt of capture.receipts) {
        console.log(`\n--- ${receipt.name}\n${receipt.body.trim()}\n---`)
      }

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
    if (launched && plan) {
      const stopped = stopRehearsalProcesses(plan.outDir)
      evidence.stopped = stopped
      step('rehearsal processes stopped',
        stopped.length
          ? stopped.map(s => `${s.id} (${s.path})`).join(', ')
          : 'none were running')
    } else {
      evidence.stopped = []
      step('no process was stopped',
        'this run launched nothing, so there is nothing of its own to stop — and it '
        + 'does not get to stop anything it did not start')
    }
    await server.close()
    step('feed server closed', 'the loopback listener is gone')

    if (!launched) {
      step('nothing was removed',
        'cleanup removes this run\'s residue; a run that launched nothing produced none')
    } else if (!keep) {
      // ⚠ ONLY WHAT THIS RUN CREATED. The baseline recorded whether each of
      // these existed beforehand; anything that did belongs to somebody's
      // ordinary dev build, not to this test.
      const targets = []
      const cache = path.join(process.env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE)
      if (preexistingCache) {
        step('the updater cache was left alone',
          `${cache} existed before this run, so it is not this rehearsal's residue`)
      } else {
        targets.push(cache)
      }
      if (preexistingDataRoot) {
        step('the dev data root was left alone',
          `${rehearsalDataRoot()} existed before this run, so it is somebody's dev build `
          + 'data and not this rehearsal\'s residue')
      } else {
        targets.push(rehearsalDataRoot())
      }
      const removed = []
      for (const target of targets) {
        try {
          const safe = assertRemovable(target)
          if (fs.existsSync(safe)) {
            fs.rmSync(safe, { recursive: true, force: true })
            removed.push(safe)
          }
        } catch (error) { step('cleanup refused', String(error?.message ?? error)) }
      }
      evidence.removed = removed
      step('rehearsal residue removed', removed.length ? removed.join(', ') : 'nothing to remove')
    } else {
      step('residue kept', '--keep was given; the rehearsal data root and updater cache remain')
    }

    // The comparison runs whatever happened above, because "it failed" is
    // exactly when you most want to know the installed release is untouched.
    // It only reads, so it is safe on every path.
    // ⚠ AND A COMPARISON THAT DID NOT HAPPEN IS NOT A PASS. Both the failing
    // and the missing case force a non-zero exit: an exit code of 0 from this
    // tool means the installed release was checked and found unchanged, never
    // that nobody looked.
    try {
      const before = JSON.parse(
        fs.readFileSync(path.join(paths.workDir, 'baseline.json'), 'utf8')).snapshot
      const rows = compareSnapshots(before, snapshot({ installedRoot }))
      evidence.comparison = rows
      if (!report(rows, { label: 'after' })) exitCode = 1
    } catch (error) {
      step('NO BASELINE COMPARISON — the installed release was NOT verified unchanged',
        String(error?.message ?? error))
      evidence.comparison = null
      exitCode = 1
    }

    fs.writeFileSync(path.join(paths.workDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(`\nevidence written to ${path.join(paths.workDir, 'evidence.json')}`)
  }
  return exitCode
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
}

if (isMain()) process.exit(await main())
