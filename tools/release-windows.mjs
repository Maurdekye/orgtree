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
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { REQUIRED_PACKAGE_INPUTS } from './preflight-lib.mjs'

export const RELEASE_MANIFEST_SCHEMA = 'orgtree.windows-release/v1'
export const HANDOFF_SCHEMA = 'orgtree.windows-installation-handoff/v1'
export const PUBLIC_VERIFICATION_SCHEMA = 'orgtree.windows-public-verification/v1'

// This is the six-asset set shipped by the proven 2.1.1 procedure. GitHub's
// generated source archives are not release assets and are intentionally not
// included here.
export const CANONICAL_ASSET_NAMES = version => [
  'build-info.json',
  'engine-hashes.json',
  'latest.yml',
  `Orgtree-Setup-${version}.exe`,
  `Orgtree-Setup-${version}.exe.blockmap`,
  'packaged-hashes.json',
]

// The package's default electron-builder names contain spaces. latest.yml and
// the public release use hyphens. The original files are never renamed in
// place; they are copied to the upload directory under these names.
export const installerSourceName = version => `Orgtree Setup ${version}.exe`
export const installerAssetName = version => `Orgtree-Setup-${version}.exe`

// These are the resource files hashed by packaged-hashes.json in the 2.1.1
// release. Keep the list explicit: changing the schema must be a deliberate
// release-tooling change, not an accidental consequence of package contents.
export const PACKAGED_HASH_FILES = [
  'app.asar',
  'build-info.json',
  'engine/runtime/python.exe',
  'engine/runtime/runtime-manifest.json',
]

export const RELEASE_USAGE = `Usage:
  npm run release:windows -- <version>
  npm run release:windows -- <version> --publish

The default builds and verifies a local candidate only. --publish is the
explicit publication phase; it creates the tag/release and verifies every
public asset after downloading it back. Installation and restart are never
performed by this command.`

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

export function validReleaseVersion(version) {
  return typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
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
    } else if (argument.startsWith('-')) {
      fail(`Unknown release option: ${argument}\n\n${RELEASE_USAGE}`)
    } else if (parsed.version !== null) {
      fail(`Only one target version is allowed; got ${parsed.version} and ${argument}`)
    } else {
      parsed.version = argument
    }
  }
  if (!parsed.help && parsed.version === null) fail(`An explicit target version is required.\n\n${RELEASE_USAGE}`)
  if (!parsed.help && !validReleaseVersion(parsed.version)) {
    fail(`Target version must be a plain semantic version such as 2.1.2: ${parsed.version}`)
  }
  return parsed
}

/** Describe the side-effect boundary without touching the checkout. This is
 * useful to callers and fixture tests that need to prove the ordinary command
 * has no tag, push, or GitHub publication operation in its plan. */
export function releasePlan(version, { publish = false } = {}) {
  if (!validReleaseVersion(version)) fail(`Target version must be a plain semantic version such as 2.1.2: ${version}`)
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
  requireRegularFile(nativeRelative(root, 'engine/runtime/python313._pth'), 'package prerequisite engine/runtime/python313._pth')
  const nodeModules = nativeRelative(root, 'node_modules')
  requireRealDirectory(nodeModules, 'private node_modules')
  requireRegularFile(path.join(nodeModules, 'electron', 'package.json'), 'Electron dependency')
  requireRegularFile(path.join(nodeModules, 'electron-builder', 'package.json'), 'electron-builder dependency')
}

function assertAllPackageInputs(root) {
  for (const relative of REQUIRED_PACKAGE_INPUTS) {
    requireRegularFile(nativeRelative(root, relative), `package prerequisite ${relative}`)
  }
  requireRegularFile(nativeRelative(root, 'engine/runtime/python313._pth'), 'package prerequisite engine/runtime/python313._pth')
}

export function assertBuildProvenance(info, { root, head, porcelain, version }) {
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

export function deriveEngineHashes({ root, gitFiles, hash = hashFile }) {
  const tracked = gitFiles
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => value.replaceAll('\\', '/'))
  const sources = [...new Set(tracked)]
    .filter(file => file.endsWith('.py') && !file.startsWith('engine/runtime/'))
    .sort()
  if (!sources.length) fail('No tracked engine Python sources were found for engine-hashes.json')
  const result = {}
  for (const relative of sources) {
    const file = resolveInside(root, relative, 'engine source')
    requireRegularFile(file, `engine source ${relative}`)
    result[relative] = hash(file)
  }
  return result
}

