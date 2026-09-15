// THE ISOLATION GUARDS FOR AN UPDATE REHEARSAL, and the before/after baseline
// that turns "I did not touch the installed release" from an assertion about
// intent into a fact about bytes.
//
//   node tools/rehearsal-isolation.mjs --capture <file>     (before)
//   node tools/rehearsal-isolation.mjs --compare <file>     (after)
//
// Nothing in this file launches, installs, elevates, publishes or writes
// anywhere except the nominated capture file. It reads the installed release
// and the uninstall registry, and it refuses.
//
// ⚠ WHY THE GUARDS ARE HERE AND NOT INLINE IN THE RUNNER. A rehearsal only
// stays harmless while every path it touches is one it created. The rules that
// decide that — which executable may be launched, which processes may be
// killed, which data root is in play — are pure functions with no filesystem or
// registry in them, so tests/update-rehearsal.test.mjs can drive them with
// production-shaped paths and watch them refuse. A guard that can only be
// exercised by actually running a rehearsal is a guard nobody checks.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** The installed release's data root, and the separate one a rehearsal uses.
 *  These names come from the product name in package.json and from
 *  tools/dev-build.mjs DEV_PRODUCT_NAME; Electron derives userData from it. */
export const PRODUCTION_DATA_NAME = 'Orgtree v2'
export const REHEARSAL_DATA_NAME = 'Orgtree v2 Dev'

export const DEFAULT_INSTALLED_ROOT = 'C:\\Program Files\\Orgtree'
export const DEFAULT_REHEARSAL_OUT = 'release-rehearsal'

/** ⚠ ONE NAME, SHARED. package-rehearsal.mjs writes this into the packaged
 *  app-update.yml and run-rehearsal.mjs deletes exactly this directory during
 *  cleanup. Two copies of the string would be two things to keep in step, and
 *  the pair drifting means either a rehearsal sharing the release's updater
 *  cache or a cleanup that removes the wrong directory. */
export const REHEARSAL_UPDATER_CACHE = 'orgtree-rehearsal-updater'

export function productionDataRoot(env = process.env) {
  return path.join(env.APPDATA ?? '', PRODUCTION_DATA_NAME)
}

export function rehearsalDataRoot(env = process.env) {
  return path.join(env.APPDATA ?? '', REHEARSAL_DATA_NAME)
}

// ------------------------------------------------------------- path rules
//
// Pure. No fs, no registry, no environment beyond what is passed in.

/** Case-insensitive containment with a separator boundary, so `C:\a\bc` is NOT
 *  inside `C:\a\b`. A prefix test without the boundary is the classic way a
 *  containment check quietly admits a sibling directory. */
export function isInside(child, parent) {
  if (!child || !parent) return false
  const c = path.resolve(String(child)).toLowerCase()
  const p = path.resolve(String(parent)).toLowerCase()
  if (c === p) return false
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** Every directory a real Orgtree installation could live in. A rehearsal
 *  executable found under any of them is refused whatever it is called. */
export function productionInstallRoots(env = process.env, installedRoot = null) {
  const roots = [installedRoot ?? DEFAULT_INSTALLED_ROOT]
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    if (env[key]) roots.push(path.join(env[key], 'Orgtree'))
  }
  // electron-builder's per-user NSIS target installs here.
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Orgtree'))
  return [...new Set(roots.map(r => path.resolve(r)))]
}

/** ⚠ THE LAUNCH GUARD. The rehearsal may only ever start an executable it
 *  packaged itself, inside the output directory it was given. Everything else —
 *  the installed release above all — is refused before anything is spawned.
 *  Throws with the reason; returns the resolved executable when it is safe. */
