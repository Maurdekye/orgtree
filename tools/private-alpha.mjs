// Intentional direct-delivery packaging only. The default prints a plan.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  PRIVATE_ALPHA_VERSION as VERSION, PRIVATE_ALPHA_CHANNEL as CHANNEL,
  PRIVATE_ALPHA_INSTALLER as INSTALLER, PRIVATE_ALPHA_OUTPUT as OUTPUT,
  PRIVATE_ALPHA_MARKER, privateAlphaConfig,
} from './private-alpha-policy.mjs'
import {
  assertCleanReleaseTree, assertLockfileVersion, assertReleaseVerification,
  deriveEngineHashes, hashFile, serializeJson, sha256Bytes, verifyPackagedRuntime,
} from './release-windows.mjs'
import { assertMailhubSubmodule, REQUIRED_PACKAGE_INPUTS } from './preflight-lib.mjs'
import { assertRuntimeLayout, assertRuntimeImports, bundledSevenZip, runtimeTreeDigest } from './runtime-layout.mjs'
import { runVerification } from './release-verification.mjs'

export const APPROVAL_SCHEMA = 'orgtree.private-alpha-approval/v1'
export const MANIFEST_SCHEMA = 'orgtree.private-alpha-manifest/v1'
const SHA = /^[0-9a-f]{40}$/
const require = createRequire(import.meta.url)
const fail = message => { throw new Error(message) }
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, serializeJson(value, { sortKeys: true }))

export function parsePrivateAlphaArgs(argv) {
  const options = { build: false }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (seen.has(arg)) fail(`Repeated private-alpha option: ${arg}`)
    seen.add(arg)
    if (arg === '--build') options.build = true
    else if (arg === '--plan') options.plan = true
    else if (arg === '--candidate' || arg === '--approval') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail(`${arg} needs a value`)
      options[arg.slice(2)] = value
    } else fail(`Unknown private-alpha option: ${arg}; publication and version overrides are not supported`)
  }
  if (options.plan && options.build) fail('Choose --plan or --build')
  if (options.build && (!SHA.test(options.candidate ?? '') || !options.approval)) {
    fail('--build requires --candidate <full SHA> and --approval <integration approval JSON>')
  }
  return options
}

export function assertIntegrationApproval(approval, candidate) {
  if (!SHA.test(candidate ?? '') || approval?.schema !== APPROVAL_SCHEMA
      || approval.version !== VERSION || approval.candidate !== candidate
      || approval.approved !== true || typeof approval.reviewer !== 'string'
      || !approval.reviewer.trim() || !Array.isArray(approval.evidence)
      || !approval.evidence.length || approval.evidence.some(v => typeof v !== 'string' || !v.trim())) {
    fail('Private alpha needs combined integration approval for this exact candidate, with reviewer and evidence')
  }
  return approval
}

// Check every ancestor: an apparently ordinary file beneath a junction is not
// private output. All extraction/build writes remain under this checkout.
export function assertLocalPath(root, file, { directory = false, absent = false } = {}) {
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail(`Path must be inside the checkout: ${file}`)
  let current = root
  const parts = relative.split(path.sep)
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    if (!fs.existsSync(current)) {
      if (absent) return
      fail(`Missing packaging input: ${current}`)
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current)) !== '') {
      fail(`Packaging refuses a link or junction: ${current}`)
    }
    if (index < parts.length - 1 || directory) {
      if (!stat.isDirectory()) fail(`Expected directory: ${current}`)
    } else if (!stat.isFile()) fail(`Expected regular file: ${current}`)
  }
}

export function assertPrivateBuildInfo(info, { root, candidate }) {
  if (info?.version !== VERSION || info.channel !== CHANNEL || info.commit !== candidate
      || info.dirty !== false || info.updateFixture !== undefined || !SHA.test(candidate)) {
    fail('Private build identity must be exactly 3.0.0-alpha.0 at the clean approved candidate, without update fixtures')
  }
  if (!info.sha256 || !info.sha256['dist/main/index.cjs']) fail('Private build has no main bundle hash')
  for (const [relative, digest] of Object.entries(info.sha256)) {
    const file = path.resolve(root, relative)
    assertLocalPath(root, file)
    if (hashFile(file) !== digest) fail(`Build input changed: ${relative}`)
  }
  assertPrivateBundle(fs.readFileSync(path.join(root, 'dist/main/index.cjs'), 'utf8'))
  return info
}

export function assertPrivateBundle(bundle) {
  if (!bundle.includes(PRIVATE_ALPHA_MARKER)
      || bundle.includes('ORGTREE-UPDATE-FIXTURE-BUILD' + ':enabled')) {
    fail('Private bundle must compile the private identity in and the update fixture out')
  }
}

