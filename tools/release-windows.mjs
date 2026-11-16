/*
 * Produce and, only when explicitly requested, publish a Windows release.
 *
 * The default path is deliberately local-only: it builds with electron-builder
 * publication disabled, derives the release manifests, stages the updater's
 * exact asset names, verifies every local byte, and writes a handoff for the
 * installation owner. The publish path is separate and is never selected by
 * credentials being present in the environment.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { REQUIRED_PACKAGE_INPUTS } from './preflight-lib.mjs'
import { recordFullyGatedBuild, runVerification } from './release-verification.mjs'
import { assertPublicReleaseAllowed } from './private-alpha-policy.mjs'
import { assertPostgresRuntime } from './postgres-layout.mjs'
import { extractInstallerEngine, SevenZipError } from './seven-zip.mjs'

export const RELEASE_MANIFEST_SCHEMA = 'orgtree.windows-release/v1'
export const HANDOFF_SCHEMA = 'orgtree.windows-installation-handoff/v1'
export const PUBLIC_VERIFICATION_SCHEMA = 'orgtree.windows-public-verification/v1'

// This is the six-asset set shipped by the proven 2.1.1 procedure. GitHub's
// generated source archives are not release assets and are intentionally not
// included here.
export const CANONICAL_ASSET_NAMES = version => [
  'build-info.json',
  'engine-hashes.json',
  // ⚠ NAMED AFTER THE CHANNEL, because that is the filename the updater asks
  // for: `beta.yml` for a beta build, `latest.yml` for a stable one.
  channelFileName(version),
  `Orgtree-Setup-${version}.exe`,
  `Orgtree-Setup-${version}.exe.blockmap`,
  'packaged-hashes.json',
]

// The package's default electron-builder names contain spaces. latest.yml and
// the public release use hyphens. The original files are never renamed in
// place; they are copied to the upload directory under these names.
export const installerSourceName = version => `Orgtree Setup ${version}.exe`
export const installerAssetName = version => `Orgtree-Setup-${version}.exe`

// What resources/engine ships since 4.6.1, keyed by packaged location, with
// the build output each one is copied from (package.json build.extraResources;
// tests/release-windows.test.mjs pins the two against each other). The
// PostgreSQL tree under postgresql/ is vouched for by its own manifest
// (tools/postgres-layout.mjs), which is the last entry here.
export const PACKAGED_ENGINE_FILES = {
  'engine/orgtree-engine.exe': 'engine/rs/target/release/orgtree-engine.exe',
  'engine/orgtree-credential-broker.exe': 'engine/rs/target/release/orgtree-credential-broker.exe',
  'engine/orgtree-installer-relaunch.exe': 'engine/rs/target/release/orgtree-installer-relaunch.exe',
  'engine/orgtree-mailhub.exe': 'engine/mailhub/target/release/orgtree-mailhub.exe',
  'engine/postgres-runtime-manifest.json': 'engine/postgres-runtime-manifest.json',
}

// Everything resources/engine may contain: the files above and the PostgreSQL
// directory. Anything else (an engine/runtime Python tree, *.py sources,
// backend/, pg-custodian.exe) is a packaging regression and is refused by name.
export const PACKAGED_ENGINE_ENTRIES = [
  ...Object.keys(PACKAGED_ENGINE_FILES).map(file => file.slice('engine/'.length)),
  'postgresql',
]

// These are the resource files hashed by packaged-hashes.json. Keep the list
// explicit: changing the schema must be a deliberate release-tooling change,
// not an accidental consequence of package contents. (Until 4.6.0 the engine
// entries were the embedded Python runtime's interpreter and manifest.)
export const PACKAGED_HASH_FILES = [
  'app.asar',
  'build-info.json',
  ...Object.keys(PACKAGED_ENGINE_FILES),
]

export const RELEASE_USAGE = `Usage:
  npm run release:windows -- <version>
  npm run release:windows -- <version> --publish
  npm run release:windows -- <version> --verification-receipt <path>

The default builds and verifies a local candidate only. --publish is the
explicit publication phase; it creates the tag/release and verifies every
public asset after downloading it back. Installation and restart are never
performed by this command.

<version> must be a final MAJOR.MINOR.PATCH version or a prerelease with the
exact MAJOR.MINOR.PATCH-beta.N form, such as 2.1.5-beta.4.

An -RCn label is REFUSED. The updater reads the prerelease label as a channel
name, so a build labelled RC3 sits on a channel whose only member is itself and
can never move onto a newer release. Use -beta.N.`

export function resolveNpmInvocation() {
  if (process.platform !== 'win32') return { command: 'npm', args: [] }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  requireRegularFile(npmCli, 'npm CLI')
  // .cmd files are shell scripts, and spawnSync without shell support rejects
  // them with EINVAL on Windows. Running the installed CLI through the same
  // Node executable is deterministic and does not invoke a shell.
  return { command: process.execPath, args: [npmCli] }
}

export class ReleaseError extends Error {
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'ReleaseError'
  }
}

function fail(message) {
  throw new ReleaseError(message)
}

function slash(value) {
  return value.split(path.sep).join('/')
}

function nativeRelative(root, relative) {
  return path.join(root, ...relative.split('/'))
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function resolveInside(root, relative, label) {
  const candidate = path.resolve(root, relative)
  if (!isInside(root, candidate)) fail(`${label} must stay inside the checkout: ${relative}`)
  return candidate
}

function realRoot(root) {
  try {
    return fs.realpathSync(path.resolve(root))
  } catch (error) {
    fail(`Release checkout does not exist: ${root} (${error.message})`)
  }
}

function samePath(left, right) {
  const normalize = value => path.normalize(value).replace(/[\\/]$/, '')
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function requireRegularFile(file, label) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    fail(`Missing ${label}: ${file} (${error.message})`)
  }
  if (!stat.isFile()) fail(`${label} must be a regular file: ${file}`)
}

function requireRealDirectory(directory, label) {
  let stat
  try {
    stat = fs.lstatSync(directory)
  } catch (error) {
    fail(`Missing ${label}: ${directory} (${error.message})`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real private directory, not a junction or symlink: ${directory}`)
  }
  let resolved
  try {
    resolved = fs.realpathSync(directory)
  } catch (error) {
    fail(`Could not resolve ${label}: ${directory} (${error.message})`)
  }
  // Windows junctions are directories but lstat().isSymbolicLink() is false.
  // Comparing the resolved target with the requested path catches junctions
  // and links in an ancestor without relying on platform-specific attributes.
  if (!samePath(resolved, path.resolve(directory))) {
    fail(`${label} must be a real private directory, not a junction or symlink: ${directory}`)
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`Cannot read ${label} as JSON: ${file} (${error.message})`)
  }
}

function writeJson(file, value, sortKeys = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, serializeJson(value, { sortKeys }), 'utf8')
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])]))
}

/** Match the 2.1.1 assets: two-space indentation, CRLF and a final newline. */
export function serializeJson(value, { sortKeys = false } = {}) {
  const body = JSON.stringify(sortKeys ? sortJson(value) : value, null, 2) + '\n'
  return body.replace(/\n/g, '\r\n')
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export function sha512Bytes(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('base64')
}

export function hashFile(file, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

/** ⚠ A PRERELEASE IS LABELLED `beta.N`, AND `RC<n>` IS DELIBERATELY REFUSED.
 *
 *  The updater reads the first dot-separated component of the prerelease label
 *  as a CHANNEL NAME and will only accept a release on a matching channel.
 *  `2.1.5-RC3` therefore sits on a channel called "RC3" whose only member is
 *  itself: measured, such a build is offered its own version, finds it is not
 *  newer, and never updates again. The library recognises exactly two channel
 *  names as a prerelease LINE that also moves up to stable — `alpha` and
 *  `beta` — so a `2.1.5-beta.4` build receives newer betas and takes stable
 *  2.1.5 when it appears.
 *
 *  Accepting an `RC` label here would let the stranding be re-published, which
 *  is why this refuses it rather than merely preferring beta. */
export function validReleaseVersion(version) {
  return typeof version === 'string'
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta)\.(0|[1-9]\d*))?$/.test(version)
}

