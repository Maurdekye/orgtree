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
import { fileURLToPath } from 'node:url'
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

/** The RELEASE build's updater cache, read from the installed app-update.yml.
 *  Protected like any other production location: a rehearsal writing there
 *  could hand the installed release a package it never asked for. */
export const RELEASE_UPDATER_CACHE = 'orgtree-updater'

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

/** ⚠ RESOLVE REPARSE POINTS BEFORE COMPARING PATHS. A junction or symlink means
 *  two different spellings reach the same directory, and a lexical comparison
 *  sees two unrelated strings — so `E:\alias\Orgtree` pointing at the real
 *  installation would pass every containment check above.
 *
 *  Only the longest EXISTING ancestor can be resolved (the leaf usually does
 *  not exist yet), so the un-created tail is appended back on. A path that
 *  cannot be resolved at all is returned as given: this hardens comparison, it
 *  is not itself a gate. */
export function realPath(target, fileSystem = fs) {
  const resolved = path.resolve(String(target ?? ''))
  // ⚠ AN EXISTING PATH THAT WILL NOT RESOLVE IS AN ERROR, NOT A FALLBACK.
  // Returning the lexical spelling when realpath fails on a path that IS there
  // means the guard quietly stops being a physical check exactly when something
  // unusual is going on — which is when it matters.
  if (fileSystem.existsSync(resolved)) {
    try { return fileSystem.realpathSync.native(resolved) }
    catch (error) {
      throw new Error(`cannot resolve the real path of [${resolved}], which exists: `
        + `${error?.code ?? error?.message ?? error}. Refusing rather than comparing spellings`)
    }
  }
  // It does not exist yet — normal for an output or work directory. Resolve the
  // longest existing ancestor and put the un-created tail back on.
  let current = resolved
  const tail = []
  for (;;) {
    const parent = path.dirname(current)
    if (parent === current) return resolved
    tail.unshift(path.basename(current))
    current = parent
    if (!fileSystem.existsSync(current)) continue
    try { return path.join(fileSystem.realpathSync.native(current), ...tail) }
    catch (error) {
      throw new Error(`cannot resolve the real path of [${current}], which exists: `
        + `${error?.code ?? error?.message ?? error}. Refusing rather than comparing spellings`)
    }
  }
}

/** ⚠ EITHER DIRECTION IS AN OVERLAP. `C:\` does not sit inside
 *  `C:\Program Files\Orgtree`, but naming it as the rehearsal output puts the
 *  installation underneath what cleanup scans — so containment is checked both
 *  ways, on real (reparse-resolved) paths. */
export function overlaps(a, b, fileSystem = fs) {
  const left = realPath(a, fileSystem)
  const right = realPath(b, fileSystem)
  if (!left || !right) return false
  return left.toLowerCase() === right.toLowerCase()
    || isInside(left, right) || isInside(right, left)
}

/** Every directory a real Orgtree installation could live in. A rehearsal
 *  executable found under any of them is refused whatever it is called.
 *
 *  ⚠ THE DISCOVERED ROOT IS ADDED TO THE KNOWN ONES, NEVER SUBSTITUTED FOR
 *  THEM. Passing installedRoot used to REPLACE the default, so pointing this
 *  tooling at one installation quietly dropped every other from protection —
 *  and ORGTREE_INSTALLED_ROOT became a way to disable the guard rather than to
 *  extend it. `extra` carries every location the registry reported. */
export function productionInstallRoots(env = process.env, installedRoot = null, extra = []) {
  const roots = [DEFAULT_INSTALLED_ROOT]
  if (installedRoot) roots.push(installedRoot)
  for (const more of extra) if (more) roots.push(more)
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    if (env[key]) roots.push(path.join(env[key], 'Orgtree'))
  }
  // electron-builder's per-user NSIS target installs here.
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Orgtree'))
  return [...new Set(roots.map(r => path.resolve(r)))]
}

/** ⚠ EVERY PROTECTED LOCATION, INSTALLATIONS AND DATA ALIKE, IN ONE LIST.
 *  The installation guard never covered the production DATA directory, so
 *  `--out "%APPDATA%\Orgtree v2"` was accepted and would have written packaged
 *  files into the user's own data without needing any privilege at all. There
 *  is no reason for these to be two different lists. */
