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
  DEFAULT_REHEARSAL_OUT, isolationChecks, isRehearsalProcessPath, productionDataRoot,
  productionInstallRoots, rehearsalDataRoot, REHEARSAL_UPDATER_CACHE, report,
  resolveInstalledRoot, snapshot,
} from './rehearsal-isolation.mjs'

export { REHEARSAL_UPDATER_CACHE }
export const FIXTURE_VERSION = '9.9.9-fixture'
export const DEFAULT_BUDGET_MS = 300000

/** ⚠ EVERY REFUSAL IN ONE PLACE, and pure so the tests can drive it with
 *  production-shaped inputs and watch it refuse. main() executes exactly the
 *  plan this returns, so a rule proved here is a rule the rehearsal obeys —
 *  rather than a rule written down next to code that does something else.
 *
 *  Throws with the reason. Returns the plan when everything is safe. */
export function planRehearsal({
  outDir, exe, fixture, feedUrl, packagedInfo,
  env = process.env, installedRoot = null, isLoopback = isLoopbackFeedUrl,
}) {
  if (!isLoopback(feedUrl)) {
    throw new Error(`refusing to rehearse against [${feedUrl}]: the feed must be an `
      + 'isolated loopback URL, so a private test can never reach a public release feed')
  }
  assertRehearsalPackage(packagedInfo)

  const resolvedOut = path.resolve(outDir)
  const resolvedExe = assertRehearsalTarget({ exe, outDir: resolvedOut, env, installedRoot })

  const resolvedFixture = path.resolve(fixture)
  for (const root of productionInstallRoots(env, installedRoot)) {
    if (resolvedFixture === root || resolvedFixture.toLowerCase().startsWith(
      (root.endsWith(path.sep) ? root : root + path.sep).toLowerCase())) {
      throw new Error(`refusing to offer [${resolvedFixture}] as the update artifact: it is `
        + 'inside an installed location, and the artifact served must be the harmless '
        + 'fixture this repository built, never anything from an installation')
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
    feedUrl,
    dataRoot,
    productionDataRoot: production,
    updateLog: path.join(dataRoot, 'update-log.json'),
    version: packagedInfo.version,
  }
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

function orgtreeProcesses() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-Process | Where-Object { $_.ProcessName -like '*Orgtree*' } "
    + '| Select-Object Id, ProcessName, MainWindowTitle, Path | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true }).trim()
  const parsed = out ? JSON.parse(out) : []
  return Array.isArray(parsed) ? parsed : [parsed]
}

function stopRehearsalProcesses(outDir) {
  const stopped = []
  for (const proc of orgtreeProcesses()) {
    if (!isRehearsalProcessPath(proc.Path, outDir)) continue
    stopped.push({ id: proc.Id, path: proc.Path })
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

  assertNotElevated()
  const installedRoot = resolveInstalledRoot()
  const packagedInfo = JSON.parse(fs.readFileSync(
    path.join(outDir, 'win-unpacked', 'resources', 'build-info.json'), 'utf8'))

  fs.mkdirSync(workDir, { recursive: true })
  const written = writeFeed({
    directory: path.join(workDir, 'feed'),
    artifact: fixture,
    version: FIXTURE_VERSION,
    releaseDate: new Date().toISOString(),
  })
  const server = await serveFeed(written.directory)
  console.log(`· loopback feed ${server.url} offering ${written.version} `
    + `(${written.file}, ${written.size} bytes)`)

  const evidence = { at: new Date().toISOString(), feed: server.url, steps: [] }
  const step = (name, detail) => {
    evidence.steps.push({ name, detail })
    console.log(`· ${name}\n    ${detail}`)
  }

  let plan
  let child
  let exitCode = 1
  let preexistingDataRoot = true
  try {
    // ⚠ THE PLAN IS THE GATE. Nothing below launches anything until every
    // refusal in planRehearsal has declined to fire.
    plan = planRehearsal({
      outDir, exe, fixture, feedUrl: server.url, packagedInfo, installedRoot,
    })
    step('plan accepted', `${plan.version} from ${plan.exe}\n    data root ${plan.dataRoot}`)

    const pre = isolationChecks({
      feed: server.url, installedRoot, isLoopback: isLoopbackFeedUrl,
    })
    if (!report(pre, { label: 'before launch' })) {
      throw new Error('preflight isolation checks failed; nothing was launched')
    }
    const baseline = snapshot({ installedRoot })
    // ⚠ WHETHER THE DEV DATA ROOT WAS ALREADY THERE decides whether cleanup may
    // delete it. A rehearsal wears the dev identity, so that directory may
    // belong to somebody's ordinary dev build — and destroying their data to
    // tidy up after a test would be a far worse outcome than leaving residue.
    preexistingDataRoot = baseline.rehearsalDataExists
    fs.writeFileSync(path.join(workDir, 'baseline.json'),
      JSON.stringify({ at: new Date().toISOString(), snapshot: baseline }, null, 2))
    step('baseline captured', path.join(workDir, 'baseline.json'))

    if (dryRun) {
      step('DRY RUN — nothing was launched',
        'every guard and every isolation check passed; a real run would start '
        + `${plan.exe} now`)
      exitCode = 0
      return exitCode
    }

    // --background suppresses the main window. The environment carries the feed
    // and the fixture; a build not composed for rehearsal ignores both.
    child = spawn(plan.exe, ['--background'], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ORGTREE_UPDATE_FEED: plan.feedUrl, ORGTREE_UPDATE_FIXTURE: plan.fixture },
    })
    child.unref()
    step('rehearsal launched', `pid ${child.pid}, --background`)
    console.log(`\n  ⚠ LEAVE THE MACHINE ALONE NOW. The apply needs 60 seconds of no\n`
      + `    keyboard or mouse input; the budget is ${Math.round(budgetMs / 1000)}s.\n`)

    const seen = new Set()
    let applied = false
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline && !applied) {
      await new Promise(resolve => setTimeout(resolve, 3000))
      if (!fs.existsSync(plan.updateLog)) continue
      let entries = []
      try { entries = JSON.parse(fs.readFileSync(plan.updateLog, 'utf8')) } catch { continue }
      for (const entry of Array.isArray(entries) ? entries : []) {
        const key = `${entry.stage}:${entry.at ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        console.log(`    [update-log] ${entry.stage} `
          + `${JSON.stringify(entry.detail ?? '').slice(0, 160)}`)
        if (entry.stage === 'update-fixture-handoff'
          || entry.stage === 'update-fixture-completed') applied = true
      }
    }
    evidence.applied = applied
    step(applied ? 'THE FIXTURE UPDATE WAS APPLIED' : 'no fixture handoff within the budget',
      applied
        ? 'the in-app route reached the fixture; nothing was installed'
        : `waited ${Math.round(budgetMs / 1000)}s — most often this means the machine `
          + 'was in use, so the 60s idle condition never held')

    // ---------------------------------------------------------- the evidence
    const capture = {}
    capture.updateLog = fs.existsSync(plan.updateLog)
      ? JSON.parse(fs.readFileSync(plan.updateLog, 'utf8')) : null
    capture.dataRootEntries = fs.existsSync(plan.dataRoot) ? fs.readdirSync(plan.dataRoot) : []
    capture.receipts = capture.dataRootEntries
      .filter(name => name.startsWith('update-fixture-'))
      .map(name => ({ name, body: fs.readFileSync(path.join(plan.dataRoot, name), 'utf8') }))
    // ⚠ A PROGRAMMATIC ENUMERATION, NOT AN OBSERVATION OF THE SCREEN. It says
    // whether a process has a main window title; it cannot see a tray icon, and
    // it must never be reported as "I watched the screen".
    capture.processes = orgtreeProcesses().map(p => ({
      id: p.Id, name: p.ProcessName, mainWindowTitle: p.MainWindowTitle, path: p.Path,
      rehearsal: isRehearsalProcessPath(p.Path, plan.outDir),
    }))
    evidence.capture = capture
    step('evidence captured', `${capture.receipts.length} fixture receipt(s), `
      + `${(capture.updateLog ?? []).length} update-log entries`)
    for (const receipt of capture.receipts) {
      console.log(`\n--- ${receipt.name}\n${receipt.body.trim()}\n---`)
    }

    exitCode = applied ? 0 : 3
  } catch (error) {
    step('REFUSED', String(error?.message ?? error))
    exitCode = 1
  } finally {
    const stopped = stopRehearsalProcesses(plan?.outDir ?? outDir)
    evidence.stopped = stopped
    step('rehearsal processes stopped',
      stopped.length
        ? stopped.map(s => `${s.id} (${s.path})`).join(', ')
        : 'none were running')
    await server.close()
    step('feed server closed', 'the loopback listener is gone')

    if (!keep) {
      const targets = [path.join(process.env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE)]
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
    try {
      const before = JSON.parse(fs.readFileSync(path.join(workDir, 'baseline.json'), 'utf8')).snapshot
      const rows = compareSnapshots(before, snapshot({ installedRoot }))
      evidence.comparison = rows
      if (!report(rows, { label: 'after' })) exitCode = 1
    } catch (error) {
      step('no baseline comparison', String(error?.message ?? error))
    }

    fs.writeFileSync(path.join(workDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log(`\nevidence written to ${path.join(workDir, 'evidence.json')}`)
  }
  return exitCode
}

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
}

if (isMain()) process.exit(await main())