export function assertNoUpdateMetadata(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) fail(`Packaging output contains a link: ${file}`)
    if (entry.isDirectory()) {
      if (path.relative(file, fs.realpathSync(file)) !== '') fail(`Packaging output contains a junction: ${file}`)
      assertNoUpdateMetadata(file)
    } else if (/^(?:latest|alpha|beta)(?:[-.].*)?\.ya?ml$/i.test(entry.name)
        || /^app-update\.ya?ml$/i.test(entry.name)) {
      fail(`Private output must contain no updater metadata: ${file}`)
    }
  }
}

export function verifyPrivateResources({ root, resources, info, engineHashes = {}, extractFile = require('@electron/asar').extractFile }) {
  const archive = path.join(resources, 'app.asar')
  assertLocalPath(root, archive)
  assertLocalPath(root, path.join(resources, 'build-info.json'))
  if (!fs.readFileSync(path.join(root, 'dist/build-info.json')).equals(fs.readFileSync(path.join(resources, 'build-info.json')))) {
    fail('Packaged build-info differs from the approved build')
  }
  const packedPackage = JSON.parse(extractFile(archive, 'package.json').toString())
  if (packedPackage.version !== VERSION) fail('Packaged package.json has the wrong private version')
  assertPrivateBundle(extractFile(archive, path.join('dist', 'main', 'index.cjs')).toString())
  for (const [relative, expected] of Object.entries(info.sha256)) {
    const bytes = relative.startsWith('dist/')
      ? extractFile(archive, relative.split('/').join(path.sep))
      : fs.readFileSync(path.join(resources, relative))
    if (sha256Bytes(bytes) !== expected) fail(`Packaged build input differs: ${relative}`)
    if (relative.startsWith('dist/renderer/')) {
      const ui = path.join(resources, 'ui', relative.slice('dist/renderer/'.length))
      assertLocalPath(root, ui)
      if (hashFile(ui) !== expected) fail(`Packaged UI input differs: ${relative}`)
    }
  }
  for (const [relative, expected] of Object.entries(engineHashes)) {
    const file = path.join(resources, relative)
    assertLocalPath(root, file)
    if (hashFile(file) !== expected) fail(`Packaged engine input differs: ${relative}`)
  }
  assertNoUpdateMetadata(resources)
  return { packageVersion: packedPackage.version, appAsarSha256: hashFile(archive), buildInfoSha256: hashFile(path.join(resources, 'build-info.json')) }
}

function checkedRun(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, ...options })
  if (result.error || result.status !== 0) fail(`${path.basename(command)} failed: ${result.error?.message || result.stderr || result.status}`)
  return result
}

// Read PE metadata without executing the installer. ProductVersion retains the
// semver label; Windows' numeric FileVersion cannot represent a prerelease.
export function readInstallerVersion(installer) {
  const result = checkedRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:ORGTREE_PRIVATE_INSTALLER).VersionInfo.ProductVersion'],
  { encoding: 'utf8', env: { ...process.env, ORGTREE_PRIVATE_INSTALLER: installer } })
  return result.stdout.trim()
}

export function verifyPrivateInstaller({ root, installer, resources, info, engineHashes = {}, productVersion = readInstallerVersion }) {
  if (productVersion(installer) !== VERSION) fail('Installer ProductVersion is not exactly 3.0.0-alpha.0')
  const workDir = path.join(root, OUTPUT, 'payload-check')
  assertLocalPath(root, workDir, { directory: true, absent: true })
  if (fs.existsSync(workDir)) fail('Installer extraction directory must be fresh')
  fs.mkdirSync(workDir)
  const sevenZip = bundledSevenZip(root)
  const container = path.join(workDir, 'nsis')
  checkedRun(sevenZip, ['x', '-y', `-o${container}`, installer, '$PLUGINSDIR/app-64.7z'], { encoding: 'utf8' })
  const payload = path.join(workDir, 'payload')
  checkedRun(sevenZip, ['x', '-y', `-o${payload}`, path.join(container, '$PLUGINSDIR/app-64.7z')], { encoding: 'utf8' })
  const extracted = path.join(payload, 'resources')
  const verified = verifyPrivateResources({ root, resources: extracted, info, engineHashes })
  if (verified.appAsarSha256 !== hashFile(path.join(resources, 'app.asar'))) fail('Installer app.asar differs from win-unpacked')
  const expected = runtimeTreeDigest(path.join(resources, 'engine/runtime'))
  const actual = runtimeTreeDigest(path.join(extracted, 'engine/runtime'))
  if (actual.sha256 !== expected.sha256 || actual.files !== expected.files) fail('Installer runtime differs from win-unpacked')
  assertRuntimeLayout(path.join(extracted, 'engine/runtime'))
  const probe = assertRuntimeImports(path.join(extracted, 'engine/runtime'))
  return { ...verified, productVersion: VERSION, runtime: actual, python: probe.python, installerExecuted: false }
}

