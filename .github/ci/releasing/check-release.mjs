// Checks an Orgtree release before anything is built, from the checked-out source,
// so a wrong tag fails in seconds instead of after the hour-long Windows build:
// the tag is v<version> in the form tools/release-windows.mjs accepts, every
// version surface the release steps bump says the same (docs/rust-engine/HANDOFF.md,
// "Building an alpha", step 1), and a real release has its notes file. Writes
// mode, tag, version, sha and prerelease to GITHUB_OUTPUT.
//   MODE=release|test TAG=<pushed tag or empty> node check-release.mjs
// In test mode the tag is v<package.json version> and missing notes only warn.
// build-windows.yml repeats the package checks with the release tool's own code.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const mode = process.env.MODE
if (mode !== 'release' && mode !== 'test') fail(`MODE must be release or test, got "${mode}"`)
const read = file => fs.readFileSync(file, 'utf8')
const json = file => JSON.parse(read(file))

const pkg = json('package.json')
const tag = process.env.TAG || (mode === 'test' ? `v${pkg.version}` : '')
// tools/release-windows.mjs validReleaseVersion: final, or -alpha.N / -beta.N (never -RCn).
const match = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta)\.(0|[1-9]\d*))?)$/.exec(tag)
if (!match) fail(`an Orgtree release tag looks like v4.1.0 or v4.1.0-beta.1, got "${tag}"`)
const version = match[1]
const prerelease = match[5] !== undefined

const lock = json('package-lock.json')
const engineToml = 'engine/rs/orgtree-engine/Cargo.toml'
const surfaces = [
  ['package.json version', pkg.version],
  ['package-lock.json version', lock.version],
  ['package-lock.json packages[""].version', lock.packages?.['']?.version],
  [`${engineToml} version`, /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(read(engineToml))?.[1]],
]
let bad = 0
for (const [where, found] of surfaces) {
  const ok = found === version
  if (!ok) bad += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${where}: ${found ?? '(not found)'}`)
}
if (bad) fail(`${bad} version surface(s) differ from ${tag}: bump them (engine commit, then app commit) and tag the result`)

const notes = `docs/release-notes-${version}.md`
if (fs.existsSync(notes) && read(notes).trim()) console.log(`ok   ${notes}`)
else if (mode === 'release') fail(`${notes} is missing or empty: the draft's body comes from it`)
else console.log(`::warning::${notes} is missing (fine for a test run)`)

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
console.log(`${mode} ${tag} = ${sha}${prerelease ? ' (prerelease)' : ''}`)
fs.appendFileSync(process.env.GITHUB_OUTPUT,
  `mode=${mode}\ntag=${tag}\nversion=${version}\nsha=${sha}\nprerelease=${prerelease}\n`)

function fail(message) {
  console.log(`::error::${message}`)
  process.exit(1)
}