export function protectedRoots(env = process.env, installedRoot = null, extra = []) {
  const roots = [
    ...productionInstallRoots(env, installedRoot, extra),
    path.resolve(productionDataRoot(env)),
  ]
  // The installed release's own updater cache: a rehearsal writing there could
  // stage a package the real application would later find and offer.
  if (env.LOCALAPPDATA) roots.push(path.resolve(path.join(env.LOCALAPPDATA, RELEASE_UPDATER_CACHE)))
  return [...new Set(roots)]
}

/** ⚠ THE STORAGE THE REHEARSAL WILL WRITE TO, JUDGED LIKE EVERYTHING ELSE.
 *
 *  These were the destinations the common policy did not cover: the dev data
 *  root was compared only against production DATA, and the updater cache was
 *  checked for existence and never for location at all. Review measured both —
 *  a cache resolving into the production data root, and a dev data root
 *  resolving into the installed release — launching and returning zero under
 *  --adopt.
 *
 *  ⚠ ADOPTION IS ABOUT OWNERSHIP, NEVER ABOUT ISOLATION. `--adopt` says "this
 *  existing rehearsal storage is mine to reuse". It cannot say "and it may be a
 *  junction into Program Files". This check therefore runs whatever adoption
 *  says, and before anything is launched — the app and the updater write to
 *  these directories while the run is in progress, so preserving them at
 *  cleanup time is far too late. */
export function assertStorageSafe({
  env = process.env, installedRoot = null, installedRoots = [], fileSystem = fs,
} = {}) {
  const where = { env, installedRoot, installedRoots, fileSystem }
  const dataRoot = rehearsalDataRoot(env)
  return {
    dataRoot: assertDestinationSafe('rehearsal data root', dataRoot, where),
    engineLock: assertDestinationSafe('rehearsal engine lock',
      path.join(dataRoot, '.desktop-engine.lock'), where),
    updaterCache: assertDestinationSafe('rehearsal updater cache',
      path.join(env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE), where),
  }
}

/** ⚠ ONE POLICY FOR EVERY MUTABLE DESTINATION. Whatever the rehearsal will
 *  write to, launch from, or delete — output, work, feed, evidence, userData,
 *  updater cache — is judged the same way: physically, in both directions,
 *  against installations AND production data. `label` is what the operator
 *  sees, so the refusal names the thing they actually typed. */
export function assertDestinationSafe(label, target, {
  env = process.env, installedRoot = null, installedRoots = [], fileSystem = fs,
} = {}) {
  if (!target) throw new Error(`no ${label} was named`)
  for (const root of protectedRoots(env, installedRoot, installedRoots)) {
    if (overlaps(target, root, fileSystem)) {
      throw new Error(`refusing to use [${path.resolve(target)}] as the ${label}: it is the `
        + `same physical location as, inside, or around a protected location [${root}]. `
        + 'Junctions and symlinks are resolved first, so a different spelling of the same '
        + 'directory is refused too')
    }
  }
  return path.resolve(target)
}

/** ⚠ THE LAUNCH GUARD. The rehearsal may only ever start an executable it
 *  packaged itself, inside the output directory it was given. Everything else —
 *  the installed release above all — is refused before anything is spawned.
 *  Throws with the reason; returns the resolved executable when it is safe. */
