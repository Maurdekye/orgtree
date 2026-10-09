/*
 * CI driver for the Orgtree Windows release build (GitHub Actions, windows-2025).
 *
 * Runs the packaging half of `npm run release:windows -- <version>` against a
 * SOURCE checkout, using that checkout's OWN tools/release-windows.mjs exports,
 * so an old tag builds with the release code it shipped with. Prerequisites
 * (engine, runtime, PostgreSQL payload, node_modules) are provisioned by the
 * workflow before this runs.
 *
 * Deliberately NOT done here:
 *  - the test gate (tools/release-verification.mjs): its baseline refuses a
 *    foreign host, so it stays a local step before a tag is pushed;
 *  - tag/release collision checks and publication: the workflow only builds;
 *    release.yml makes the draft release.
 *
 * Usage: node release-ci.mjs --source <checkout> --out <dir> [--expect-version X]
 * Writes exactly the canonical six assets into <out>.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`)
    args[key.slice(2)] = value
    i += 1
  }
  if (!args.source || !args.out) throw new Error('Usage: release-ci.mjs --source <checkout> --out <dir> [--expect-version X]')
  return args
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
}

function step(name) {
  console.log(`\n=== ${name}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = fs.realpathSync(path.resolve(args.source))
  const out = path.resolve(args.out)
  const rel = await import(pathToFileURL(path.join(root, 'tools', 'release-windows.mjs')).href)
  const { REPRESENTATIVE_RUNTIME_IMPORTS } = await import(pathToFileURL(path.join(root, 'tools', 'runtime-layout.mjs')).href)

  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_RUN_AS_NODE']) {
    if (process.env[name]) throw new Error(`${name} must not be set in the build environment`)
  }

  step('Source identity')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const version = packageJson.version
  if (!rel.validReleaseVersion(version)) throw new Error(rel.badVersionMessage(version))
  if (args['expect-version'] && args['expect-version'] !== version) {
    throw new Error(`Ref is tagged for ${args['expect-version']} but package.json says ${version}`)
  }
  rel.assertVersionMatchesPackage(version, packageJson.version)
  rel.assertLockfileVersion(version, packageLock)
  const notes = rel.assertNotesFile(root, version)
  const head = git(root, ['rev-parse', 'HEAD^{commit}']).trim()
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`HEAD is not a full commit SHA: ${head}`)
  rel.assertCleanReleaseTree(git(root, ['status', '--porcelain', '--untracked-files=normal']))
  console.log(`version ${version}, commit ${head}, notes ${notes.relative}`)

  const releaseRelative = packageJson.build?.directories?.output
  if (typeof releaseRelative !== 'string' || !releaseRelative) throw new Error('package.json build.directories.output is missing')
  const releaseDir = path.resolve(root, releaseRelative)
  if (fs.existsSync(releaseDir)) throw new Error(`Release output already exists before the build: ${releaseDir}`)

  step('npm run package:win -- --publish never')
  const npm = rel.resolveNpmInvocation()
  const build = spawnSync(npm.command, [...npm.args, 'run', 'package:win', '--', '--publish', 'never'],
    { cwd: root, stdio: 'inherit', windowsHide: true })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error(`package:win failed with exit code ${build.status}`)

  step('Build provenance')
  const resources = path.join(releaseDir, 'win-unpacked', 'resources')
  const installer = path.join(releaseDir, rel.installerSourceName(version))
  for (const required of [resources, installer]) {
    if (!fs.existsSync(required)) throw new Error(`Missing build output: ${required}`)
  }
  const buildInfo = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8'))
  rel.assertBuildProvenance(buildInfo, {
    root, head, version, porcelain: git(root, ['status', '--porcelain', '--untracked-files=normal']),
  })

  step('Engine hashes')
  const engineHashes = rel.deriveEngineHashes({ root, gitFiles: git(root, ['ls-files', '--', 'engine']) })
  console.log(`${Object.keys(engineHashes).length} tracked engine Python sources`)

  step('Packaged runtime (win-unpacked)')
  const packagedRuntime = rel.verifyPackagedRuntime({ root, resources })
  console.log(`runtime ${packagedRuntime.digest.files} files ${packagedRuntime.digest.sha256}`)

  step('Installer payload runtime (extracted, not executed)')
  const payloadRuntime = rel.verifyInstallerPayloadRuntime({
    root, installer,
    workDir: path.join(releaseDir, 'payload-runtime-check'),
    expectedDigest: packagedRuntime.digest,
    expectedPostgresManifestSha256: packagedRuntime.postgresManifestSha256,
  })
  console.log(`payload runtime ${payloadRuntime.digest.files} files ${payloadRuntime.digest.sha256}`)

  step('Packaged hashes and staging')
  const packagedHashes = rel.derivePackagedHashes({
    resources, installer, commit: head, version,
    runtime: {
      sitePackages: 'Lib/site-packages',
      files: packagedRuntime.digest.files,
      sha256: packagedRuntime.digest.sha256,
      imports: [...REPRESENTATIVE_RUNTIME_IMPORTS],
      python: packagedRuntime.probe.python,
      payload: { files: payloadRuntime.digest.files, sha256: payloadRuntime.digest.sha256, imported: true },
    },
  })
  const staged = rel.stageCanonicalAssets({ root, releaseDir, version, engineHashes, packagedHashes })

  step('Local candidate verification')
  const slash = value => value.split(path.sep).join('/')
  const artifacts = rel.CANONICAL_ASSET_NAMES(version).map(name => {
    const file = path.join(staged.uploadDir, name)
    const bytes = fs.readFileSync(file)
    return { name, path: slash(path.relative(root, file)), size: bytes.length,
      sha256: rel.sha256Bytes(bytes), sha512: rel.sha512Bytes(bytes) }
  })
  rel.verifyLocalCandidate({ root, manifest: { version, commit: head, artifacts },
    uploadDir: staged.uploadDir, resources, engineHashes })

  step(`Copy the canonical six to ${out}`)
  fs.mkdirSync(out, { recursive: true })
  if (fs.readdirSync(out).length) throw new Error(`Output directory is not empty: ${out}`)
  for (const record of artifacts) {
    const destination = path.join(out, record.name)
    fs.copyFileSync(path.join(staged.uploadDir, record.name), destination)
    if (rel.hashFile(destination) !== record.sha256) throw new Error(`Copy of ${record.name} differs`)
    console.log(`${record.sha256}  ${record.size}  ${record.name}`)
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${version}\ncommit=${head}\ninstaller=${rel.installerAssetName(version)}\n`)
  }
}

main().catch(error => {
  console.error(`Release CI refused: ${error.stack || error.message}`)
  process.exitCode = 1
})