/** The refusal an operator actually reads when their version is rejected.
 *
 *  ⚠ IT USED TO RECOMMEND THE ONE FORM THIS COMMAND REFUSES. Both call sites
 *  said "a release candidate such as 2.1.3-RC1" — the exact label
 *  `validReleaseVersion` rejects, and rejects for the concrete reason in the
 *  comment above. So the operator who typed `-RCn` was told to type `-RCn`,
 *  and the operator who typed anything else was pointed at a form that would
 *  fail next. Measured 2026-09-19: `2.1.9-RC1` refused with
 *  "…or a release candidate such as 2.1.3-RC1: 2.1.9-RC1".
 *
 *  It survived because `docs/windows-release.md` still described the RC rule
 *  too, so the message and the documentation agreed with each other and
 *  disagreed only with the code — and the test pinned the stale wording by
 *  matching on `/release candidate/`, which kept passing while saying nothing
 *  about whether the advice was usable. A release owner following either one
 *  is sent straight into a refusal.
 *
 *  One function so the two call sites cannot drift apart again. */
export function badVersionMessage(version) {
  return 'Target version must be a final semantic version such as 2.1.3, or a '
    + 'prerelease such as 2.1.3-beta.4 — only alpha.N and beta.N labels are '
    + 'accepted. An -RCn label is refused on purpose: the updater reads the '
    + 'prerelease label as a channel name, so an RC build sits on a channel '
    + 'whose only member is itself and can never update again. '
    + `Received: ${version}`
}

/** The prerelease channel a version is on, or null for a stable release. The
 *  same rule electron-builder uses to name its update manifest and
 *  electron-updater uses to decide what a build may accept. */
export function releaseChannelOf(version) {
  const label = /^\d+\.\d+\.\d+-(.+)$/.exec(String(version ?? '').trim())?.[1]
  return label ? label.split('.')[0] : null
}

export function isPrereleaseVersion(version) {
  return releaseChannelOf(version) !== null
}

/** ⚠ THE UPDATE MANIFEST IS NAMED AFTER THE CHANNEL, and the updater asks for
 *  exactly this filename. A beta build requests `beta.yml`; a stable build
 *  requests `latest.yml`. Publishing only `latest.yml` in a beta release would
 *  make every check 404 before falling back, so the manifest is published under
 *  the name that will be asked for.
 *
 *  electron-builder writes it as `latest.yml` whatever the version, because the
 *  release build runs with `--publish never` and so resolves no channel — which
 *  is why staging renames it rather than expecting the right name to appear. */
export function channelFileName(version) {
  assertPublicReleaseAllowed(version)
  const channel = releaseChannelOf(version)
  return channel === null ? 'latest.yml' : `${channel}.yml`
}

/** The publication flags for a version, as gh expects them. Kept as data rather
 *  than inline strings so the tests can assert on the decision itself.
 *
 *  ⚠ The updater asks GitHub for the latest NON-prerelease release, so anything
 *  published as a normal `--latest` release is a candidate for every installed
 *  stable build. This tooling published EVERY release that way, prereleases
 *  included — so a stable installation would have been offered 2.1.5-beta.4 the
 *  moment it appeared. A prerelease is published as a GitHub prerelease and is
 *  not marked latest: still public and downloadable, simply not the release
 *  that `releases/latest` hands out. */
export function releaseVisibility(version) {
  assertPublicReleaseAllowed(version)
  const prerelease = isPrereleaseVersion(version)
  return {
    prerelease,
    latest: !prerelease,
    flags: [`--prerelease=${prerelease}`, `--latest=${!prerelease}`],
  }
}


export function parseReleaseArgs(argv) {
  const parsed = { version: null, publish: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
    } else if (argument === '--publish') {
      if (parsed.publish) fail('The --publish flag was supplied more than once')
      parsed.publish = true
    } else if (argument === '--verification-receipt') {
      const receipt = argv[++index]
      if (!receipt) fail('The --verification-receipt flag needs a file path')
      parsed.verificationReceipt = receipt
    } else if (argument === '--base') {
      const base = argv[++index]
      if (!base) fail('The --base flag needs a commit')
      parsed.base = base
    } else if (argument.startsWith('-')) {
      fail(`Unknown release option: ${argument}\n\n${RELEASE_USAGE}`)
    } else if (parsed.version !== null) {
      fail(`Only one target version is allowed; got ${parsed.version} and ${argument}`)
    } else {
      parsed.version = argument
    }
  }
  if (!parsed.help && parsed.version === null) fail(`An explicit target version is required.\n\n${RELEASE_USAGE}`)
  if (!parsed.help && !validReleaseVersion(parsed.version)) fail(badVersionMessage(parsed.version))
  if (!parsed.help) assertPublicReleaseAllowed(parsed.version)
  return parsed
}

/** Describe the side-effect boundary without touching the checkout. This is
 * useful to callers and fixture tests that need to prove the ordinary command
 * has no tag, push, or GitHub publication operation in its plan. */
export function releasePlan(version, { publish = false } = {}) {
  assertPublicReleaseAllowed(version)
  if (!validReleaseVersion(version)) fail(badVersionMessage(version))
  const tag = `v${version}`
  return {
    mode: publish ? 'publish' : 'candidate',
    build: ['npm', 'run', 'package:win', '--', '--publish', 'never'],
    publication: publish ? {
      tag: ['git', 'tag', tag],
      push: ['git', 'push', 'origin', `refs/tags/${tag}`],
      create: ['gh', 'release', 'create', tag],
    } : null,
  }
}

function gitText(root, args, execFileSyncImpl = execFileSync) {
  try {
    return execFileSyncImpl('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch (error) {
    const detail = error.stderr?.toString?.().trim() || error.message
    fail(`Git command failed (${args.join(' ')}): ${detail}`)
  }
}

function gitStatus(root, execFileSyncImpl) {
  return gitText(root, ['status', '--porcelain', '--untracked-files=normal'], execFileSyncImpl)
}

function assertGitCheckout(root, execFileSyncImpl) {
  const topLevel = gitText(root, ['rev-parse', '--show-toplevel'], execFileSyncImpl).trim()
  if (!topLevel || !samePath(realRoot(topLevel), root)) {
    fail(`Release command must run from the worktree root, not ${root}`)
  }
}

function checkedExternal(command, args, root, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) fail(`Could not start ${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`)
  return result
}

function gitProbe(root, args, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('git', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) fail(`Could not start git (${args.join(' ')}): ${result.error.message}`)
  return result
}

export function assertCleanReleaseTree(porcelain) {
  if (typeof porcelain !== 'string') fail('Git status did not return text')
  if (porcelain.trim()) {
    fail(`Release requires a clean tracked checkout; refusing with Git status:\n${porcelain.trim()}`)
  }
}

export function assertVersionMatchesPackage(targetVersion, packageVersion) {
  if (targetVersion !== packageVersion) {
    fail(`Target version ${targetVersion} does not match package.json version ${packageVersion}; update version surfaces in a separate committed release change`)
  }
}

export function assertLockfileVersion(targetVersion, lockfile) {
  const rootVersion = lockfile?.packages?.['']?.version
  if (lockfile?.version !== targetVersion || rootVersion !== targetVersion) {
    fail(`Target version ${targetVersion} does not match both package-lock.json version surfaces (root=${lockfile?.version ?? 'missing'}, package=${rootVersion ?? 'missing'})`)
  }
}

export function assertNoTagCollision({ tag, local = false, remote = false }) {
  if (local) fail(`Release tag collision: local tag ${tag} already exists; refusing replacement`)
  if (remote) fail(`Release tag collision: remote tag ${tag} already exists; refusing replacement`)
}