export function assertRehearsalTarget({ exe, outDir, env = process.env, installedRoot = null }) {
  if (!exe) throw new Error('no rehearsal executable was named')
  if (!outDir) throw new Error('no rehearsal output directory was named')
  const resolvedExe = path.resolve(String(exe))
  const resolvedOut = path.resolve(String(outDir))

  for (const root of productionInstallRoots(env, installedRoot)) {
    if (isInside(resolvedOut, root) || resolvedOut === root) {
      throw new Error(`the rehearsal output directory [${resolvedOut}] is inside the `
        + `installed location [${root}]; a rehearsal must never package into an installation`)
    }
    if (isInside(resolvedExe, root)) {
      throw new Error(`refusing to launch [${resolvedExe}]: it is inside the installed `
        + `location [${root}]. A rehearsal launches only the build it packaged itself`)
    }
  }
  if (!isInside(resolvedExe, resolvedOut)) {
    throw new Error(`refusing to launch [${resolvedExe}]: it is not inside the rehearsal `
      + `output directory [${resolvedOut}]`)
  }
  return resolvedExe
}

/** ⚠ THE TERMINATION GUARD. Cleanup kills processes; matching them by name
 *  would catch the user's real Orgtree. Only a process whose image lives inside
 *  the rehearsal output directory is ours to stop. */
export function isRehearsalProcessPath(processPath, outDir) {
  if (!processPath || !outDir) return false
  return isInside(processPath, outDir)
}

/** ⚠ THE PACKAGING GUARD, applied to what was actually written rather than to
 *  the config that was meant to produce it. */
export function assertRehearsalPackage(info) {
  if (!info || typeof info !== 'object') throw new Error('no packaged build-info to check')
  if (info.channel !== 'dev') {
    throw new Error(`the packaged build is channel [${info.channel}], not dev; a rehearsal `
      + 'must carry the dev identity so it cannot share the release\'s data or registry')
  }
  if (info.updateFixture !== true) {
    throw new Error('the packaged build does not disclose the update fixture; it cannot '
      + 'rehearse, and a build that could substitute without disclosing it would be worse')
  }
  return info
}

// --------------------------------------------------------------- elevation

/** A rehearsal needs no privileges at all: it unpacks a directory, serves
 *  loopback and runs one executable. Running elevated would let a mistake reach
 *  Program Files or HKLM, so it is refused rather than merely discouraged. */
export function isElevated(run = defaultPowerShell) {
  try {
    const out = run('[bool](([Security.Principal.WindowsPrincipal]'
      + '[Security.Principal.WindowsIdentity]::GetCurrent())'
      + '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))')
    return out.trim().toLowerCase() === 'true'
  } catch {
    // Unknown is not the same as no. Say so; the caller decides.
    return null
  }
}

export function assertNotElevated(run = defaultPowerShell) {
  const elevated = isElevated(run)
  if (elevated === true) {
    throw new Error('refusing to rehearse from an elevated shell: nothing here needs '
      + 'administrator rights, and elevation is what would let a mistake reach the '
      + 'installed release')
  }
  return elevated
}

function defaultPowerShell(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script],
    { encoding: 'utf8', windowsHide: true })
}

// --------------------------------------------------------------- the baseline

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Every Orgtree-ish uninstall entry, so one appearing or changing is visible. */
export function orgtreeUninstallEntries(run = defaultPowerShell) {
  const out = run(
    "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',"
    + "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue "
    + "| Where-Object { $_.DisplayName -like '*Orgtree*' } "
    + "| Select-Object PSChildName, DisplayName, DisplayVersion, InstallLocation "
    + '| ConvertTo-Json -Compress')
  const parsed = out.trim() ? JSON.parse(out) : []
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean)
}

/** A stable, comparable line per entry. InstallLocation is deliberately left
 *  out of the comparison key only where it is absent, so a NEW install adding
 *  one is still a difference. */
export function uninstallKeys(entries) {
  return entries
    .map(e => `${e.PSChildName}|${e.DisplayName}|${e.DisplayVersion}|${e.InstallLocation ?? ''}`)
    .sort()
}

/** Where the release is actually installed, rather than where we assume. The
 *  registry is asked first so this tooling works on a machine that installed
 *  somewhere else; the default is the fallback, not the answer. */
