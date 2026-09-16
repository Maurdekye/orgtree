/*
 * Fail-closed verification of the embedded Python runtime's PACKAGE LAYOUT.
 *
 * 2.1.4-RC4 shipped an installer whose payload carried every backend
 * dependency at `engine/runtime/site-packages` while the interpreter's
 * `python313._pth` names `Lib/site-packages` — the app could not import its
 * own server and never started. Nothing in the pipeline looked: the package
 * preflight checked six files, packaged-hashes hashed four, and the staging
 * copy into the release worktree was done by hand. This module is the check
 * that was missing, shared by the preflight (source tree), the release
 * command (win-unpacked payload and the extracted installer payload), and
 * their tests, so one definition of "correct runtime layout" exists.
 *
 * Nothing here installs, launches, or repairs anything. The import probe runs
 * the runtime's own python.exe against a neutral working directory and only
 * reports; every other function reads bytes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Third-party imports that prove the packaged server can come up. The same
 *  set provision-runtime.py smoke-imports after installing, plus pydantic —
 *  named separately in the release requirement — and starlette, FastAPI's
 *  own runtime substrate. */
export const REPRESENTATIVE_RUNTIME_IMPORTS = [
  'fastapi', 'pydantic', 'uvicorn', 'starlette', 'websockets', 'httpx', 'PIL', 'psutil',
]

/** Find the provisioned `engine/runtime`, searching UPWARD from `startDir`.
 *
 *  ⚠ THE UPWARD WALK IS THE POINT, and it is the same rule Node applies to
 *  `node_modules`. `engine/runtime` is gitignored, so it exists in the main
 *  checkout and in NO linked worktree. Every caller used to look only beside
 *  its own checkout, so from a worktree the runtime was simply "absent" and ten
 *  installer and runtime tests skipped themselves — quietly, in the environment
 *  where all the work actually happens. A reasoned skip is better than a silent
 *  pass, but ten tests that never run for any agent are still no coverage.
 *  Since this team's worktrees live under the repository root, the checkout
 *  that owns the runtime is always an ancestor.
 *
 *  `ORGTREE_ENGINE_RUNTIME` still wins when set, and `marker` is the file whose
 *  presence proves a real provisioned runtime rather than an empty directory —
 *  callers differ on whether they need `python.exe` or `pythonw.exe`.
 *  Returns null when nothing qualifies, so callers keep skipping with a reason.
 */
export function locateEngineRuntime(startDir, { marker = 'python.exe' } = {}) {
  const candidates = []
  if (process.env.ORGTREE_ENGINE_RUNTIME) candidates.push(process.env.ORGTREE_ENGINE_RUNTIME)
  let current = path.resolve(startDir)
  for (;;) {
    candidates.push(path.join(current, 'engine', 'runtime'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, marker))) return candidate
  }
  return null
}

export class RuntimeLayoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuntimeLayoutError'
  }
}

function fail(message) {
  throw new RuntimeLayoutError(message)
}

/** PEP 503/427 name normalization: dist-info directories on disk spell the
 *  project name lowercase with every run of `-_.` as one underscore. */
export function normalizeDistName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '_')
}