function assertNoLocalTag(root, tag, spawnSyncImpl) {
  const result = gitProbe(root, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], spawnSyncImpl)
  if (result.status === 0) assertNoTagCollision({ tag, local: true })
  if (result.status !== 1) fail(`Could not establish that local tag ${tag} is absent`)
}

function assertNoRemoteTag(root, tag, spawnSyncImpl) {
  const remote = gitProbe(root, ['ls-remote', '--exit-code', '--refs', 'origin', `refs/tags/${tag}`], spawnSyncImpl)
  if (remote.status === 0) assertNoTagCollision({ tag, remote: true })
  // git ls-remote uses status 2 for a missing ref. Any other failure is an
  // unknown state, and a release must fail closed rather than assume absence.
  if (remote.status !== 2) fail(`Could not establish that remote tag ${tag} is absent`)
}

export function assertNotesFile(root, version, execFileSyncImpl = execFileSync) {
  const relative = `docs/release-notes-${version}.md`
  const file = resolveInside(root, relative, 'release notes')
  requireRegularFile(file, 'release notes')
  if (!fs.readFileSync(file, 'utf8').trim()) fail(`Release notes are empty: ${relative}`)
  try {
    gitText(root, ['ls-files', '--error-unmatch', '--', relative], execFileSyncImpl)
  } catch {
    fail(`Release notes must be checked in: ${relative}`)
  }
  return { relative, file }
}

function assertPackagePrerequisites(root) {
  // dist/renderer/index.html is generated by `npm run build`; the other
  // package inputs must already be provisioned before spending build time.
  for (const relative of REQUIRED_PACKAGE_INPUTS.filter(file => file !== 'dist/renderer/index.html')) {
    requireRegularFile(nativeRelative(root, relative), `package prerequisite ${relative}`)
  }
  // The PostgreSQL payload is checked byte for byte against its manifest
  // before spending build time, not merely found to exist.
  assertSourcePostgres(root)
  const nodeModules = nativeRelative(root, 'node_modules')
  requireRealDirectory(nodeModules, 'private node_modules')
  requireRegularFile(path.join(nodeModules, 'electron', 'package.json'), 'Electron dependency')
  requireRegularFile(path.join(nodeModules, 'electron-builder', 'package.json'), 'electron-builder dependency')
}

function postgresOrFail(engineDirectory, label, options) {
  try {
    return assertPostgresRuntime(engineDirectory, options)
  } catch (error) {
    if (error instanceof ReleaseError) throw error
    fail(`${label}: ${error.message}`)
  }
}

function assertSourcePostgres(root) {
  return postgresOrFail(nativeRelative(root, 'engine'), 'Source PostgreSQL payload', { sourceRoot: root })
}

/**
 * Refuse anything in a packaged `resources/engine` beyond what 4.6.1 ships:
 * the engine executables, the PostgreSQL manifest and its `postgresql/` tree.
 * The retired embedded Python runtime is named explicitly, because a stale
 * package.json filter or a hand-staged worktree would bring it back silently.
 */
export function assertPackagedEngineLayout(engineDirectory, label) {
  requireRealDirectory(engineDirectory, label)
  const allowed = new Set(PACKAGED_ENGINE_ENTRIES)
  for (const entry of fs.readdirSync(engineDirectory, { withFileTypes: true })) {
    if (allowed.has(entry.name)) continue
    if (entry.name === 'runtime') fail(`${label} still carries runtime/, the retired embedded Python runtime; 4.6.1 ships no Python`)
    if (/\.pyw?$/i.test(entry.name) || entry.name === 'backend') fail(`${label} still carries Python engine source ${entry.name}; 4.6.1 ships no Python`)
    fail(`${label} carries an unexpected entry ${entry.name}; package.json build.extraResources must ship only ${PACKAGED_ENGINE_ENTRIES.join(', ')}`)
  }
  for (const relative of Object.keys(PACKAGED_ENGINE_FILES)) {
    requireRegularFile(path.join(engineDirectory, relative.slice('engine/'.length)), `${label} ${relative.slice('engine/'.length)}`)
  }
  requireRealDirectory(path.join(engineDirectory, 'postgresql'), `${label} postgresql`)
}

/** A deterministic digest of the shipped engine files under `resources`:
 *  each packaged path and its SHA-256, in PACKAGED_ENGINE_FILES order. */
export function packagedEngineDigest(resources) {
  const hash = crypto.createHash('sha256')
  const hashes = {}
  for (const relative of Object.keys(PACKAGED_ENGINE_FILES)) {
    const file = nativeRelative(resources, relative)
    requireRegularFile(file, `packaged ${relative}`)
    hashes[relative] = hashFile(file)
    hash.update(`${relative}\n${hashes[relative]}\n`)
  }
  return { files: Object.keys(hashes).length, sha256: hash.digest('hex'), hashes }
}

/** Run `orgtree-engine.exe --version` from a neutral working directory. The
 *  release build prints exactly `orgtree-engine <version>`; a development
 *  build appends ` (dev)` and is refused. */
export function probeEngineVersion(exe, { version = null, label, spawnSyncImpl = spawnSync } = {}) {
  requireRegularFile(exe, label)
  const result = spawnSyncImpl(exe, ['--version'], { cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 60000 })
  if (result.error) fail(`Could not start ${label} ${exe}: ${result.error.message}`)
  const output = String(result.stdout || '').trim()
  if (result.status !== 0) fail(`${label} --version failed (exit ${result.status ?? 'unknown'}): ${output || String(result.stderr || '').trim()}`)
  if (/\(dev\)/.test(output)) fail(`${label} is a development build (${output}); rebuild it with ORGTREE_RELEASE_BUILD=1`)
  if (version ? output !== `orgtree-engine ${version}` : !/^orgtree-engine \d+\.\d+\.\d+\S*$/.test(output)) {
    fail(`${label} reports ${JSON.stringify(output)}, expected ${version ? `"orgtree-engine ${version}"` : 'a release "orgtree-engine <version>"'}`)
  }
  return output
}

/**
 * Verify the PACKAGED engine — the win-unpacked payload electron-builder
 * compresses into the installer — against what was built:
 *  - resources/engine holds exactly the shipped entries (no Python runtime);
 *  - every engine executable, the relaunch helper and the PostgreSQL manifest
 *    are byte-identical to the build outputs they were copied from, so a
 *    packaging step that shipped a stale or missing binary is named;
 *  - the PostgreSQL tree matches its manifest, and that manifest the source's;
 *  - the packaged orgtree-engine.exe starts and reports the release version.
 */
export function verifyPackagedEngine({ root, resources, version = null, spawnSyncImpl = spawnSync }) {
  const engineDirectory = path.join(resources, 'engine')
  assertPackagedEngineLayout(engineDirectory, 'packaged resources/engine')
  const sourcePostgres = assertSourcePostgres(root)
  const packagedPostgres = postgresOrFail(engineDirectory, 'Packaged PostgreSQL payload')
  if (sourcePostgres.manifestSha256 !== packagedPostgres.manifestSha256) fail('Packaged PostgreSQL differs from source')
  const digest = packagedEngineDigest(resources)
  for (const [packaged, source] of Object.entries(PACKAGED_ENGINE_FILES)) {
    const sourceFile = nativeRelative(root, source)
    requireRegularFile(sourceFile, `built ${source}`)
    const built = hashFile(sourceFile)
    if (built !== digest.hashes[packaged]) {
      fail(`Packaged ${packaged} differs from the built ${source} (packaged ${digest.hashes[packaged]}, built ${built}); the payload would not run what was built`)
    }
  }
  const engineVersion = probeEngineVersion(path.join(engineDirectory, 'orgtree-engine.exe'),
    { version, label: 'packaged orgtree-engine.exe', spawnSyncImpl })
  return { digest, postgresManifestSha256: packagedPostgres.manifestSha256, engineVersion }
}