export function assertRehearsalTarget({
  exe, outDir, env = process.env, installedRoot = null, installedRoots = [],
  fileSystem = fs,
}) {
  if (!exe) throw new Error('no rehearsal executable was named')
  if (!outDir) throw new Error('no rehearsal output directory was named')
  const resolvedExe = path.resolve(String(exe))
  const resolvedOut = path.resolve(String(outDir))

  // ⚠ OVERLAP IN EITHER DIRECTION, AND AGAINST PRODUCTION DATA TOO. An output
  // directory that CONTAINS an installation is as bad as one inside it, because
  // cleanup scans its descendants — and the production data directory was never
  // protected here at all, so it was accepted as a packaging destination.
  for (const root of protectedRoots(env, installedRoot, installedRoots)) {
    if (overlaps(resolvedOut, root, fileSystem)) {
      throw new Error(`the rehearsal output directory [${resolvedOut}] overlaps the `
        + `protected location [${root}]; a rehearsal must never package into, or around, `
        + 'an installation or the production data directory')
    }
    if (overlaps(resolvedExe, root, fileSystem)) {
      throw new Error(`refusing to launch [${resolvedExe}]: it is inside the installed `
        + `location [${root}]. A rehearsal launches only the build it packaged itself`)
    }
  }
  // Compared on real paths, so a junction cannot make the executable look like
  // it lives somewhere it does not.
  if (!isInside(realPath(resolvedExe, fileSystem), realPath(resolvedOut, fileSystem))) {
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

export const FIXTURE_BUILD_MARKER = 'ORGTREE-UPDATE-FIXTURE-BUILD' + ':enabled'

/** ⚠ WHAT WAS COMPILED, NOT WHAT THE JSON CLAIMS. build-info.json is an
 *  editable text file sitting next to the app: two lines in an editor turn any
 *  packaged build into one this tooling believes is a dev-identity rehearsal
 *  build. The properties that actually matter are in the bundle and in the
 *  packaged feed configuration, so those are what get read.
 *
 *  Checks, against the unpacked directory: the disclosure (above), the
 *  substitution marker compiled into app.asar, and an app-update.yml that names
 *  a loopback URL and the rehearsal's own updater cache — so this build cannot
 *  share the installed release's cache even before setFeedURL runs. */
export function assertRehearsalComposition(unpacked, fileSystem = fs) {
  const resources = path.join(unpacked, 'resources')
  const infoPath = path.join(resources, 'build-info.json')
  if (!fileSystem.existsSync(infoPath)) {
    throw new Error(`no packaged build-info.json at ${infoPath}`)
  }
  const info = assertRehearsalPackage(JSON.parse(fileSystem.readFileSync(infoPath, 'utf8')))

  const asar = path.join(resources, 'app.asar')
  if (!fileSystem.existsSync(asar)) throw new Error(`no packaged bundle at ${asar}`)
  if (!fileSystem.readFileSync(asar, 'latin1').includes(FIXTURE_BUILD_MARKER)) {
    throw new Error('the packaged bundle does NOT carry the compiled update-fixture '
      + 'capability, whatever build-info.json says: this build cannot substitute, so it '
      + 'would hand off to a REAL installer. Repackage with tools/package-rehearsal.mjs')
  }

  const feedConfig = path.join(resources, 'app-update.yml')
  if (!fileSystem.existsSync(feedConfig)) {
    throw new Error(`no packaged app-update.yml at ${feedConfig}; a dev-channel build `
      + 'cannot download an update without one (measured), so the rehearsal would fail '
      + 'after finding the offer')
  }
  const feed = fileSystem.readFileSync(feedConfig, 'utf8')
  const cache = feed.match(/^updaterCacheDirName:\s*(\S+)\s*$/m)?.[1]
  if (cache !== REHEARSAL_UPDATER_CACHE) {
    throw new Error(`the packaged app-update.yml names updater cache [${cache}], not `
      + `[${REHEARSAL_UPDATER_CACHE}]; a rehearsal must not share the release's updater cache`)
  }
  const url = feed.match(/^url:\s*(\S+)\s*$/m)?.[1]
  const host = (() => { try { return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '') } catch { return null } })()
  if (!host || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`the packaged app-update.yml names feed url [${url}], which is not `
      + 'loopback; even the value setFeedURL is about to replace must be unable to reach '
      + 'off this machine')
  }
  return info
}

/** ⚠ THE ARTIFACT'S IDENTITY, NOT ITS ADDRESS. Review measured that a plain
 *  downloaded installer passed every check and would then be launched by the
 *  app at handoff — performing the real installation a rehearsal promises
 *  cannot happen. Location said nothing about what the bytes were.
 *
 *  tools/build-update-fixture.mjs writes a provenance sidecar; this requires it
 *  to exist, to match the bytes about to be served, and to have been built from
 *  the build/update-fixture.nsi that is in this repository right now.
 *
 *  It prevents the WRONG FILE being chosen. It is not a defence against a
 *  forged sidecar, and it is not offered as one. */
