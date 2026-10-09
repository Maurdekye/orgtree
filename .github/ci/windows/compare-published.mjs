/*
 * Compare a CI-built Windows release with the PUBLISHED release of the same
 * version, file by file. Informational: it reports, it never fails the build
 * (exit 0 unless it could not run at all).
 *
 * Usage: node compare-published.mjs --ours <dir> --version X --repo owner/name
 *          --sevenzip <7z.exe> --work <dir> [--report <file.json>]
 * Downloads the published assets anonymously from the public download URLs.
 * Prints a markdown report (also appended to $GITHUB_STEP_SUMMARY).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
for (const key of ['ours', 'version', 'repo', 'sevenzip', 'work']) {
  if (!args[key]) throw new Error(`--${key} is required`)
}
const { version } = args
const work = path.resolve(args.work)
const published = path.join(work, 'published')
fs.mkdirSync(published, { recursive: true })

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const lines = []
const say = text => { lines.push(text); console.log(text) }
const report = { version, repo: args.repo, assets: {}, payload: null }

const tag = `v${version}`
const names = ['build-info.json', 'engine-hashes.json', 'latest.yml', `Orgtree-Setup-${version}.exe`,
  `Orgtree-Setup-${version}.exe.blockmap`, 'packaged-hashes.json']
const meta = await fetch(`https://api.github.com/repos/${args.repo}/releases/tags/${tag}`,
  { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'orgtree-ci-compare' } })
if (meta.status !== 200) {
  say(`No public release ${tag} in ${args.repo} (HTTP ${meta.status}); nothing to compare.`)
  process.exit(0)
}
for (const name of names) {
  const target = path.join(published, name)
  if (fs.existsSync(target)) continue
  const response = await fetch(`https://github.com/${args.repo}/releases/download/${tag}/${encodeURIComponent(name)}`)
  if (!response.ok) throw new Error(`Download of published ${name} failed: HTTP ${response.status}`)
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()))
}

say(`## Orgtree ${version}: CI build vs published release`)
say('')
say('### Release assets')
say('| asset | CI sha256 | published sha256 | equal |')
say('|---|---|---|---|')
for (const name of names) {
  const ours = sha256(path.join(args.ours, name))
  const theirs = sha256(path.join(published, name))
  report.assets[name] = { ours, published: theirs, equal: ours === theirs }
  say(`| ${name} | ${ours.slice(0, 16)}… | ${theirs.slice(0, 16)}… | ${ours === theirs ? 'yes' : 'NO'} |`)
}

function diffObjects(label, a, b, prefix = '') {
  const out = []
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const key of [...keys].sort()) {
    const left = a?.[key]
    const right = b?.[key]
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left)) {
      out.push(...diffObjects(label, left, right, `${prefix}${key}.`))
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      out.push({ key: `${prefix}${key}`, ci: left ?? null, published: right ?? null })
    }
  }
  return out
}
for (const name of ['build-info.json', 'packaged-hashes.json']) {
  const diff = diffObjects(name, readJson(path.join(args.ours, name)), readJson(path.join(published, name)))
  report.assets[name].fieldDiff = diff
  say('')
  say(`### ${name}: differing fields (${diff.length})`)
  if (diff.length) {
    say('| field | CI | published |')
    say('|---|---|---|')
    for (const d of diff) say(`| ${d.key} | ${JSON.stringify(d.ci)} | ${JSON.stringify(d.published)} |`)
  }
}

function run7z(params) {
  const result = spawnSync(args.sevenzip, params, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`7-Zip ${params.join(' ')} failed: ${result.stderr || result.stdout}`)
}
function walk(root, dir = root, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else out.set(path.relative(root, full).split(path.sep).join('/'), { size: fs.statSync(full).size, sha256: sha256(full) })
  }
  return out
}
function extract(label, installer) {
  const container = path.join(work, label, 'nsis')
  const payload = path.join(work, label, 'payload')
  fs.rmSync(path.join(work, label), { recursive: true, force: true })
  run7z(['x', '-y', `-o${container}`, installer])
  run7z(['x', '-y', `-o${payload}`, path.join(container, '$PLUGINSDIR', 'app-64.7z')])
  return { container: walk(container), payload: walk(payload) }
}
const installerName = `Orgtree-Setup-${version}.exe`
const ours = extract('ci', path.join(args.ours, installerName))
const theirs = extract('pub', path.join(published, installerName))

function compareTrees(label, a, b) {
  const rows = []
  const all = new Set([...a.keys(), ...b.keys()])
  let equal = 0
  for (const file of [...all].sort()) {
    const left = a.get(file)
    const right = b.get(file)
    if (left && right && left.sha256 === right.sha256) { equal += 1; continue }
    rows.push({ file, ci: left ?? null, published: right ?? null })
  }
  say('')
  say(`### ${label}: ${all.size} files, ${equal} identical, ${rows.length} differ or are missing`)
  if (rows.length) {
    say('| file | CI size | published size | CI sha256 | published sha256 |')
    say('|---|---|---|---|---|')
    for (const row of rows.slice(0, 300)) {
      say(`| ${row.file} | ${row.ci?.size ?? '—'} | ${row.published?.size ?? '—'} | ${row.ci?.sha256.slice(0, 12) ?? '—'} | ${row.published?.sha256.slice(0, 12) ?? '—'} |`)
    }
    if (rows.length > 300) say(`| … ${rows.length - 300} more rows in the JSON report | | | | |`)
  }
  return { files: all.size, identical: equal, differing: rows }
}
report.container = compareTrees('NSIS container (outside app-64.7z)', ours.container, theirs.container)
report.payload = compareTrees('Installer payload app-64.7z', ours.payload, theirs.payload)

if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