/**
 * Verify the engine inside the BUILT INSTALLER's own payload — the bytes a
 * user's machine receives — without executing the installer: extract
 * `app-64.7z` with the dependency tree's 7-Zip, require the same entries,
 * the identical engine digest and PostgreSQL manifest as the verified
 * win-unpacked payload, and the extracted orgtree-engine.exe's version.
 */
export function verifyInstallerPayloadEngine({ root, installer, workDir, expectedDigest, expectedPostgresManifestSha256, version = null, spawnSyncImpl = spawnSync }) {
  try {
    const extracted = extractInstallerEngine({ root, installer, workDir, spawnSyncImpl })
    assertPackagedEngineLayout(extracted.engine, 'installer payload resources/engine')
    const postgres = postgresOrFail(extracted.engine, 'Installer payload PostgreSQL')
    if (!expectedPostgresManifestSha256 || postgres.manifestSha256 !== expectedPostgresManifestSha256) {
      fail('Installer payload PostgreSQL differs from the verified packaged PostgreSQL manifest')
    }
    const digest = packagedEngineDigest(path.dirname(extracted.engine))
    if (!expectedDigest || digest.sha256 !== expectedDigest.sha256 || digest.files !== expectedDigest.files) {
      const changed = Object.keys(digest.hashes).filter(file => digest.hashes[file] !== expectedDigest?.hashes?.[file])
      fail(`Installer payload engine differs from the verified packaged engine (${changed.join(', ') || 'no verified digest'}); `
        + `payload ${digest.files} files ${digest.sha256}, expected ${expectedDigest?.files ?? 'none'} files ${expectedDigest?.sha256 ?? 'none'}`)
    }
    const engineVersion = probeEngineVersion(path.join(extracted.engine, 'orgtree-engine.exe'),
      { version, label: 'installer payload orgtree-engine.exe', spawnSyncImpl })
    return { digest, postgresManifestSha256: postgres.manifestSha256, engineVersion }
  } catch (error) {
    if (error instanceof SevenZipError) fail(error.message)
    throw error
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

/** The packaged-hashes.json `engine` section: the verified win-unpacked
 *  engine digest and version, and the installer payload's matching digest. */
export function packagedEngineRecord(packaged, payload) {
  return {
    files: packaged.digest.files,
    sha256: packaged.digest.sha256,
    version: packaged.engineVersion,
    postgresManifestSha256: packaged.postgresManifestSha256,
    payload: { files: payload.digest.files, sha256: payload.digest.sha256, version: payload.engineVersion },
  }
}

function assertAllPackageInputs(root) {
  for (const relative of REQUIRED_PACKAGE_INPUTS) {
    requireRegularFile(nativeRelative(root, relative), `package prerequisite ${relative}`)
  }
}

export function assertBuildProvenance(info, { root, head, porcelain, version }) {
  assertPublicReleaseAllowed(version, info)
  if (!info || typeof info !== 'object') fail('dist/build-info.json is not an object')
  if (info.channel !== 'release') fail(`Release packaging refuses build channel ${JSON.stringify(info.channel)}; rebuild the release channel`)
  if (info.version !== version) fail(`Build version ${info.version} does not match target version ${version}`)
  if (info.commit !== head || info.dirty !== false || porcelain.trim()) {
    fail(`Build provenance does not match the clean HEAD ${head}; rebuild from the exact committed checkout`)
  }
  if (!info.commit || !/^[0-9a-f]{40}$/.test(info.commit)) fail('Build provenance does not contain a full 40-character commit SHA')
  if (!info.sha256 || typeof info.sha256 !== 'object' || Array.isArray(info.sha256)) fail('Build provenance has no input hash map')
  for (const [relative, expected] of Object.entries(info.sha256)) {
    const file = resolveInside(root, relative, 'build input')
    requireRegularFile(file, `build input ${relative}`)
    if (hashFile(file) !== expected) fail(`Build input changed after it was stamped: ${relative}`)
  }
  return info
}

/** engine-hashes.json: what the engine payload must contain, from the BUILD
 *  OUTPUTS rather than the package — each packaged engine path (sorted) and
 *  the SHA-256 of the file it is copied from. Until 4.6.0 this hashed the
 *  tracked engine Python sources, which shipped as-is; since 4.6.1 the engine
 *  ships compiled, so the build outputs are what the payload is held to. */
export function deriveEngineHashes({ root, hash = hashFile }) {
  const result = {}
  for (const packaged of Object.keys(PACKAGED_ENGINE_FILES).sort()) {
    const source = PACKAGED_ENGINE_FILES[packaged]
    const file = resolveInside(root, source, 'engine build output')
    requireRegularFile(file, `engine build output ${source}`)
    result[packaged] = hash(file)
  }
  return result
}

export function derivePackagedHashes({ resources, installer, commit, version, hash = hashFile, engine = null }) {
  const files = {}
  for (const relative of PACKAGED_HASH_FILES) {
    const file = nativeRelative(resources, relative)
    requireRegularFile(file, `packaged resource ${relative}`)
    files[relative] = hash(file)
  }
  requireRegularFile(installer, 'Windows installer')
  return {
    commit,
    version,
    files,
    // The verified engine payload: digest over the shipped engine files, the
    // version the packaged orgtree-engine.exe reported, the PostgreSQL
    // manifest, and the installer payload's own matching digest. (Until 4.6.0
    // this section was `runtime`, the embedded Python tree's digest.)
    ...(engine ? { engine } : {}),
    installerSha256: hash(installer),
  }
}

function scalar(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Parse the small, stable electron-builder latest.yml schema without adding a
 * YAML dependency to the release path. Unknown top-level fields are retained
 * only when useful to a human receipt; required fields are validated below. */
export function parseLatestYml(text) {
  if (typeof text !== 'string') fail('latest.yml must be text')
  const parsed = { version: null, files: [], path: null, sha512: null, releaseDate: null }
  let currentFile = null
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let match
    if ((match = line.match(/^version:\s*(.*?)\s*$/))) parsed.version = scalar(match[1])
    else if ((match = line.match(/^path:\s*(.*?)\s*$/))) parsed.path = scalar(match[1])
    else if ((match = line.match(/^sha512:\s*(.*?)\s*$/))) parsed.sha512 = scalar(match[1])
    else if ((match = line.match(/^releaseDate:\s*(.*?)\s*$/))) parsed.releaseDate = scalar(match[1])
    else if ((match = line.match(/^\s+-\s+url:\s*(.*?)\s*$/))) {
      currentFile = { url: scalar(match[1]), sha512: null, size: null }
      parsed.files.push(currentFile)
    } else if (currentFile && (match = line.match(/^\s+sha512:\s*(.*?)\s*$/))) currentFile.sha512 = scalar(match[1])
    else if (currentFile && (match = line.match(/^\s+size:\s*(\d+)\s*$/))) currentFile.size = Number(match[1])
  }
  return parsed
}

export function validateLatestYml(text, { version, installerName, installerBytes }) {
  const parsed = parseLatestYml(text)
  if (parsed.version !== version) fail(`latest.yml version ${parsed.version} does not match ${version}`)
  if (parsed.path !== installerName) fail(`latest.yml path must be ${installerName}, got ${parsed.path}`)
  if (parsed.files.length !== 1 || parsed.files[0].url !== installerName) {
    fail(`latest.yml must contain exactly one updater file named ${installerName}`)
  }
  const expectedSha512 = sha512Bytes(installerBytes)
  const file = parsed.files[0]
  if (parsed.sha512 !== expectedSha512 || file.sha512 !== expectedSha512) {
    fail('latest.yml SHA-512 does not match the staged installer bytes')
  }
  if (file.size !== installerBytes.length) fail(`latest.yml installer size ${file.size} does not match ${installerBytes.length}`)
  return parsed
}

function sameBytes(left, right, label) {
  if (!left.equals(right)) fail(`Staged ${label} is not byte-for-byte identical to its source`)
}

export function stageCanonicalAssets({ root, releaseDir, version, engineHashes, packagedHashes }) {
  assertPublicReleaseAllowed(version)
  const resources = path.join(releaseDir, 'win-unpacked', 'resources')
  const sourceInstaller = path.join(releaseDir, installerSourceName(version))
  const sourceBlockmap = `${sourceInstaller}.blockmap`
  const sourceMap = new Map([
    ['build-info.json', path.join(resources, 'build-info.json')],
    ['engine-hashes.json', path.join(releaseDir, 'engine-hashes.json')],
    // ⚠ electron-builder always writes `latest.yml` here, whatever the
    // version, because the release build runs with `--publish never` and so
    // resolves no channel. It is STAGED under the name the updater will ask
    // for — `beta.yml` for a beta release.
    [channelFileName(version), path.join(releaseDir, 'latest.yml')],
    [installerAssetName(version), sourceInstaller],
    [`${installerAssetName(version)}.blockmap`, sourceBlockmap],
    ['packaged-hashes.json', path.join(releaseDir, 'packaged-hashes.json')],
  ])
  // Write the generated manifests before copying so the map describes only
  // repository-owned outputs and the source package files.
  writeJson(path.join(releaseDir, 'engine-hashes.json'), engineHashes, true)
  writeJson(path.join(releaseDir, 'packaged-hashes.json'), packagedHashes, false)
  for (const [name, source] of sourceMap) requireRegularFile(source, `release asset source ${name}`)

  const uploadDir = path.join(releaseDir, 'upload')
  fs.mkdirSync(uploadDir, { recursive: true })
  requireRealDirectory(uploadDir, 'release upload directory')
  for (const [name, source] of sourceMap) {
    const destination = path.join(uploadDir, name)
    fs.copyFileSync(source, destination)
    sameBytes(fs.readFileSync(destination), fs.readFileSync(source), name)
  }
  const installerBytes = fs.readFileSync(path.join(uploadDir, installerAssetName(version)))
  validateLatestYml(fs.readFileSync(path.join(uploadDir, channelFileName(version)), 'utf8'), {
    version,
    installerName: installerAssetName(version),
    installerBytes,
  })
  return { uploadDir, resources, sourceInstaller, sourceBlockmap, sourceMap, installerBytes }
}

function artifactRecord(root, name, file, source = null) {
  const bytes = fs.readFileSync(file)
  return {
    name,
    path: slash(path.relative(root, file)),
    ...(source ? { source: slash(path.relative(root, source)) } : {}),
    size: bytes.length,
    sha256: sha256Bytes(bytes),
    sha512: sha512Bytes(bytes),
  }
}

function assertRecordMatches(root, record) {
  const file = resolveInside(root, record.path, `candidate artifact ${record.name}`)
  requireRegularFile(file, `candidate artifact ${record.name}`)
  const bytes = fs.readFileSync(file)
  if (bytes.length !== record.size || sha256Bytes(bytes) !== record.sha256 || sha512Bytes(bytes) !== record.sha512) {
    fail(`Candidate artifact ${record.name} changed after its manifest was written`)
  }
  return bytes
}

export function verifyLocalCandidate({ root, manifest, uploadDir, resources, engineHashes }) {
  const expectedNames = CANONICAL_ASSET_NAMES(manifest.version)
  const records = manifest.artifacts
  if (!Array.isArray(records) || records.map(record => record.name).sort().join('\n') !== [...expectedNames].sort().join('\n')) {
    fail('Release manifest does not contain exactly the canonical six assets')
  }
  const byName = new Map(records.map(record => [record.name, record]))
  for (const name of expectedNames) {
    const record = byName.get(name)
    if (!record || record.path !== slash(path.relative(root, path.join(uploadDir, name)))) fail(`Manifest path for ${name} is not its staged upload path`)
    assertRecordMatches(root, record)
  }
  const installerBytes = fs.readFileSync(path.join(uploadDir, installerAssetName(manifest.version)))
  validateLatestYml(fs.readFileSync(path.join(uploadDir, channelFileName(manifest.version)), 'utf8'), {
    version: manifest.version,
    installerName: installerAssetName(manifest.version),
    installerBytes,
  })
  const buildInfo = readJson(path.join(uploadDir, 'build-info.json'), 'staged build-info.json')
  if (buildInfo.version !== manifest.version || buildInfo.commit !== manifest.commit || buildInfo.channel !== 'release' || buildInfo.dirty !== false) {
    fail('Staged build-info.json does not identify this clean release candidate')
  }
  const packaged = readJson(path.join(uploadDir, 'packaged-hashes.json'), 'packaged-hashes.json')
  if (packaged.commit !== manifest.commit || packaged.version !== manifest.version || packaged.installerSha256 !== sha256Bytes(installerBytes)) {
    fail('packaged-hashes.json does not identify the staged candidate')
  }
  const packagedNames = Object.keys(packaged.files || {})
  if (packagedNames.sort().join('\n') !== [...PACKAGED_HASH_FILES].sort().join('\n')) {
    fail('packaged-hashes.json does not contain exactly the canonical resource hash set')
  }
  for (const [relative, expected] of Object.entries(packaged.files || {})) {
    const file = nativeRelative(resources, relative)
    requireRegularFile(file, `packaged resource ${relative}`)
    if (hashFile(file) !== expected) fail(`Packaged resource hash mismatch: ${relative}`)
  }
  // The engine section must describe the packaged engine as it sits on disk
  // right now — recomputed here, not trusted from the earlier derivation.
  assertPackagedEngineLayout(path.join(resources, 'engine'), 'packaged resources/engine')
  if (!packaged.engine || typeof packaged.engine !== 'object') {
    fail('packaged-hashes.json does not record the verified engine payload')
  }
  const packagedDigest = packagedEngineDigest(resources)
  if (packaged.engine.files !== packagedDigest.files || packaged.engine.sha256 !== packagedDigest.sha256) {
    fail('packaged-hashes.json engine digest does not match the packaged engine files')
  }
  if (packaged.engine.payload?.files !== packagedDigest.files || packaged.engine.payload?.sha256 !== packagedDigest.sha256) {
    fail('packaged-hashes.json does not record an installer payload engine identical to the packaged engine')
  }
  const expectedVersion = `orgtree-engine ${manifest.version}`
  if (packaged.engine.version !== expectedVersion || packaged.engine.payload.version !== expectedVersion) {
    fail(`packaged-hashes.json engine version is ${JSON.stringify(packaged.engine.version)} (payload ${JSON.stringify(packaged.engine.payload.version)}), expected "${expectedVersion}"`)
  }
  const actualEngine = readJson(path.join(uploadDir, 'engine-hashes.json'), 'engine-hashes.json')
  if (JSON.stringify(actualEngine) !== JSON.stringify(engineHashes)) fail('engine-hashes.json does not match the engine build outputs')
  // Built = shipped: every packaged engine file is the build output
  // engine-hashes.json recorded for it.
  for (const relative of Object.keys(PACKAGED_ENGINE_FILES)) {
    if (actualEngine[relative] !== packaged.files[relative]) {
      fail(`Packaged ${relative} differs from the build output ${PACKAGED_ENGINE_FILES[relative]} recorded in engine-hashes.json`)
    }
  }
  return {
    buildInfo, packaged,
    latest: parseLatestYml(
      fs.readFileSync(path.join(uploadDir, channelFileName(manifest.version)), 'utf8')),
  }
}

function githubConfig(packageJson) {
  const entries = packageJson?.build?.publish
  const config = Array.isArray(entries) ? entries.find(entry => entry?.provider === 'github') : null
  if (!config?.owner || !config?.repo) fail('package.json build.publish has no GitHub owner/repository')
  if (config.releaseType && config.releaseType !== 'release') fail(`Release tooling requires a normal GitHub release, not ${config.releaseType}`)
  return { owner: config.owner, repo: config.repo }
}

function githubApiUrl(owner, repo, suffix) {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${suffix}`
}

function githubDownloadPrefix(owner, repo, tag) {
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/`
}

function responseOk(response) {
  return response && (response.ok === true || (typeof response.status === 'number' && response.status >= 200 && response.status < 300))
}

async function responseJson(response, url) {
  if (!responseOk(response)) {
    const status = response?.status ?? 'unknown'
    fail(`GitHub request failed (${status}): ${url}`)
  }
  try {
    return await response.json()
  } catch (error) {
    fail(`GitHub returned invalid JSON for ${url}: ${error.message}`)
  }
}

function githubHeaders(accept) {
  const headers = { Accept: accept, 'User-Agent': 'orgtree-release-tool' }
  // Public endpoints work unauthenticated, but publication verification should
  // use the same authenticated view as the creating CLI when a token exists.
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
  return headers
}

export function assertReleaseVerification(receipt, { commit }) {
  if (!receipt || receipt.schema !== 'orgtree.windows-release-verification/v1' || receipt.green !== true) {
    fail('Release requires a green canonical release-verification receipt')
  }
  if (receipt.candidate !== commit) {
    fail(`Release verification receipt targets ${receipt.candidate || 'unknown'}, not candidate ${commit}`)
  }
  if (!receipt.fingerprint || !receipt.sourceFingerprint || !Array.isArray(receipt.commands) || !receipt.commands.length) {
    fail('Release verification receipt is incomplete or cannot be tied to its tested source scope')
  }
  return receipt
}

function retryableStatus(status) {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500
}

async function fetchWithRetry(fetchImpl, url, { accept, retries = 4, delayMs = 250,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: githubHeaders(accept) })
      if (responseOk(response) || !retryableStatus(response?.status) || attempt === retries) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === retries) throw error
    }
    if (delayMs > 0) await sleep(delayMs * (attempt + 1))
  }
  throw lastError || new Error('request failed')
}