function requireDir(dir, label) {
  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    fail(`Missing ${label}: ${dir} (${error.message})`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${dir}`)
}

function requireFile(file, label) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    fail(`Missing ${label}: ${file} (${error.message})`)
  }
  if (!stat.isFile()) fail(`${label} must be a regular file: ${file}`)
}

/**
 * Assert the complete expected runtime package layout under `runtimeDir`.
 *
 * Checks, in the order a broken staging copy would trip them:
 *  - the interpreter, stdlib zip, `._pth` and manifest exist;
 *  - `python313._pth` still names `Lib/site-packages` (the configured
 *    package location every other check is anchored to);
 *  - `python313._pth` names `../mailhub`: a `._pth` interpreter ignores
 *    PYTHONPATH, so this entry is the only way the bundled mail hub's
 *    child processes can import their own package (2.1.6-beta.0 shipped
 *    a hub that could not start because this line was missing);
 *  - there is NO stray `site-packages` directly under the runtime — that is
 *    the exact RC4 mis-staging and it is refused by name, not merely by the
 *    absence of the right folder;
 *  - `Lib/site-packages` exists and carries a `<name>-<version>.dist-info`
 *    for every dependency `runtime-manifest.json` records, so a manifest
 *    that hashes a few loose files can never vouch for a gutted tree.
 *
 * Returns { manifest, sitePackages, distInfo } for callers that keep going.
 */
export function assertRuntimeLayout(runtimeDir, { label = 'runtime' } = {}) {
  requireDir(runtimeDir, `${label} directory`)
  requireFile(path.join(runtimeDir, 'python.exe'), `${label} interpreter`)
  requireFile(path.join(runtimeDir, 'python313.zip'), `${label} stdlib archive`)
  const pthFile = path.join(runtimeDir, 'python313._pth')
  requireFile(pthFile, `${label} python313._pth`)
  const manifestFile = path.join(runtimeDir, 'runtime-manifest.json')
  requireFile(manifestFile, `${label} runtime-manifest.json`)

  const pthLines = fs.readFileSync(pthFile, 'utf8').split(/\r?\n/).map(line => line.trim())
  if (!pthLines.includes('Lib/site-packages')) {
    fail(`${label} python313._pth no longer names Lib/site-packages; the layout contract moved without this check`)
  }
  if (!pthLines.includes('../mailhub')) {
    fail(`${label} python313._pth does not name ../mailhub — the embedded interpreter ignores PYTHONPATH, so `
      + 'without this entry the bundled mail hub cannot be imported by its child processes '
      + "(the 2.1.6-beta.0 \"No module named 'mailhub'\" startup failure)")
  }

  const stray = path.join(runtimeDir, 'site-packages')
  if (fs.existsSync(stray)) {
    fail(`${label} carries a stray top-level site-packages directory — packages staged outside Lib/site-packages `
      + 'are invisible to the embedded interpreter (this is the 2.1.4-RC4 layout failure)')
  }

  const sitePackages = path.join(runtimeDir, 'Lib', 'site-packages')
  requireDir(sitePackages, `${label} Lib/site-packages`)

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch (error) {
    fail(`${label} runtime-manifest.json is not JSON: ${error.message}`)
  }
  const dependencies = Array.isArray(manifest?.dependencies) ? manifest.dependencies : null
  if (!dependencies || !dependencies.length) fail(`${label} runtime-manifest.json records no dependencies`)

  const entries = new Set(fs.readdirSync(sitePackages))
  const distInfo = {}
  for (const dependency of dependencies) {
    const name = dependency?.name
    const version = dependency?.version
    if (!name || !version) fail(`${label} runtime-manifest.json has a dependency without name/version`)
    const expected = `${normalizeDistName(name)}-${version}.dist-info`
    if (!entries.has(expected)) {
      fail(`${label} Lib/site-packages is missing ${expected}; the packaged dependency set does not match runtime-manifest.json`)
    }
    distInfo[name] = expected
  }
  return { manifest, sitePackages, distInfo }
}

function walkFiles(dir, base, out, includePycache) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!includePycache && entry.name === '__pycache__') continue
      walkFiles(full, base, out, includePycache)
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'))
    } else {
      fail(`Runtime tree contains a non-regular entry: ${full}`)
    }
  }
  return out
}

/**
 * A deterministic digest of the WHOLE runtime tree: every file's relative
 * path and SHA-256, sorted, hashed together. `__pycache__` is excluded
 * because packaging excludes it; nothing else is. Two runtime trees with the
 * same digest carry identical bytes at identical places, which is exactly
 * the property the RC4 staging copy silently lost.
 */
export function runtimeTreeDigest(runtimeDir, { includePycache = false } = {}) {
  requireDir(runtimeDir, 'runtime directory')
  const files = walkFiles(runtimeDir, runtimeDir, [], includePycache).sort()
  if (!files.length) fail(`Runtime tree is empty: ${runtimeDir}`)
  const hash = crypto.createHash('sha256')
  for (const relative of files) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(runtimeDir, relative))).digest('hex')
    hash.update(`${relative}\n${digest}\n`)
  }
  return { files: files.length, sha256: hash.digest('hex') }
}

const PROBE_SOURCE = `
import json, pathlib, sqlite3, ssl, sys
mods = json.loads(sys.argv[1])
root = pathlib.Path(sys.executable).resolve().parent
report = {"python": sys.version.split()[0], "executable": str(pathlib.Path(sys.executable).resolve()), "modules": {}, "ok": True}
for name in mods:
    module = __import__(name)
    file = pathlib.Path(getattr(module, "__file__", "") or "").resolve()
    inside = root in file.parents
    report["modules"][name] = {"file": str(file), "inside": inside}
    report["ok"] = report["ok"] and inside
print(json.dumps(report))
sys.exit(0 if report["ok"] else 3)
`.trim()

/**
 * Run the runtime's OWN interpreter and import the representative backend
 * dependencies, refusing any module that resolves outside the runtime tree.
 *
 * The probe is deliberately hostile to ambient rescue: the working directory
 * is a neutral temp dir (never the checkout), and PYTHONPATH/PYTHONHOME/
 * PYTHONSTARTUP/PYTHONUSERBASE are scrubbed. The `._pth` beside python.exe
 * already pins sys.path, so a pass here is the packaged layout importing on
 * its own feet — the check the RC4 installer would have failed.
 */
export function assertRuntimeImports(runtimeDir, {
  imports = REPRESENTATIVE_RUNTIME_IMPORTS,
  spawnSyncImpl = spawnSync,
  cwd = os.tmpdir(),
} = {}) {
  const python = path.join(runtimeDir, 'python.exe')
  requireFile(python, 'runtime interpreter')
  const env = { ...process.env }
  for (const name of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONEXECUTABLE']) delete env[name]
  const result = spawnSyncImpl(python, ['-c', PROBE_SOURCE, JSON.stringify(imports)], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000,
  })
  if (result.error) fail(`Could not start the packaged interpreter: ${result.error.message}`)
  const stdout = (result.stdout || '').trim()
  let report = null
  try {
    report = JSON.parse(stdout.split(/\r?\n/).pop())
  } catch {
    // fall through to the status check with the raw output in the message
  }
  if (result.status !== 0 || !report || report.ok !== true) {
    const detail = report ? JSON.stringify(report.modules) : `${stdout}\n${(result.stderr || '').trim()}`.trim()
    fail(`Packaged runtime import probe failed (exit ${result.status ?? 'unknown'}): ${detail}`)
  }
  return report
}

/** The dependency tree's own 7-Zip, which reads NSIS installers. Kept inside
 *  node_modules so the extraction check needs nothing from the host. */
export function bundledSevenZip(root) {
  const vendor = path.join(root, 'node_modules', 'electron-winstaller', 'vendor')
  const exe = path.join(vendor, process.arch === 'arm64' ? '7z-arm64.exe' : '7z-x64.exe')
  requireFile(exe, 'bundled 7-Zip')
  return exe
}

function runSevenZip(sevenZip, args, spawnSyncImpl) {
  const result = spawnSyncImpl(sevenZip, args, { encoding: 'utf8', windowsHide: true, timeout: 600000 })
  if (result.error) fail(`Could not start 7-Zip: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`7-Zip ${args[0]} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim().slice(0, 2000)}`)
  }
  return result
}