export function assertFixtureProvenance(artifact, { repoRoot = process.cwd(), fileSystem = fs } = {}) {
  const exe = path.resolve(artifact)
  const sidecar = exe.replace(/\.exe$/i, '') + '.provenance.json'
  if (!fileSystem.existsSync(sidecar)) {
    throw new Error(`refusing to serve [${exe}] as the update artifact: no provenance beside `
      + `it at ${path.basename(sidecar)}. Only the fixture built by `
      + 'tools/build-update-fixture.mjs may be offered as an update — a location is not an '
      + 'identity, and an ordinary installer put here would really install')
  }
  let recorded
  try { recorded = JSON.parse(fileSystem.readFileSync(sidecar, 'utf8')) }
  catch (error) { throw new Error(`the provenance beside [${exe}] is unreadable: ${error.message}`) }

  const actual = crypto.createHash('sha256').update(fileSystem.readFileSync(exe)).digest('hex')
  if (recorded.sha256 !== actual) {
    throw new Error(`refusing to serve [${exe}]: its sha256 is ${actual.slice(0, 16)}… but the `
      + `provenance beside it records ${String(recorded.sha256).slice(0, 16)}…. These are not `
      + 'the bytes this repository built')
  }
  const source = path.resolve(repoRoot, recorded.source ?? 'build/update-fixture.nsi')
  if (!fileSystem.existsSync(source)) {
    throw new Error(`the fixture provenance names source [${recorded.source}], which is not `
      + 'in this repository')
  }
  const sourceSha = crypto.createHash('sha256')
    .update(fileSystem.readFileSync(source)).digest('hex')
  if (recorded.sourceSha256 !== sourceSha) {
    throw new Error(`the fixture was built from a different ${recorded.source} than the one in `
      + 'this repository; rebuild it with tools/build-update-fixture.mjs')
  }
  return { ...recorded, sha256: actual }
}

// --------------------------------------------------------------- elevation

/** A rehearsal needs no privileges at all: it unpacks a directory, serves
 *  loopback and runs one executable. Running elevated would let a mistake reach
 *  Program Files or HKLM, so it is refused rather than merely discouraged. */
/** ⚠ ONLY A POSITIVELY PARSED ANSWER COUNTS. Treating every non-'true' reply as
 *  'false' meant empty output, a truncated reply or a probe that never ran all
 *  read as "not elevated" — which is the answer that lets the run proceed.
 *  Anything that is not exactly True or False is unknown, and unknown is
 *  refused by assertNotElevated. */
export function isElevated(run = defaultPowerShell) {
  let out
  try {
    out = run('[bool](([Security.Principal.WindowsPrincipal]'
      + '[Security.Principal.WindowsIdentity]::GetCurrent())'
      + '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))')
  } catch {
    return null
  }
  const answer = String(out ?? '').trim().toLowerCase()
  if (answer === 'true') return true
  if (answer === 'false') return false
  return null
}

/** ⚠ UNKNOWN IS REFUSED, NOT WAVED THROUGH. This used to return null on a
 *  failed probe and let the run continue, which is a guard that disappears
 *  exactly when it cannot see — and this tooling already depends on PowerShell
 *  for the registry, so a probe that will not run is a broken machine rather
 *  than an awkward edge case. Fail closed. */