async function fetchJson(fetchImpl, url, options = {}) {
  let response
  try {
    response = await fetchWithRetry(fetchImpl, url, { accept: 'application/vnd.github+json', ...options })
  } catch (error) {
    fail(`Could not reach public GitHub endpoint ${url}: ${error.message}`)
  }
  return responseJson(response, url)
}

export async function assertNoPublicRelease({ owner, repo, tag, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') fail('Public release collision check requires fetch')
  const url = githubApiUrl(owner, repo, `releases/tags/${encodeURIComponent(tag)}`)
  let response
  try {
    // Collision checks are intentionally immediate: a 404 is the proof of
    // absence required before mutation. Retries belong to post-publication
    // verification, where draft-to-public propagation can briefly return 404.
    response = await fetchWithRetry(fetchImpl, url, { accept: 'application/vnd.github+json', retries: 0, delayMs: 0 })
  } catch (error) {
    fail(`Could not establish that public release ${tag} is absent: ${error.message}`)
  }
  if (response?.status === 404) return { exists: false, tag }
  if (responseOk(response)) fail(`Public release collision: ${owner}/${repo} already has release ${tag}; refusing replacement`)
  fail(`Could not establish that public release ${tag} is absent (HTTP ${response?.status ?? 'unknown'})`)
}

async function downloadPublicAsset(fetchImpl, owner, repo, tag, asset, retry = {}) {
  const url = asset.browser_download_url || `${githubDownloadPrefix(owner, repo, tag)}${encodeURIComponent(asset.name)}`
  const prefix = githubDownloadPrefix(owner, repo, tag)
  if (!url.startsWith(prefix)) fail(`Release asset ${asset.name} does not use its public download endpoint`)
  let response
  try {
    response = await fetchWithRetry(fetchImpl, url, { accept: 'application/octet-stream', ...retry })
  } catch (error) {
    fail(`Could not download public asset ${asset.name}: ${error.message}`)
  }
  if (!responseOk(response)) fail(`Public asset ${asset.name} returned HTTP ${response?.status ?? 'unknown'}`)
  try {
    return { url, bytes: Buffer.from(await response.arrayBuffer()) }
  } catch (error) {
    fail(`Could not read public asset ${asset.name}: ${error.message}`)
  }
}

async function resolvePublicTagCommit(fetchImpl, owner, repo, tag, retry = {}) {
  const refUrl = githubApiUrl(owner, repo, `git/ref/tags/${encodeURIComponent(tag)}`)
  const ref = await fetchJson(fetchImpl, refUrl, retry)
  let object = ref.object
  if (!object?.sha) fail(`Public tag ${tag} has no Git object`)
  while (object.type === 'tag') {
    const annotated = await fetchJson(fetchImpl, githubApiUrl(owner, repo, `git/tags/${encodeURIComponent(object.sha)}`), retry)
    object = annotated.object
    if (!object?.sha) fail(`Annotated public tag ${tag} has no commit target`)
  }
  return { sha: object.sha, type: object.type || 'commit' }
}

export async function verifyPublicRelease({ manifest, owner, repo, tag = manifest.tag, fetchImpl = globalThis.fetch, retry = {} }) {
  if (typeof fetchImpl !== 'function') fail('Public release verification requires fetch')
  const release = await fetchJson(fetchImpl, githubApiUrl(owner, repo, `releases/tags/${encodeURIComponent(tag)}`), retry)
  if (release.tag_name !== tag) fail(`Public release tag is ${release.tag_name}, expected ${tag}`)
  if (release.name !== `Orgtree ${manifest.version}`) fail(`Public release title is ${release.name}, expected Orgtree ${manifest.version}`)
  if (release.draft === true) fail('Public release is still a draft')
  // ⚠ THE PRERELEASE FLAG MUST MATCH THE VERSION, IN BOTH DIRECTIONS. A
  // release candidate published as a normal release would be handed to stable
  // installations; a stable release published as a prerelease would be handed
  // to nobody at all.
  const visibility = releaseVisibility(manifest.version)
  if (!!release.prerelease !== visibility.prerelease) {
    fail(`Public release prerelease flag is ${!!release.prerelease}, expected `
      + `${visibility.prerelease} for ${manifest.version}`)
  }
  const records = new Map(manifest.artifacts.map(record => [record.name, record]))
  const expectedNames = CANONICAL_ASSET_NAMES(manifest.version)
  if (records.size !== expectedNames.length || [...records.keys()].sort().join('\n') !== [...expectedNames].sort().join('\n')) {
    fail('Reviewed release manifest does not contain exactly the canonical six assets')
  }
  const assets = Array.isArray(release.assets) ? release.assets : []
  const assetNames = assets.map(asset => asset.name).sort()
  if (assetNames.join('\n') !== [...expectedNames].sort().join('\n')) fail('Public release asset set is not exactly the canonical six assets')

  const downloaded = {}
  let installerBytes = null
  let latestBytes = null
  for (const asset of assets) {
    const record = records.get(asset.name)
    if (asset.size !== record.size) fail(`Public asset metadata size differs for ${asset.name}`)
    const result = await downloadPublicAsset(fetchImpl, owner, repo, tag, asset, retry)
    if (result.bytes.length !== record.size || sha256Bytes(result.bytes) !== record.sha256 || sha512Bytes(result.bytes) !== record.sha512) {
      fail(`Public asset bytes differ from the reviewed candidate: ${asset.name}`)
    }
    downloaded[asset.name] = { url: result.url, size: result.bytes.length, sha256: sha256Bytes(result.bytes), sha512: sha512Bytes(result.bytes) }
    if (asset.name === installerAssetName(manifest.version)) installerBytes = result.bytes
    if (asset.name === channelFileName(manifest.version)) latestBytes = result.bytes
    if (asset.name === 'build-info.json') {
      const info = JSON.parse(result.bytes.toString('utf8'))
      if (info.version !== manifest.version || info.commit !== manifest.commit || info.channel !== 'release' || info.dirty !== false) {
        fail('Public build-info.json does not identify the reviewed release')
      }
    }
  }
  if (!installerBytes) fail('Public release did not return its installer')
  if (!latestBytes) fail('Public release did not return latest.yml')
  validateLatestYml(latestBytes.toString('utf8'), {
    version: manifest.version,
    installerName: installerAssetName(manifest.version),
    installerBytes,
  })

  // ⚠ WHAT `releases/latest` RETURNS IS WHAT EVERY STABLE INSTALL IS OFFERED,
  // so it is checked either way round. For a stable release it must BE this
  // release. For a release candidate it must NOT be — and it must not be a
  // prerelease either, because that would mean GitHub had no stable release to
  // hand out and something has gone wrong with an earlier publication.
  const latestRelease = await fetchJson(fetchImpl, githubApiUrl(owner, repo, 'releases/latest'), retry)
  if (visibility.latest) {
    if (latestRelease.tag_name !== tag || latestRelease.draft === true || latestRelease.prerelease === true) {
      fail(`Public Latest release is ${latestRelease.tag_name || 'unknown'}, not ${tag}`)
    }
  } else {
    if (latestRelease.tag_name === tag) {
      fail(`Release candidate ${tag} is GitHub's Latest release; it would be offered to `
        + 'stable installations')
    }
    if (latestRelease.prerelease === true) {
      fail(`GitHub's Latest release ${latestRelease.tag_name || 'unknown'} is itself a `
        + 'prerelease; stable installations would be offered a release candidate')
    }
  }
  const tagTarget = await resolvePublicTagCommit(fetchImpl, owner, repo, tag, retry)
  if (tagTarget.sha !== manifest.commit) fail(`Public tag ${tag} targets ${tagTarget.sha}, expected ${manifest.commit}`)
  return {
    schema: PUBLIC_VERIFICATION_SCHEMA,
    repository: `${owner}/${repo}`,
    tag,
    commit: manifest.commit,
    version: manifest.version,
    release: { id: release.id ?? null, name: release.name, draft: !!release.draft, prerelease: !!release.prerelease, html_url: release.html_url ?? null },
    latest: { tag: latestRelease.tag_name, draft: !!latestRelease.draft, prerelease: !!latestRelease.prerelease },
    tagTarget,
    assets: downloaded,
    updater: { path: installerAssetName(manifest.version), verified: true },
    verifiedAt: new Date().toISOString(),
  }
}

function makeManifest({ root, releaseDir, uploadDir, version, commit, notes, engineHashes, packagedHashes, staged, publish, repository, verification, verificationPath }) {
  const sourceMap = staged.sourceMap
  const artifacts = CANONICAL_ASSET_NAMES(version).map(name => artifactRecord(root, name, path.join(uploadDir, name), sourceMap.get(name)))
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    version,
    commit,
    tag: `v${version}`,
    channel: 'release',
    releaseNotes: notes.relative,
    releaseDirectory: slash(path.relative(root, releaseDir)),
    artifacts,
    installer: {
      sourceName: installerSourceName(version),
      assetName: installerAssetName(version),
      sourcePath: slash(path.relative(root, staged.sourceInstaller)),
      stagedPath: slash(path.relative(root, path.join(uploadDir, installerAssetName(version)))),
      size: staged.installerBytes.length,
      sha256: sha256Bytes(staged.installerBytes),
      sha512: sha512Bytes(staged.installerBytes),
    },
    manifests: {
      engine: { name: 'engine-hashes.json', entries: Object.keys(engineHashes).length, serialization: 'json-indent-2-crlf-final-newline' },
      packaged: { name: 'packaged-hashes.json', files: PACKAGED_HASH_FILES, serialization: 'json-indent-2-crlf-final-newline' },
      packagedCommit: packagedHashes.commit,
    },
    repository,
    verification: {
      schema: verification.schema,
      profile: verification.profile,
      candidate: verification.candidate,
      sourceFingerprint: verification.sourceFingerprint,
      sourceFiles: verification.sourceFiles,
      commands: verification.commands,
      results: verification.results,
      durationMs: verification.durationMs,
      reused: verification.reused === true,
      fingerprint: verification.fingerprint,
      receiptPath: slash(path.relative(root, verificationPath)),
    },
    publication: { requested: publish, state: publish ? 'pending' : 'candidate-only' },
    handoff: { path: slash(path.relative(root, path.join(releaseDir, 'installation-handoff.json'))) },
  }
}