export function resolveInstalledRoot({ env = process.env, entries = null, run = defaultPowerShell } = {}) {
  if (env.ORGTREE_INSTALLED_ROOT) return path.resolve(env.ORGTREE_INSTALLED_ROOT)
  let found = entries
  if (!found) {
    try { found = orgtreeUninstallEntries(run) } catch { found = [] }
  }
  const release = found.find(e =>
    e.InstallLocation && !/dev/i.test(String(e.DisplayName ?? '')))
  return path.resolve(release?.InstallLocation ?? DEFAULT_INSTALLED_ROOT)
}

export function snapshot({ env = process.env, installedRoot = null, run = defaultPowerShell } = {}) {
  const root = installedRoot ?? resolveInstalledRoot({ env, run })
  const buildInfo = path.join(root, 'resources', 'build-info.json')
  const exe = path.join(root, 'Orgtree.exe')
  return {
    installedRoot: root,
    installedBuildInfo: fs.existsSync(buildInfo)
      ? { sha256: sha256(buildInfo), text: fs.readFileSync(buildInfo, 'utf8') }
      : null,
    installedExe: fs.existsSync(exe)
      ? { sha256: sha256(exe), size: fs.statSync(exe).size }
      : null,
    uninstall: uninstallKeys(orgtreeUninstallEntries(run)),
    productionDataExists: fs.existsSync(productionDataRoot(env)),
    rehearsalDataExists: fs.existsSync(rehearsalDataRoot(env)),
  }
}

/** Pure: the after-the-fact comparison, so it can be tested without a machine
 *  that has Orgtree installed. Returns the same {name, ok, detail} rows the
 *  pre-flight checks use. */
export function compareSnapshots(before, after) {
  const rows = []
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  rows.push({
    name: 'THE INSTALLED RELEASE IS BYTE-FOR-BYTE UNTOUCHED',
    ok: eq(before.installedBuildInfo, after.installedBuildInfo)
      && eq(before.installedExe, after.installedExe),
    detail: eq(before.installedBuildInfo, after.installedBuildInfo)
      && eq(before.installedExe, after.installedExe)
      ? `build-info sha256 ${after.installedBuildInfo?.sha256?.slice(0, 16) ?? '(absent)'}… unchanged`
      : 'the installed build-info.json or Orgtree.exe CHANGED',
  })
  rows.push({
    name: 'NO UNINSTALL ENTRY WAS ADDED OR CHANGED',
    ok: eq(before.uninstall, after.uninstall),
    detail: eq(before.uninstall, after.uninstall)
      ? `${after.uninstall.length} entries, unchanged`
      : `before: ${before.uninstall.join(' ; ')}\n       after:  ${after.uninstall.join(' ; ')}`,
  })
  rows.push({
    name: 'the production data root was not created or destroyed',
    ok: before.productionDataExists === after.productionDataExists,
    detail: `exists ${before.productionDataExists} → ${after.productionDataExists}`,
  })
  return rows
}

// ------------------------------------------------------------- the pre-flight

/** The checks that must all pass BEFORE anything is launched. Written to run
 *  against a machine that has the release installed and no rehearsal artifacts
 *  yet, so a failure costs nothing and a pass is not retrospective.
 *
 *  `feed` is the loopback URL the runner is about to use; `isLoopback` is
 *  injected so this file does not restate the definition a third time. */