export function derivePackagedHashes({ resources, installer, commit, version, hash = hashFile }) {
  const files = {}
  for (const relative of PACKAGED_HASH_FILES) {
    const file = nativeRelative(resources, relative)
    requireRegularFile(file, `packaged resource ${relative}`)
    files[relative] = hash(file)
  }
  requireRegularFile(installer, 'Windows installer')
  return { commit, version, files, installerSha256: hash(installer) }
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
  const resources = path.join(releaseDir, 'win-unpacked', 'resources')
  const sourceInstaller = path.join(releaseDir, installerSourceName(version))
  const sourceBlockmap = `${sourceInstaller}.blockmap`
  const sourceMap = new Map([
    ['build-info.json', path.join(resources, 'build-info.json')],
    ['engine-hashes.json', path.join(releaseDir, 'engine-hashes.json')],
    ['latest.yml', path.join(releaseDir, 'latest.yml')],
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
  validateLatestYml(fs.readFileSync(path.join(uploadDir, 'latest.yml'), 'utf8'), {
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
  validateLatestYml(fs.readFileSync(path.join(uploadDir, 'latest.yml'), 'utf8'), {
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
  const actualEngine = readJson(path.join(uploadDir, 'engine-hashes.json'), 'engine-hashes.json')
  if (JSON.stringify(actualEngine) !== JSON.stringify(engineHashes)) fail('engine-hashes.json does not match the source checkout')
  return { buildInfo, packaged, latest: parseLatestYml(fs.readFileSync(path.join(uploadDir, 'latest.yml'), 'utf8')) }
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

async function fetchJson(fetchImpl, url) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'orgtree-release-tool',
      },
    })
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
    response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'orgtree-release-tool' } })
  } catch (error) {
    fail(`Could not establish that public release ${tag} is absent: ${error.message}`)
  }
  if (response?.status === 404) return { exists: false, tag }
  if (responseOk(response)) fail(`Public release collision: ${owner}/${repo} already has release ${tag}; refusing replacement`)
  fail(`Could not establish that public release ${tag} is absent (HTTP ${response?.status ?? 'unknown'})`)
}

async function downloadPublicAsset(fetchImpl, owner, repo, tag, asset) {
  const url = asset.browser_download_url || `${githubDownloadPrefix(owner, repo, tag)}${encodeURIComponent(asset.name)}`
  const prefix = githubDownloadPrefix(owner, repo, tag)
  if (!url.startsWith(prefix)) fail(`Release asset ${asset.name} does not use its public download endpoint`)
  let response
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'orgtree-release-tool' } })
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

async function resolvePublicTagCommit(fetchImpl, owner, repo, tag) {
  const refUrl = githubApiUrl(owner, repo, `git/ref/tags/${encodeURIComponent(tag)}`)
  const ref = await fetchJson(fetchImpl, refUrl)
  let object = ref.object
  if (!object?.sha) fail(`Public tag ${tag} has no Git object`)
  while (object.type === 'tag') {
    const annotated = await fetchJson(fetchImpl, githubApiUrl(owner, repo, `git/tags/${encodeURIComponent(object.sha)}`))
    object = annotated.object
    if (!object?.sha) fail(`Annotated public tag ${tag} has no commit target`)
  }
  return { sha: object.sha, type: object.type || 'commit' }
}