export function assertNotElevated(run = defaultPowerShell) {
  const elevated = isElevated(run)
  if (elevated === true) {
    throw new Error('refusing to rehearse from an elevated shell: nothing here needs '
      + 'administrator rights, and elevation is what would let a mistake reach the '
      + 'installed release')
  }
  if (elevated === null) {
    throw new Error('could not determine whether this shell is elevated, so the rehearsal '
      + 'is refused: a guard that passes when it cannot see is not a guard. Fix the '
      + 'PowerShell probe, or say explicitly that this shell is not elevated, and retry')
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

/** ⚠ EVERY LOCATION THE REGISTRY KNOWS ABOUT, not just the one chosen as "the"
 *  installation. resolveInstalledRoot picks a single root to take a baseline
 *  of; protection has to cover all of them, or a second installation on the
 *  machine is fair game for a rehearsal that only learned about the first. */
export function installedRootsFromRegistry({ entries = null, run = defaultPowerShell } = {}) {
  let found = entries
  if (!found) {
    try { found = orgtreeUninstallEntries(run) } catch { found = [] }
  }
  return [...new Set(found
    .map(e => e.InstallLocation)
    .filter(Boolean)
    .map(location => path.resolve(String(location))))]
}

export const RESERVATION_FILE = '.rehearsal-run.json'

/** ⚠ AN EXCLUSIVE CLAIM ON THE OUTPUT DIRECTORY, because a snapshot of running
 *  processes cannot see a SECOND rehearsal that is about to start. Cleanup
 *  identifies its processes by that directory; two concurrent runs sharing it
 *  would each terminate the other's app and each believe it was tidying up
 *  after itself.
 *
 *  Written with the exclusive flag, so the create either wins or fails — there
 *  is no window between checking and claiming. A reservation whose owning
 *  process is gone is stale and may be taken over; one whose owner is alive is
 *  refused. */
/** The shared storage claim. The dev data root and the updater cache are used
 *  by EVERY rehearsal on this machine regardless of where it packaged its
 *  build, so a claim scoped to the output directory does not protect them:
 *  review measured two runs with different --out and --work both launching and
 *  then sharing one dev data root. This claim lives beside that storage rather
 *  than inside it, because it has to exist before the storage does. */
export function sharedClaimFile(env = process.env) {
  return path.join(env.LOCALAPPDATA ?? '', `${REHEARSAL_UPDATER_CACHE}.claim.json`)
}

/** ⚠ ACQUIRE ONE CLAIM, EXCLUSIVELY, OR REFUSE.
 *
 *  The exclusive create is the ONLY arbiter. Review measured the hole in the
 *  previous version: exclusive-create and write-the-JSON are two filesystem
 *  events, so interleaving a second acquisition between them found an EMPTY
 *  file, could not parse it, called it stale and overwrote it — and both runs
 *  proceeded, both alive. So:
 *
 *  - an unreadable, empty or partially written claim REFUSES. Unknown is not
 *    dead, and this is exactly where that distinction bites;
 *  - a claim whose owner is alive REFUSES;
 *  - a claim whose owner is provably gone still refuses, unless recovery is
 *    explicitly asked for — and recovery is then done by REMOVING the stale
 *    file and racing the exclusive create again, so two recoverers cannot both
 *    win. There is no unguarded overwrite anywhere in this function. */
function acquireClaim(file, {
  fileSystem, pid, at, isAlive, reclaim, describe,
}) {
  const claim = JSON.stringify({ pid, at, file }, null, 2)
  fileSystem.mkdirSync(path.dirname(file), { recursive: true })
  const tryCreate = () => {
    try {
      fileSystem.writeFileSync(file, claim, { flag: 'wx' })
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
  }
  if (tryCreate()) return { file, taken: 'fresh', pid }

  let existing = null
  let unreadable = null
  try {
    const text = fileSystem.readFileSync(file, 'utf8')
    existing = JSON.parse(text)
    if (!existing || typeof existing.pid !== 'number') unreadable = 'it names no process'
  } catch (error) {
    unreadable = error?.code === 'ENOENT'
      // It vanished between the failed create and the read: somebody is moving,
      // so this is a live race and not an abandoned claim.
      ? 'it disappeared while being read — another run is acquiring it right now'
      : `it could not be read (${error?.code ?? error?.message ?? error})`
  }

  if (unreadable) {
    throw new Error(`refusing ${describe}: the existing claim at [${file}] cannot be trusted — `
      + `${unreadable}. A claim that is merely unreadable is NOT an abandoned one; treating it `
      + 'as abandoned is how two live runs both acquire. Remove it by hand if you are certain '
      + 'no rehearsal is running')
  }
  if (isAlive(existing.pid)) {
    throw new Error(`refusing ${describe}: process ${existing.pid} holds it, started `
      + `${existing.at ?? 'at an unrecorded time'}. Two runs sharing this would each stop the `
      + 'other\'s processes and each believe it was cleaning up after itself. Wait for it')
  }
  if (!reclaim) {
    throw new Error(`refusing ${describe}: a claim at [${file}] is held by process `
      + `${existing.pid}, which is no longer running. That is probably a crashed rehearsal — `
      + 're-run with --reclaim to take it over deliberately')
  }
  // Explicit recovery: remove, then RACE THE EXCLUSIVE CREATE AGAIN. Whoever
  // wins the create owns it; a second recoverer loses and is refused.
  try { fileSystem.rmSync(file, { force: true }) } catch { /* the create decides */ }
  if (!tryCreate()) {
    throw new Error(`refusing ${describe}: another run took [${file}] during recovery`)
  }
  return { file, taken: 'reclaimed', pid, previous: existing }
}

/** ⚠ EVERY SHARED MUTABLE RESOURCE, CLAIMED BEFORE ANY OF THEM IS CHECKED OR
 *  USED — the output directory AND the machine-wide dev storage. Acquired in a
 *  fixed order so two runs cannot deadlock, and every claim already taken is
 *  released if a later one refuses. */
export function reserveRehearsal(outDir, {
  fileSystem = fs, pid = process.pid, at = null, isAlive = defaultIsAlive,
  env = process.env, reclaim = false,
} = {}) {
  const stamp = at ?? new Date().toISOString()
  const wanted = [
    { file: sharedClaimFile(env),
      describe: 'to run: the machine\'s rehearsal storage is claimed' },
    { file: path.join(outDir, RESERVATION_FILE),
      describe: `to use [${outDir}]` },
  ]
  const held = []
  try {
    for (const { file, describe } of wanted) {
      held.push(acquireClaim(file, { fileSystem, pid, at: stamp, isAlive, reclaim, describe }))
    }
  } catch (error) {
    for (const claim of held) releaseRehearsal(claim, { fileSystem, pid })
    throw error
  }
  return { claims: held, pid, taken: held.map(c => c.taken).join('+') }
}

/** ⚠ RELEASE ONLY WHAT THIS INVOCATION HOLDS. Removing by filename alone would
 *  let a run that lost a race, or one whose claim was reclaimed underneath it,
 *  delete somebody else's live claim on the way out. */
export function releaseRehearsal(claim, { fileSystem = fs, pid = process.pid } = {}) {
  const file = typeof claim === 'string' ? claim : claim?.file
  if (!file) return false
  try {
    const existing = JSON.parse(fileSystem.readFileSync(file, 'utf8'))
    if (existing?.pid !== pid) return false
  } catch { return false }
  try { fileSystem.rmSync(file, { force: true }); return true } catch { return false }
}

export function releaseAll(reservation, { fileSystem = fs } = {}) {
  if (!reservation) return []
  return (reservation.claims ?? [])
    .filter(claim => releaseRehearsal(claim, { fileSystem, pid: reservation.pid }))
    .map(claim => claim.file)
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** Every Orgtree-ish process with a readable image path. Enumerated by PATH
 *  rather than by name, because the engine and its helpers run out of the same
 *  directory under names like python.exe — and a rehearsal that only looks for
 *  '*Orgtree*' leaves its own engine running after cleanup. */
export function processesWithPaths(run = defaultPowerShell) {
  const out = run('Get-Process -ErrorAction SilentlyContinue '
    + '| Where-Object { $_.Path } '
    + '| Select-Object Id, ProcessName, MainWindowTitle, Path | ConvertTo-Json -Compress').trim()
  const parsed = out ? JSON.parse(out) : []
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean)
}

/** ⚠ THE WHOLE INSTALLATION, NOT TWO FILES. The comparison used to hash
 *  Orgtree.exe and build-info.json and then announce that the installed release
 *  was "byte-for-byte untouched" — which said nothing about app.asar, the
 *  bundled engine runtime, or anything else an errant installer would rewrite.
 *  This walks the tree and records every file's relative path, size and
 *  modification time, so an addition, a removal or a rewrite anywhere under the
 *  installation shows up as a difference.
 *
 *  Size and mtime rather than a hash of every file: the runtime alone is tens
 *  of thousands of files, and a full hash would make the baseline too slow to
 *  take. The two files that decide identity are still hashed, and the claim
 *  made about the rest is exactly the one this measures. */
export function installedManifest(root, fileSystem = fs) {
  const files = []
  // ⚠ UNREADABLE IS NOT ABSENT, and conflating them is how a comparison passes
  // without looking. A directory that throws on enumeration used to be skipped
  // silently: an installation whose root could not be read produced an empty
  // manifest, and two empty manifests compare equal. Every failure is recorded
  // with its path and reason, and `complete` says whether the walk actually saw
  // the tree.
  const problems = []
  const walk = (directory, prefix) => {
    let entries
    try { entries = fileSystem.readdirSync(directory, { withFileTypes: true }) }
    catch (error) {
      problems.push(`${prefix || '.'}: ${error?.code ?? error?.message ?? 'unreadable'}`)
      return
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(full, relative); continue }
      try {
        const stat = fileSystem.statSync(full)
        files.push(`${relative}|${stat.size}|${Math.round(stat.mtimeMs)}`)
      } catch (error) {
        problems.push(`${relative}: ${error?.code ?? error?.message ?? 'unreadable'}`)
      }
    }
  }
  const present = fileSystem.existsSync(root)
  if (present) walk(root, '')
  files.sort()
  return {
    present,
    // Absent is complete — there is nothing to fail to read. Present-but-broken
    // is not.
    complete: !present || problems.length === 0,
    problems: problems.slice(0, 20),
    problemCount: problems.length,
    count: files.length,
    sha256: crypto.createHash('sha256').update(files.join('\n')).digest('hex'),
  }
}

export function snapshot({
  env = process.env, installedRoot = null, run = defaultPowerShell, fileSystem = fs,
} = {}) {
  const root = installedRoot ?? resolveInstalledRoot({ env, run })
  const buildInfo = path.join(root, 'resources', 'build-info.json')
  const exe = path.join(root, 'Orgtree.exe')
  return {
    installedRoot: root,
    installedBuildInfo: fileSystem.existsSync(buildInfo)
      ? { sha256: sha256(buildInfo), text: fileSystem.readFileSync(buildInfo, 'utf8') }
      : null,
    installedExe: fileSystem.existsSync(exe)
      ? { sha256: sha256(exe), size: fileSystem.statSync(exe).size }
      : null,
    installedTree: installedManifest(root, fileSystem),
    uninstall: uninstallKeys(orgtreeUninstallEntries(run)),
    productionDataExists: fileSystem.existsSync(productionDataRoot(env)),
    rehearsalDataExists: fileSystem.existsSync(rehearsalDataRoot(env)),
    rehearsalCacheExists: fileSystem.existsSync(
      path.join(env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE)),
  }
}

/** Pure: the after-the-fact comparison, so it can be tested without a machine
 *  that has Orgtree installed. Returns the same {name, ok, detail} rows the
 *  pre-flight checks use.
 *
 *  ⚠ EVERY ROW SAYS EXACTLY WHAT IT MEASURED. The names used to claim more than
 *  the checks performed, which is the kind of overstatement that turns a
 *  verification into a reassurance. */
export function compareSnapshots(before, after) {
  const rows = []
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const identityOk = eq(before.installedBuildInfo, after.installedBuildInfo)
    && eq(before.installedExe, after.installedExe)
  rows.push({
    name: 'the installed Orgtree.exe and build-info.json are byte-for-byte unchanged (sha256)',
    ok: identityOk,
    detail: identityOk
      ? `build-info sha256 ${after.installedBuildInfo?.sha256?.slice(0, 16) ?? '(absent)'}… unchanged`
      : 'the installed build-info.json or Orgtree.exe CHANGED',
  })
  // ⚠ THE NAME IS WHAT THIS ACTUALLY MEASURES. Path, size and mtime cannot see
  // a same-size edit that preserves the timestamp, so the row does not claim
  // content integrity. Only the two hashed files above carry a byte-level claim.
  const complete = before.installedTree?.complete === true
    && after.installedTree?.complete === true
  const treeOk = complete && eq(before.installedTree, after.installedTree)
  rows.push({
    name: 'no file under the installation was added, removed, or changed in size or '
      + 'modification time (metadata only — not a content hash)',
    ok: treeOk,
    detail: !complete
      // A comparison that could not read the tree is NOT a pass. The reason is
      // kept rather than turned into an absence.
      ? 'THE INSTALLATION COULD NOT BE FULLY ENUMERATED, so it was not verified: '
        + `${(after.installedTree?.problems ?? before.installedTree?.problems ?? []).join('; ')
          || 'no diagnostic recorded'}`
      : eq(before.installedTree, after.installedTree)
        ? `${after.installedTree?.count ?? 0} files, path/size/mtime digest `
          + `${after.installedTree?.sha256?.slice(0, 16) ?? '(absent)'}… unchanged`
        : `the installed tree CHANGED: ${before.installedTree?.count ?? 0} files → `
          + `${after.installedTree?.count ?? 0} files`,
  })
  rows.push({
    name: 'no uninstall entry was added, removed or changed (key, name, version, location)',
    ok: eq(before.uninstall, after.uninstall),
    detail: eq(before.uninstall, after.uninstall)
      ? `${after.uninstall.length} entries, unchanged`
      : `before: ${before.uninstall.join(' ; ')}\n       after:  ${after.uninstall.join(' ; ')}`,
  })
  rows.push({
    name: 'the production data root still exists exactly as it did (existence only)',
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
  isLoopback = () => true, fileSystem = fs, outDir = null, adopt = false,
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

  check('the rehearsal data root is PHYSICALLY separate from production', () => {
    // ⚠ SPELLINGS ARE NOT LOCATIONS. A junction at "Orgtree v2 Dev" pointing at
    // "Orgtree v2" is two names for one directory, and the lexical comparison
    // this used to do passed it happily — after which the rehearsal would run
    // on the user's real data through the dev name.
    const production = productionDataRoot(env)
    const rehearsal = rehearsalDataRoot(env)
    if (overlaps(rehearsal, production, fileSystem)) {
      throw new Error(`the rehearsal data root [${rehearsal}] and the production data root `
        + `[${production}] are the same physical directory, or one contains the other. `
        + 'Resolved: '
        + `[${realPath(rehearsal, fileSystem)}] vs [${realPath(production, fileSystem)}]`)
    }
    return `production=${production} rehearsal=${rehearsal} `
      + `(exists: ${fileSystem.existsSync(rehearsal)}; physically distinct)`
  })

  check('the production engine lock belongs to production alone', () => {
    // Attachment and locking are keyed by the data root, so separate roots mean
    // separate locks and separate dynamically chosen ports: the rehearsal
    // cannot attach to, or evict, the running release's engine. Compared on the
    // REAL locations, for the same reason as above.
    const lock = path.join(productionDataRoot(env), '.desktop-engine.lock')
    const rehearsalLock = path.join(rehearsalDataRoot(env), '.desktop-engine.lock')
    if (realPath(lock, fileSystem).toLowerCase()
      === realPath(rehearsalLock, fileSystem).toLowerCase()) {
      throw new Error('the two builds would share one engine lock: '
        + `[${realPath(lock, fileSystem)}]`)
    }
    return `production lock ${fileSystem.existsSync(lock) ? 'present' : 'absent'}; `
      + `the rehearsal's would be ${rehearsalLock}`
  })

  // ⚠ SHARED DEV DATA IS NOT THIS RUN'S TO USE. A quiet output directory says
  // nothing about the dev data root: another dev build can live at a different
  // output path and still own that storage. Preserving it during cleanup was
  // only half the problem — the rehearsal would still have RUN on it.
  check('the rehearsal data root and updater cache are not somebody else\'s', () => {
    const existing = []
    const dataRoot = rehearsalDataRoot(env)
    const cache = path.join(env.LOCALAPPDATA ?? '', REHEARSAL_UPDATER_CACHE)
    if (fileSystem.existsSync(dataRoot)) existing.push(dataRoot)
    if (fileSystem.existsSync(cache)) existing.push(cache)
    if (existing.length && !adopt) {
      throw new Error(`these already exist and are not this run's: ${existing.join(', ')}. `
        + 'A rehearsal wears the dev identity, so that storage may belong to an ordinary '
        + 'dev build. Move or remove it, or pass --adopt to run on it deliberately — with '
        + '--adopt nothing there is ever deleted')
    }
    if (existing.length) {
      return `ADOPTED (nothing here will be deleted): ${existing.join(', ')}`
    }
    return 'neither exists; this run creates and owns both'
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

  check('this shell is POSITIVELY known not to be elevated', () => {
    assertNotElevated(run)
    return 'not elevated'
  })

  // ⚠ OWNERSHIP IS ESTABLISHED BEFORE THE RUN, NOT GUESSED AFTER IT. Cleanup
  // identifies its own processes by the directory they run from, which is only
  // sound if NOTHING was already running from there when the run began. That
  // is a precondition this can check, so it does, rather than leaving cleanup
  // to assume it.
  check('nothing is already running out of the rehearsal directory', () => {
    if (!outDir) return 'no output directory named yet'
    const running = processesWithPaths(run)
      .filter(proc => isInside(proc.Path, outDir))
    if (running.length) {
      throw new Error('processes are ALREADY running out of '
        + `[${outDir}]: ${running.map(p => `${p.ProcessName} (${p.Id})`).join(', ')}. `
        + 'Close them first — this run identifies its own processes by that directory, '
        + 'and it will not adopt or terminate ones it did not start')
    }
    return `${outDir} has no running processes`
  })

  return rows
}

export function report(rows, {
  label = '', out = (line) => console.log(line), err = (line) => console.error(line),
} = {}) {
  for (const row of rows) out(`${row.ok ? 'PASS' : 'FAIL'} ${row.name}\n       ${row.detail}`)
  const failed = rows.filter(r => !r.ok)
  if (failed.length) {
    err(`\n${failed.length} ISOLATION CHECK(S) FAILED${label ? ` (${label})` : ''} — STOP.`)
    return false
  }
  out(`\nAll ${rows.length} isolation checks passed${label ? ` (${label})` : ''}.`)
  return true
}

// ---------------------------------------------------------------------- CLI

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  // fileURLToPath, not URL.pathname: a path with a space arrives percent-encoded
  // and would never match, which on Windows is most paths.
  try { return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url)) }
  catch { return false }
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
