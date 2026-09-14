/*
 * Stage a provisioned embedded runtime into THIS checkout, correctly.
 *
 * The 2.1.4-RC4 installer was built from a worktree whose runtime had been
 * copied in by hand, and the copy landed site-packages one level above the
 * `Lib/site-packages` location the interpreter's `._pth` names. This command
 * is the supported replacement for that hand copy:
 *
 *   npm run runtime:stage -- --from <provisioned-checkout-or-runtime-dir>
 *
 * It validates the SOURCE layout before copying, copies file-by-file while
 * refusing links/junctions on either side, validates the DESTINATION layout,
 * and requires byte-identical tree digests before reporting success. It
 * never modifies the source and refuses to overwrite an existing runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertRuntimeLayout, runtimeTreeDigest, RuntimeLayoutError } from './runtime-layout.mjs'

function fail(message) {
  throw new RuntimeLayoutError(message)
}

function realDirOrFail(dir, label) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (!stat) fail(`Missing ${label}: ${dir}`)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory: ${dir}`)
  const resolved = fs.realpathSync(dir)
  const normalize = value => path.normalize(value).replace(/[\\/]$/, '').toLowerCase()
  if (normalize(resolved) !== normalize(path.resolve(dir))) {
    fail(`${label} must not be (or sit behind) a junction or symlink: ${dir}`)
  }
  return resolved
}

function copyTree(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: false })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name)
    const to = path.join(destinationDir, entry.name)
    if (entry.isSymbolicLink()) fail(`Refusing to stage a link: ${from}`)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') continue
      realDirOrFail(from, 'runtime source subdirectory')
      copyTree(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
    } else {
      fail(`Refusing to stage a non-regular entry: ${from}`)
    }
  }
}

export function stageRuntime({ from, root = process.cwd() }) {
  if (!from) fail('runtime:stage needs --from <provisioned-checkout-or-runtime-dir>')
  const fromResolved = path.resolve(from)
  const sourceRuntime = fs.existsSync(path.join(fromResolved, 'engine', 'runtime', 'python.exe'))
    ? path.join(fromResolved, 'engine', 'runtime')
    : fromResolved
  realDirOrFail(sourceRuntime, 'runtime source')
  assertRuntimeLayout(sourceRuntime, { label: 'runtime source' })

  const destination = path.join(path.resolve(root), 'engine', 'runtime')
  if (path.relative(sourceRuntime, destination) === '') fail('Source and destination runtime are the same directory')
  if (fs.existsSync(destination)) {
    fail(`Destination already exists: ${destination}. Remove it first; staging never overwrites.`)
  }
  realDirOrFail(path.dirname(destination), 'destination engine directory')

  copyTree(sourceRuntime, destination)
  assertRuntimeLayout(destination, { label: 'staged runtime' })
  const sourceDigest = runtimeTreeDigest(sourceRuntime)
  const stagedDigest = runtimeTreeDigest(destination)
  if (sourceDigest.sha256 !== stagedDigest.sha256 || sourceDigest.files !== stagedDigest.files) {
    fail(`Staged runtime does not match its source (source ${sourceDigest.files} files ${sourceDigest.sha256}, `
      + `staged ${stagedDigest.files} files ${stagedDigest.sha256})`)
  }
  return { destination, files: stagedDigest.files, sha256: stagedDigest.sha256 }
}

export function main(argv = process.argv.slice(2)) {
  let from = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from') from = argv[++index]
    else fail(`Unknown option: ${argv[index]}`)
  }
  const result = stageRuntime({ from })
  console.log(`Runtime staged: ${result.destination} (${result.files} files, tree sha256 ${result.sha256})`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`Runtime staging refused: ${error.message}`)
    process.exitCode = 1
  }
}