function makeHandoff({ root, releaseDir, manifest, packagedHashes, publishedUrl = null }) {
  return {
    schema: HANDOFF_SCHEMA,
    version: manifest.version,
    commit: manifest.commit,
    tag: manifest.tag,
    candidateManifest: slash(path.relative(root, path.join(releaseDir, 'release-manifest.json'))),
    installer: manifest.installer,
    ...(publishedUrl ? { publicReleaseUrl: publishedUrl } : {}),
    installation: {
      owner: 'coordinator',
      defaultScope: 'current user; all-users is an explicit installer choice',
      uac: 'The coordinator handles any requested all-users elevation and installer preflight.',
      restart: 'The coordinator performs the desktop restart only after installation succeeds.',
    },
    // After installation: the installed engine and the post-Setup relaunch
    // helper are present, byte-identical to this candidate, and the engine
    // reports this release. Nothing here starts the engine or the app.
    engineVerification: {
      owner: 'coordinator',
      readOnly: true,
      commands: [
        '& "<install-dir>\\resources\\engine\\orgtree-engine.exe" --version',
        'Get-FileHash -Algorithm SHA256 "<install-dir>\\resources\\engine\\orgtree-engine.exe", "<install-dir>\\resources\\engine\\orgtree-installer-relaunch.exe"',
      ],
      expected: {
        version: manifest.version,
        commit: manifest.commit,
        installerSha256: manifest.installer.sha256,
        engineVersion: `orgtree-engine ${manifest.version}`,
        engineSha256: packagedHashes.files['engine/orgtree-engine.exe'],
        relaunchHelperSha256: packagedHashes.files['engine/orgtree-installer-relaunch.exe'],
      },
      absent: ['<install-dir>\\resources\\engine\\runtime'],
    },
    boundaries: [
      'This release command does not install, launch, stop, restart, or deploy Orgtree.',
      'The installed-engine check is read-only: it runs only orgtree-engine.exe --version and hashes files.',
      'Do not infer live verification from a successful package or publication check.',
    ],
  }
}