export function isolationChecks({
  feed = null, env = process.env, installedRoot = null, run = defaultPowerShell,
  isLoopback = () => true, fileSystem = fs,
} = {}) {
  const rows = []
  const check = (name, fn) => {
    try { rows.push({ name, ok: true, detail: String(fn() ?? '') }) }
    catch (error) { rows.push({ name, ok: false, detail: String(error?.message ?? error) }) }
  }

  check('the installed release, if there is one, is NOT fixture-capable', () => {
    const root = installedRoot ?? resolveInstalledRoot({ env, run })
    const buildInfo = path.join(root, 'resources', 'build-info.json')
    // No installation is not a failure: there is simply nothing to protect, and
    // refusing here would stop this tooling working on a clean machine.
    if (!fileSystem.existsSync(buildInfo)) {
      return `no installed release at ${root}; nothing to protect`
    }
    const info = JSON.parse(fileSystem.readFileSync(buildInfo, 'utf8'))
    if (info.channel !== 'release') {
      throw new Error(`the installed build is channel [${info.channel}], not release`)
    }
    if ('updateFixture' in info) {
      throw new Error('THE INSTALLED BUILD IS FIXTURE-CAPABLE — if it were, a rehearsal '
        + 'could substitute inside the real installation. Stop.')
    }
    return `${info.version} / ${String(info.commit ?? '').slice(0, 7)} / channel ${info.channel}`
  })

  check('the rehearsal data root is SEPARATE from production', () => {
    const production = productionDataRoot(env)
    const rehearsal = rehearsalDataRoot(env)
    if (production.toLowerCase() === rehearsal.toLowerCase()) {
      throw new Error('the two data roots are the same path')
    }
    if (isInside(rehearsal, production)) {
      throw new Error('the rehearsal data root lives inside the production one')
    }
    return `production=${production} rehearsal=${rehearsal} `
      + `(exists: ${fileSystem.existsSync(rehearsal)})`
  })

  check('the production engine lock belongs to production alone', () => {
    // Attachment and locking are keyed by the data root, so separate roots mean
    // separate locks and separate dynamically chosen ports: the rehearsal
    // cannot attach to, or evict, the running release's engine.
    const lock = path.join(productionDataRoot(env), '.desktop-engine.lock')
    const rehearsalLock = path.join(rehearsalDataRoot(env), '.desktop-engine.lock')
    if (lock.toLowerCase() === rehearsalLock.toLowerCase()) {
      throw new Error('the two builds would share one engine lock')
    }
    return `production lock ${fileSystem.existsSync(lock) ? 'present' : 'absent'}; `
      + `the rehearsal's would be ${rehearsalLock}`
  })

  check('no rehearsal uninstall entry exists', () => {
    const entries = uninstallKeys(orgtreeUninstallEntries(run))
    const dev = entries.filter(e => /dev/i.test(e))
    if (dev.length) throw new Error(`a dev uninstall entry already exists: ${dev.join(', ')}`)
    return `${entries.length} Orgtree uninstall entr${entries.length === 1 ? 'y' : 'ies'}: `
      + entries.join(' ; ')
  })

  check('the feed, if supplied, is an isolated loopback feed', () => {
    if (!feed) return 'no feed named yet (the runner supplies it)'
    if (!isLoopback(feed)) throw new Error(`[${feed}] is not a loopback feed`)
    return feed
  })

  check('this shell is not elevated', () => {
    const elevated = assertNotElevated(run)
    return elevated === null ? 'could not be determined; treated as not elevated' : 'not elevated'
  })

  return rows
}

export function report(rows, { label = '' } = {}) {
  for (const row of rows) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}\n       ${row.detail}`)
  const failed = rows.filter(r => !r.ok)
  if (failed.length) {
    console.error(`\n${failed.length} ISOLATION CHECK(S) FAILED${label ? ` (${label})` : ''} — STOP.`)
    return false
  }
  console.log(`\nAll ${rows.length} isolation checks passed${label ? ` (${label})` : ''}.`)
  return true
}

// ---------------------------------------------------------------------- CLI

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1'))
}

if (isMain()) {
  const { isLoopbackFeedUrl } = await import('./private-update-feed.mjs')
  const argv = process.argv.slice(2)
  const mode = argv.includes('--compare') ? 'compare' : 'capture'
  const file = argv[argv.indexOf(mode === 'compare' ? '--compare' : '--capture') + 1]
  if (!file) {
    console.error('usage: node tools/rehearsal-isolation.mjs --capture|--compare <file>')
    process.exit(2)
  }
  const feed = process.env.ORGTREE_UPDATE_FEED || null
  const rows = mode === 'capture'
    ? isolationChecks({ feed, isLoopback: isLoopbackFeedUrl })
    : []
  const now = snapshot()
  if (mode === 'capture') {
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), snapshot: now }, null, 2))
    console.log(`baseline captured to ${file}`)
  } else {
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).snapshot
    rows.push(...compareSnapshots(before, now))
  }
  process.exit(report(rows, { label: mode }) ? 0 : 1)
}