export function privateArtifactRecord(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) fail(`Artifact must be a nonempty regular file: ${file}`)
  return { name: path.basename(file), size: stat.size, sha256: hashFile(file) }
}

function assertPrivateArtifacts(artifacts) {
  const expected = [INSTALLER, 'engine-hashes.json', 'source-verification.json'].sort()
  if (!Array.isArray(artifacts) || JSON.stringify(artifacts.map(record => record.name).sort()) !== JSON.stringify(expected)
      || artifacts.some(record => !Number.isSafeInteger(record.size) || record.size <= 0 || !/^[0-9a-f]{64}$/.test(record.sha256))) {
    fail('Private manifest requires the exact installer and evidence artifact set with size and SHA-256')
  }
}

export function makePrivateManifest({ candidate, artifacts, approval, verification, payload }) {
  assertIntegrationApproval(approval, candidate)
  assertReleaseVerification(verification, { commit: candidate })
  assertPrivateArtifacts(artifacts)
  if (payload?.productVersion !== VERSION || payload.installerExecuted !== false) fail('Missing installer payload verification')
  return { schema: MANIFEST_SCHEMA, version: VERSION, channel: CHANNEL, commit: candidate,
    installer: artifacts.find(record => record.name === INSTALLER), artifacts,
    approval, verification: { fingerprint: verification.fingerprint, sourceFingerprint: verification.sourceFingerprint },
    payload, publication: { allowed: false, tag: null, release: null, updaterFeed: null },
    delivery: 'private-direct-only', installationPerformed: false }
}

export function verifyPrivateDelivery(directory) {
  const receipt = json(path.join(directory, 'private-alpha-receipt.json'))
  const manifest = json(path.join(directory, 'private-alpha-manifest.json'))
  if (receipt.schema !== 'orgtree.private-alpha-receipt/v1' || manifest.schema !== MANIFEST_SCHEMA
      || receipt.version !== VERSION || manifest.version !== VERSION
      || receipt.candidate !== manifest.commit || receipt.publicationAllowed !== false
      || manifest.publication?.allowed !== false || manifest.channel !== CHANNEL) fail('Invalid private delivery identity')
  assertIntegrationApproval(manifest.approval, manifest.commit)
  assertPrivateArtifacts(manifest.artifacts)
  if (serializeJson(manifest.installer, { sortKeys: true }) !== serializeJson(manifest.artifacts.find(record => record.name === INSTALLER), { sortKeys: true })) {
    fail('Manifest installer differs from its artifact record')
  }
  for (const record of [...receipt.artifacts, receipt.manifest]) {
    if (path.basename(record.name) !== record.name || !/^[\w.-]+$/.test(record.name)) fail('Invalid artifact filename')
    const actual = privateArtifactRecord(path.join(directory, record.name))
    if (actual.size !== record.size || actual.sha256 !== record.sha256) fail(`Private artifact changed: ${record.name}`)
  }
  if (receipt.manifest.name !== 'private-alpha-manifest.json'
      || serializeJson(receipt.artifacts, { sortKeys: true }) !== serializeJson(manifest.artifacts, { sortKeys: true })) fail('Receipt and manifest artifact sets differ')
  assertNoUpdateMetadata(directory)
  return manifest
}

export function privateAlphaPlan(build) {
  return { version: VERSION, channel: CHANNEL, mode: 'plan-only', config: privateAlphaConfig(build),
    build: ['node', 'tools/build.mjs', '--private-alpha'],
    package: ['electron-builder', '--win', 'nsis', '--x64', '--config', 'dist/electron-builder-private-alpha.json', '--publish', 'never'],
    required: ['clean dedicated worktree', 'exact candidate combined-review approval', 'private dependencies and provisioned runtime'],
    publication: false, installerExecuted: false }
}