export async function publishRelease({ root, manifest, notes, repository, uploadDir, runExternal, runGit, fetchImpl, spawnSyncImpl, verificationSleep }) {
  assertPublicReleaseAllowed(manifest.version, manifest)
  assertPublicReleaseAllowed(String(manifest.tag).replace(/^v/, ''))
  const { owner, repo } = repository
  // Recheck immediately before any mutation. The pre-build checks prevent
  // wasted work, while these checks close the race where another release lands
  // during the Windows build.
  assertNoLocalTag(root, manifest.tag, spawnSyncImpl)
  assertNoRemoteTag(root, manifest.tag, spawnSyncImpl)
  await assertNoPublicRelease({ owner, repo, tag: manifest.tag, fetchImpl })
  const assetPaths = manifest.artifacts.map(record => path.join(uploadDir, record.name))
  let localTagCreated = false
  let tagPushed = false
  try {
    runGit(['tag', manifest.tag, manifest.commit])
    localTagCreated = true
    runGit(['push', 'origin', `refs/tags/${manifest.tag}`])
    tagPushed = true
    runExternal('gh', [
      'release', 'create', manifest.tag,
      '--repo', `${owner}/${repo}`,
      '--verify-tag',
      '--draft',
      '--title', `Orgtree ${manifest.version}`,
      '--notes-file', notes.file,
      ...assetPaths,
    ])
    // ⚠ A RELEASE CANDIDATE IS PUBLISHED AS A PRERELEASE AND IS NOT MARKED
    // LATEST. Hard-coding --prerelease=false --latest=true here is what would
    // hand an RC to every stable installation.
    runExternal('gh', ['release', 'edit', manifest.tag, '--repo', `${owner}/${repo}`,
      '--draft=false', ...releaseVisibility(manifest.version).flags])
  } catch (error) {
    if (localTagCreated && !tagPushed) {
      try {
        runGit(['tag', '--delete', manifest.tag])
      } catch {
        // Preserve the original publication failure; the local tag can be
        // removed manually if cleanup itself is unavailable.
      }
    }
    throw new ReleaseError(`Publication failed; no GitHub release was auto-deleted because a failed CLI call may have created an ambiguous draft. Inspect the tag/release before retrying; no existing release was replaced: ${error.message}`)
  }
  // Draft-to-public propagation has taken over a minute. Eight bounded waits
  // (3+6+...+24 seconds = 108 seconds) cover that without repeating publication.
  const verification = await verifyPublicRelease({ manifest, owner, repo, tag: manifest.tag, fetchImpl,
    retry: { retries: 8, delayMs: 3000, ...(verificationSleep ? { sleep: verificationSleep } : {}) } })
  return { verification, url: verification.release.html_url || `https://github.com/${owner}/${repo}/releases/tag/${manifest.tag}` }
}