/**
 * Extract the built installer's OWN payload runtime — not win-unpacked, the
 * bytes a user's machine would receive — into `workDir` and return the path
 * of the extracted `resources/engine/runtime` directory.
 *
 * Two hops, both read-only on the installer: the NSIS container yields
 * `$PLUGINSDIR/app-64.7z`, and that archive yields `resources/engine/**`.
 * The installer is never executed.
 */
export function extractInstallerEngine({ root, installer, workDir, spawnSyncImpl = spawnSync }) {
  requireFile(installer, 'Windows installer')
  const sevenZip = bundledSevenZip(root)
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })
  const containerDir = path.join(workDir, 'nsis')
  runSevenZip(sevenZip, ['x', '-y', `-o${containerDir}`, installer, '$PLUGINSDIR/app-64.7z'], spawnSyncImpl)
  const appArchive = path.join(containerDir, '$PLUGINSDIR', 'app-64.7z')
  requireFile(appArchive, 'installer payload app-64.7z')
  const payloadDir = path.join(workDir, 'payload')
  runSevenZip(sevenZip, ['x', '-y', `-o${payloadDir}`, appArchive, 'resources/engine/*'], spawnSyncImpl)
  const runtime = path.join(payloadDir, 'resources', 'engine', 'runtime')
  requireDir(runtime, 'extracted payload runtime')
  return { runtime, engine: path.join(payloadDir, 'resources', 'engine'), payloadDir }
}