export async function buildPrivateAlpha(options, dependencies = {}) {
  if (options.build !== true || !SHA.test(options.candidate ?? '')) fail('Explicit --build and exact candidate required')
  const root = fs.realpathSync(dependencies.root || process.cwd())
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trimEnd()
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== root) fail('Run from the worktree root')
  if (git(['rev-parse', '--git-dir']) === git(['rev-parse', '--git-common-dir'])) fail('Private alpha requires a dedicated linked worktree')
  const candidate = git(['rev-parse', 'HEAD'])
  if (candidate !== options.candidate) fail('HEAD differs from the explicitly approved candidate')
  assertCleanReleaseTree(git(['status', '--porcelain', '--untracked-files=normal']))
  const approval = assertIntegrationApproval(json(path.resolve(root, options.approval)), candidate)
  if (process.platform !== 'win32') fail('Private alpha packaging requires Windows')
  const pkg = json(path.join(root, 'package.json'))
  assertLockfileVersion(pkg.version, json(path.join(root, 'package-lock.json')))
  assertLocalPath(root, path.join(root, 'node_modules'), { directory: true })
  assertRuntimeLayout(path.join(root, 'engine/runtime'))
  for (const file of REQUIRED_PACKAGE_INPUTS.filter(file => !file.startsWith('dist/'))) assertLocalPath(root, path.join(root, file))
  assertLocalPath(root, path.join(root, 'dist'), { directory: true, absent: true })
  const output = path.join(root, OUTPUT)
  assertLocalPath(root, output, { directory: true, absent: true })
  if (fs.existsSync(output)) fail('Private output directory must be absent; preserve or remove previous output explicitly')
  fs.mkdirSync(output)
  const verification = await (dependencies.runVerification || runVerification)({ root, candidate,
    receiptPath: path.join(output, 'source-verification.json') })
  assertReleaseVerification(verification, { commit: candidate })
  checkedRun(process.execPath, ['tools/build.mjs', '--private-alpha'], { cwd: root, stdio: 'inherit' })
  const info = assertPrivateBuildInfo(json(path.join(root, 'dist/build-info.json')), { root, candidate })
  const rootIo = { existsSync: file => fs.existsSync(path.join(root, file)) }
  assertMailhubSubmodule(info, git(['submodule', 'status', '--', 'engine/mailhub']), git(['-C', 'engine/mailhub', 'rev-parse', 'HEAD']), rootIo)
  assertCleanReleaseTree(git(['status', '--porcelain', '--untracked-files=normal']))
  const config = privateAlphaConfig(pkg.build)
  writeJson(path.join(root, 'dist/electron-builder-private-alpha.json'), config)
  const builder = createRequire(path.join(root, 'package.json')).resolve('electron-builder/cli.js')
  checkedRun(process.execPath, [builder, '--win', 'nsis', '--x64', '--config', 'dist/electron-builder-private-alpha.json', '--publish', 'never'], { cwd: root, stdio: 'inherit' })
  assertCleanReleaseTree(git(['status', '--porcelain', '--untracked-files=normal']))
  if (git(['rev-parse', 'HEAD']) !== candidate) fail('HEAD changed during packaging')
  assertPrivateBuildInfo(info, { root, candidate })
  assertNoUpdateMetadata(output)
  const resources = path.join(output, 'win-unpacked/resources')
  const engineHashes = deriveEngineHashes({ root, gitFiles: git(['ls-files', '--', 'engine']) })
  verifyPrivateResources({ root, resources, info, engineHashes })
  const runtime = verifyPackagedRuntime({ root, resources })
  const installer = path.join(output, INSTALLER)
  assertLocalPath(root, installer)
  const payload = verifyPrivateInstaller({ root, installer, resources, info, engineHashes })
  // Only this explicit allowlist is deliverable. No upload directory or feed.
  writeJson(path.join(output, 'engine-hashes.json'), engineHashes)
  const names = [INSTALLER, 'engine-hashes.json', 'source-verification.json']
  const artifacts = names.map(name => privateArtifactRecord(path.join(output, name)))
  const manifest = makePrivateManifest({ candidate, artifacts, approval, verification, payload: { ...payload, packagedRuntime: runtime.digest } })
  writeJson(path.join(output, 'private-alpha-manifest.json'), manifest)
  const manifestRecord = privateArtifactRecord(path.join(output, 'private-alpha-manifest.json'))
  writeJson(path.join(output, 'private-alpha-receipt.json'), { schema: 'orgtree.private-alpha-receipt/v1',
    candidate, version: VERSION, manifest: manifestRecord, artifacts,
    deliveryFiles: [...names, manifestRecord.name, 'private-alpha-receipt.json'], publicationAllowed: false,
    limits: ['No installation or application launch performed.', 'Source checks and extracted-payload checks do not replace integrated MVP qualification.'] })
  verifyPrivateDelivery(output)
  return { manifest, output }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parsePrivateAlphaArgs(argv)
    if (!options.build) console.log(JSON.stringify(privateAlphaPlan(json('package.json').build), null, 2))
    else console.log(JSON.stringify(await buildPrivateAlpha(options), null, 2))
    return 0
  } catch (error) {
    console.error(`Private alpha refused: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main()