export async function produceWindowsRelease(options, dependencies = {}) {
  assertPublicReleaseAllowed(options.version)
  const root = realRoot(dependencies.root || process.cwd())
  const execFileSyncImpl = dependencies.execFileSync || execFileSync
  const spawnSyncImpl = dependencies.spawnSync || spawnSync
  const runExternal = dependencies.runExternal || ((command, args) => checkedExternal(command, args, root, spawnSyncImpl))
  const runGit = dependencies.runGit || (args => checkedExternal('git', args, root, spawnSyncImpl))
  const fetchImpl = dependencies.fetch || globalThis.fetch
  assertGitCheckout(root, execFileSyncImpl)
  const packageJson = readJson(path.join(root, 'package.json'), 'package.json')
  const packageLock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json')
  assertVersionMatchesPackage(options.version, packageJson.version)
  assertLockfileVersion(options.version, packageLock)
  const notes = assertNotesFile(root, options.version, execFileSyncImpl)
  const head = gitText(root, ['rev-parse', 'HEAD^{commit}'], execFileSyncImpl).trim()
  if (!/^[0-9a-f]{40}$/.test(head)) fail(`HEAD is not a full commit SHA: ${head}`)
  assertCleanReleaseTree(gitStatus(root, execFileSyncImpl))
  const tag = `v${options.version}`
  assertNoLocalTag(root, tag, spawnSyncImpl)
  assertNoRemoteTag(root, tag, spawnSyncImpl)
  const repository = githubConfig(packageJson)
  await assertNoPublicRelease({ ...repository, tag, fetchImpl })
  assertPackagePrerequisites(root)

  const releaseRelative = packageJson.build?.directories?.output
  if (typeof releaseRelative !== 'string' || !releaseRelative) fail('package.json build.directories.output is missing')
  const releaseDir = resolveInside(root, releaseRelative, 'release output')
  const defaultVerificationReceipt = path.join(releaseDir, 'release-verification.json')
  if (fs.existsSync(releaseDir)) requireRealDirectory(releaseDir, 'release output')
  fs.mkdirSync(path.dirname(defaultVerificationReceipt), { recursive: true })

  // The canonical flow owns the source receipt. A standalone receipt can be
  // supplied only through the injected runner used by tests; production always
  // derives the Git diff and runs/reuses the exact selected profile here.
  const verify = dependencies.runVerification || runVerification
  const verificationPath = options.verificationReceipt || defaultVerificationReceipt
  const verification = await verify({ root, base: options.base, candidate: head, receiptPath: verificationPath })
  assertReleaseVerification(verification, { commit: head })

  const npm = resolveNpmInvocation()
  // --publish never is intentional and remains in the command even when a
  // GH_TOKEN or an authenticated gh CLI happens to be present.
  runExternal(npm.command, [...npm.args, 'run', 'package:win', '--', '--publish', 'never'])
  assertAllPackageInputs(root)
  requireRealDirectory(releaseDir, 'release output')
  requireRealDirectory(path.join(releaseDir, 'win-unpacked'), 'unpacked release output')
  const resources = path.join(releaseDir, 'win-unpacked', 'resources')
  requireRealDirectory(resources, 'unpacked resources')
  const installer = path.join(releaseDir, installerSourceName(options.version))
  requireRegularFile(installer, 'Windows installer')
  const buildInfo = readJson(path.join(root, 'dist', 'build-info.json'), 'dist/build-info.json')
  const afterBuildStatus = gitStatus(root, execFileSyncImpl)
  assertBuildProvenance(buildInfo, { root, head, porcelain: afterBuildStatus, version: options.version })
  const engineHashes = deriveEngineHashes({ root })
  // Installed-shaped payload checks: the win-unpacked engine must hold
  // exactly the shipped files, byte-identical to the build outputs, with a
  // release orgtree-engine.exe — and then the BUILT INSTALLER's payload must
  // carry that exact engine, extracted, never executed.
  const packagedEngine = (dependencies.verifyPackagedEngine || verifyPackagedEngine)({ root, resources, version: options.version, spawnSyncImpl: spawnSyncImpl })
  const payloadEngine = (dependencies.verifyInstallerPayloadEngine || verifyInstallerPayloadEngine)({
    root,
    installer,
    workDir: path.join(releaseDir, 'payload-engine-check'),
    expectedDigest: packagedEngine.digest,
    expectedPostgresManifestSha256: packagedEngine.postgresManifestSha256,
    version: options.version,
    spawnSyncImpl: spawnSyncImpl,
  })
  const packagedHashes = derivePackagedHashes({
    resources, installer, commit: head, version: options.version,
    engine: packagedEngineRecord(packagedEngine, payloadEngine),
  })
  const staged = stageCanonicalAssets({ root, releaseDir, version: options.version, engineHashes, packagedHashes })
  const manifest = makeManifest({
    root,
    releaseDir,
    uploadDir: staged.uploadDir,
    version: options.version,
    commit: head,
    notes,
    engineHashes,
    packagedHashes,
    staged,
    publish: options.publish,
    repository,
    verification,
    verificationPath,
  })
  verifyLocalCandidate({ root, manifest, uploadDir: staged.uploadDir, resources, engineHashes })
  recordFullyGatedBuild(root, verification, execFileSyncImpl)
  writeJson(verificationPath, verification, false)
  const manifestPath = path.join(releaseDir, 'release-manifest.json')
  const handoffPath = path.join(releaseDir, 'installation-handoff.json')
  writeJson(manifestPath, manifest, false)
  writeJson(handoffPath, makeHandoff({ root, releaseDir, manifest, packagedHashes }), false)

  if (options.publish) {
    const published = await publishRelease({ root, manifest, notes, repository, uploadDir: staged.uploadDir, runExternal, runGit, fetchImpl, spawnSyncImpl })
    manifest.publication = { requested: true, state: 'published', url: published.url, verification: published.verification }
    writeJson(manifestPath, manifest, false)
    writeJson(handoffPath, makeHandoff({ root, releaseDir, manifest, packagedHashes, publishedUrl: published.url }), false)
  }
  return { manifest, manifestPath, handoffPath, uploadDir: staged.uploadDir }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseReleaseArgs(argv)
    if (options.help) {
      console.log(RELEASE_USAGE)
      return 0
    }
    const result = await produceWindowsRelease(options, dependencies)
    console.log(`Windows ${options.publish ? 'publication' : 'release candidate'} verified for ${result.manifest.version} (${result.manifest.commit})`)
    console.log(`Assets: ${result.uploadDir}`)
    console.log(`Manifest: ${result.manifestPath}`)
    console.log(`Installation handoff: ${result.handoffPath}`)
    return 0
  } catch (error) {
    console.error(`Release refused: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