export async function verifyPublicRelease({ manifest, owner, repo, tag = manifest.tag, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') fail('Public release verification requires fetch')
  const release = await fetchJson(fetchImpl, githubApiUrl(owner, repo, `releases/tags/${encodeURIComponent(tag)}`))
  if (release.tag_name !== tag) fail(`Public release tag is ${release.tag_name}, expected ${tag}`)
  if (release.name !== `Orgtree ${manifest.version}`) fail(`Public release title is ${release.name}, expected Orgtree ${manifest.version}`)
  if (release.draft === true || release.prerelease === true) fail('Public release is still draft or prerelease')
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
    const result = await downloadPublicAsset(fetchImpl, owner, repo, tag, asset)
    if (result.bytes.length !== record.size || sha256Bytes(result.bytes) !== record.sha256 || sha512Bytes(result.bytes) !== record.sha512) {
      fail(`Public asset bytes differ from the reviewed candidate: ${asset.name}`)
    }
    downloaded[asset.name] = { url: result.url, size: result.bytes.length, sha256: sha256Bytes(result.bytes), sha512: sha512Bytes(result.bytes) }
    if (asset.name === installerAssetName(manifest.version)) installerBytes = result.bytes
    if (asset.name === 'latest.yml') latestBytes = result.bytes
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

  const latestRelease = await fetchJson(fetchImpl, githubApiUrl(owner, repo, 'releases/latest'))
  if (latestRelease.tag_name !== tag || latestRelease.draft === true || latestRelease.prerelease === true) {
    fail(`Public Latest release is ${latestRelease.tag_name || 'unknown'}, not ${tag}`)
  }
  const tagTarget = await resolvePublicTagCommit(fetchImpl, owner, repo, tag)
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

function makeManifest({ root, releaseDir, uploadDir, version, commit, notes, engineHashes, packagedHashes, staged, publish, repository }) {
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
    publication: { requested: publish, state: publish ? 'pending' : 'candidate-only' },
    handoff: { path: slash(path.relative(root, path.join(releaseDir, 'installation-handoff.json'))) },
  }
}

function makeHandoff({ root, releaseDir, manifest, publishedUrl = null }) {
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
    runtimeVerification: {
      owner: 'coordinator',
      readOnly: true,
      command: 'python tools/verify-installed-runtime.py --repo-root <checkout> --data-root <isolated-data-root> --runtime-root <installed-resources-engine-runtime> --json-output <receipt.json>',
      expected: { version: manifest.version, commit: manifest.commit, installerSha256: manifest.installer.sha256 },
    },
    boundaries: [
      'This release command does not install, launch, stop, restart, or deploy Orgtree.',
      'The installed-runtime verifier is read-only and must receive endpoint/token from the desktop launch handshake when needed.',
      'Do not infer live verification from a successful package or publication check.',
    ],
  }
}

export async function publishRelease({ root, manifest, notes, repository, uploadDir, runExternal, runGit, fetchImpl, spawnSyncImpl }) {
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
    runExternal('gh', ['release', 'edit', manifest.tag, '--repo', `${owner}/${repo}`, '--draft=false', '--prerelease=false', '--latest=true'])
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
  const verification = await verifyPublicRelease({ manifest, owner, repo, tag: manifest.tag, fetchImpl })
  return { verification, url: verification.release.html_url || `https://github.com/${owner}/${repo}/releases/tag/${manifest.tag}` }
}

export async function produceWindowsRelease(options, dependencies = {}) {
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

  const npm = resolveNpmInvocation()
  // --publish never is intentional and remains in the command even when a
  // GH_TOKEN or an authenticated gh CLI happens to be present.
  runExternal(npm.command, [...npm.args, 'run', 'package:win', '--', '--publish', 'never'])
  assertAllPackageInputs(root)
  const releaseRelative = packageJson.build?.directories?.output
  if (typeof releaseRelative !== 'string' || !releaseRelative) fail('package.json build.directories.output is missing')
  const releaseDir = resolveInside(root, releaseRelative, 'release output')
  requireRealDirectory(releaseDir, 'release output')
  requireRealDirectory(path.join(releaseDir, 'win-unpacked'), 'unpacked release output')
  const resources = path.join(releaseDir, 'win-unpacked', 'resources')
  requireRealDirectory(resources, 'unpacked resources')
  const installer = path.join(releaseDir, installerSourceName(options.version))
  requireRegularFile(installer, 'Windows installer')
  const buildInfo = readJson(path.join(root, 'dist', 'build-info.json'), 'dist/build-info.json')
  const afterBuildStatus = gitStatus(root, execFileSyncImpl)
  assertBuildProvenance(buildInfo, { root, head, porcelain: afterBuildStatus, version: options.version })
  const engineHashes = deriveEngineHashes({ root, gitFiles: gitText(root, ['ls-files', '--', 'engine'], execFileSyncImpl) })
  const packagedHashes = derivePackagedHashes({ resources, installer, commit: head, version: options.version })
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
  })
  verifyLocalCandidate({ root, manifest, uploadDir: staged.uploadDir, resources, engineHashes })
  const manifestPath = path.join(releaseDir, 'release-manifest.json')
  const handoffPath = path.join(releaseDir, 'installation-handoff.json')
  writeJson(manifestPath, manifest, false)
  writeJson(handoffPath, makeHandoff({ root, releaseDir, manifest }), false)

  if (options.publish) {
    const published = await publishRelease({ root, manifest, notes, repository, uploadDir: staged.uploadDir, runExternal, runGit, fetchImpl, spawnSyncImpl })
    manifest.publication = { requested: true, state: 'published', url: published.url, verification: published.verification }
    writeJson(manifestPath, manifest, false)
    writeJson(handoffPath, makeHandoff({ root, releaseDir, manifest, publishedUrl: published.url }), false)
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
