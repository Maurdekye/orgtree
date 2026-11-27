// The Linux arm64 build beside the x64 one (.github/ci/linux, release.yml, verify-published.mjs):
// - arm64 has its own names (Orgtree-<v>-arm64.AppImage, latest-linux-arm64.yml,
//   orgtree_<v>_arm64.deb, build-info-linux-arm64.json); every x64 name is what it was;
// - a release's staged set is exactly 4.6.3's while arm64 is a candidate (LINUX_ARM64:
//   candidate), and gains exactly the four arm64 files once it is `release`;
// - a published release is checked the same with and without arm64 files, and its arm64
//   feed is held to the arm64 AppImage the way the x64 feed is held to the x64 one.
// Node built-ins only. The cases that run a workflow's shell step need bash and the
// usual tools (sha256sum, stat -c); they skip where there is none.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ci = (...parts) => path.join(ROOT, '.github', 'ci', ...parts)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-linux-arm64-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const info = await import(pathToFileURL(ci('linux', 'update-info.mjs')).href)

// What v4.6.3 published (GitHub's list, 2026-11-19), version aside; SHA256SUMS.txt is
// written by the stage step itself.
const names463 = v => [
  `Orgtree-${v}-arm64.dmg`, `Orgtree-${v}-arm64.zip`, `Orgtree-${v}.AppImage`, `Orgtree-Setup-${v}.exe`,
  `Orgtree-Setup-${v}.exe.blockmap`, 'build-info-linux.json', 'build-info-macos.json',
  'build-info-standalone-agents.json', 'build-info-standalone.json', 'build-info.json', 'engine-hashes.json',
  'latest-linux.yml', 'latest.yml', `orgtree-engine-standalone-${v}-agents-docker-amd64.tar.gz`,
  `orgtree-engine-standalone-${v}-docker-amd64.tar.gz`, `orgtree-engine-standalone-${v}-linux-x86_64.tar.gz`,
  `orgtree_${v}_amd64.deb`, 'packaged-hashes.json']
const arm64Names = (v, channel = 'latest') => [
  `Orgtree-${v}-arm64.AppImage`, `${channel}-linux-arm64.yml`, `orgtree_${v}_arm64.deb`, 'build-info-linux-arm64.json']

/** An AppImage as the feed check sees one: bytes, then the deflated blockmap that covers
 *  them, then the blockmap's length. */
function fakeAppImage(seed) {
  const content = crypto.createHash('sha512').update(seed).digest()
  const map = zlib.deflateRawSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: ['x'], sizes: [content.length] }] }))
  const length = Buffer.alloc(4); length.writeUInt32BE(map.length)
  return { bytes: Buffer.concat([content, map, length]), blockMapSize: map.length }
}
const sha512 = bytes => crypto.createHash('sha512').update(bytes).digest('base64')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const feedText = (version, name, image) => [
  `version: ${version}`, 'files:', `  - url: ${name}`, `    sha512: ${sha512(image.bytes)}`, `    size: ${image.bytes.length}`,
  `    blockMapSize: ${image.blockMapSize}`, `path: ${name}`, `sha512: ${sha512(image.bytes)}`, "releaseDate: '2026-11-19T00:00:00.000Z'", ''].join('\n')

test('arm64 has its own feed and AppImage names; the x64 names are what they were', () => {
  assert.equal(info.linuxChannelFile('4.6.4'), 'latest-linux.yml')
  assert.equal(info.linuxChannelFile('4.6.4', 'x64'), 'latest-linux.yml')
  assert.equal(info.linuxChannelFile('4.6.4-alpha.2'), 'alpha-linux.yml')
  assert.equal(info.linuxChannelFile('4.6.4', 'arm64'), 'latest-linux-arm64.yml')
  assert.equal(info.linuxChannelFile('4.6.4-alpha.2', 'arm64'), 'alpha-linux-arm64.yml')
  assert.equal(info.linuxChannelFile('4.6.4-beta.1', 'arm64'), 'beta-linux-arm64.yml')
  assert.equal(info.linuxAppImage('4.6.4'), 'Orgtree-4.6.4.AppImage')
  assert.equal(info.linuxAppImage('4.6.4', 'arm64'), 'Orgtree-4.6.4-arm64.AppImage')
  assert.throws(() => info.linuxChannelFile('4.6.4', 'armv7l'), /no Linux build for armv7l/)
})

test('the arm64 feed is held to the arm64 AppImage, and never passes for the x64 one', () => {
  const run = (text, assets, arch) => {
    const results = []
    info.checkLinuxUpdateInfo({ text, version: '4.6.4', asset: name => assets[name], check: (ok, message) => results.push([ok, message]), arch })
    return results
  }
  const arm = fakeAppImage('arm64'), x64 = fakeAppImage('x64')
  const assets = { 'Orgtree-4.6.4-arm64.AppImage': arm.bytes, 'Orgtree-4.6.4.AppImage': x64.bytes }
  const good = run(feedText('4.6.4', 'Orgtree-4.6.4-arm64.AppImage', arm), assets, 'arm64')
  assert.ok(good.length >= 8 && good.every(([ok]) => ok), JSON.stringify(good.filter(([ok]) => !ok)))
  assert.ok(good.some(([, message]) => message.startsWith('latest-linux-arm64.yml path Orgtree-4.6.4-arm64.AppImage')))
  // an arm64 feed that names the x64 AppImage would hand arm64 PCs an x64 program
  const wrong = run(feedText('4.6.4', 'Orgtree-4.6.4.AppImage', x64), assets, 'arm64')
  assert.ok(wrong.some(([ok, message]) => !ok && message.includes('latest-linux-arm64.yml path Orgtree-4.6.4.AppImage')), JSON.stringify(wrong))
  // the arm64 AppImage's hash under the x64 file's name
  const swapped = run(feedText('4.6.4', 'Orgtree-4.6.4-arm64.AppImage', x64), assets, 'arm64')
  assert.ok(swapped.some(([ok, message]) => !ok && message.includes('sha512')), JSON.stringify(swapped))
  // and x64 is checked as before
  assert.ok(run(feedText('4.6.4', 'Orgtree-4.6.4.AppImage', x64), assets).every(([ok]) => ok))
})

test('the packaging config names the arm64 AppImage after its architecture and leaves x64 alone', () => {
  const names = arch => {
    const env = { ...process.env }
    delete env.ORGTREE_LINUX_ARCH
    if (arch) env.ORGTREE_LINUX_ARCH = arch
    const child = spawnSync(process.execPath, ['-e',
      'const c = require(process.argv[1]); console.log(JSON.stringify([c.appImage.artifactName, c.linux.artifactName, c.deb.artifactName, c.linux.target]))',
      ci('linux', 'electron-builder.linux.cjs')], { env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  }
  const x64 = ['Orgtree-${version}.${ext}', 'Orgtree-${version}.${ext}', 'orgtree_${version}_${arch}.${ext}', ['AppImage', 'deb']]
  assert.deepEqual(names(), x64)
  assert.deepEqual(names('x64'), x64)
  assert.deepEqual(names('arm64'), ['Orgtree-${version}-arm64.${ext}', 'Orgtree-${version}-arm64.${ext}', 'orgtree_${version}_${arch}.${ext}', ['AppImage', 'deb']])
  const env = { ...process.env, ORGTREE_LINUX_ARCH: 'riscv64' }
  assert.notEqual(spawnSync(process.execPath, ['-e', 'require(process.argv[1])', ci('linux', 'electron-builder.linux.cjs')], { env }).status, 0)
})

// ---- the shell side -------------------------------------------------------------------
const bash = (() => {
  for (const candidate of process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')] : ['/bin/bash', '/usr/bin/bash']) {
    if (fs.existsSync(candidate) && spawnSync(candidate, ['-c', 'echo x | sha256sum >/dev/null && stat -c %s . >/dev/null']).status === 0) return candidate
  }
  return null
})()
const needsBash = bash ? {} : { skip: 'no bash with sha256sum and stat -c here' }
const posixPath = file => process.platform === 'win32' ? file.replace(/\\/g, '/') : file

test('arch.sh gives each architecture its names', needsBash, () => {
  const read = arch => {
    const child = spawnSync(bash, ['-c', '. "$1"; echo "$LINUX_ARCH|$ARCH_SUFFIX|$DEB_ARCH|$UNPACKED"', 'x', posixPath(ci('linux', 'arch.sh'))],
      { env: { ...process.env, ORGTREE_LINUX_ARCH: arch }, encoding: 'utf8' })
    return child.status === 0 ? child.stdout.trim() : `exit ${child.status}`
  }
  assert.equal(read('x64'), 'x64||amd64|release/linux-unpacked')
  assert.equal(read('arm64'), 'arm64|-arm64|arm64|release/linux-arm64-unpacked')
  assert.equal(read('mips'), 'exit 1')
})

/** The `run:` text of one named step of a workflow, by indentation (no YAML library). */
function stepScript(workflow, stepName) {
  const lines = fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflow), 'utf8').replace(/\r/g, '').split('\n')
  const at = lines.findIndex(line => line.trim() === `- name: ${stepName}`)
  assert.ok(at >= 0, `${workflow} has a step "${stepName}"`)
  const run = lines.findIndex((line, index) => index > at && /^\s+run: \|$/.test(line))
  const indent = /^\s*/.exec(lines[run + 1])[0].length
  const body = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && /^\s*/.exec(line)[0].length < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}
const releaseYml = () => fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r/g, '')
/** The value of the workflow's LINUX_ARM64 switch, as release.yml ships it. */
const shippedMode = () => /^  LINUX_ARM64: (\S+)/m.exec(releaseYml())?.[1]

/** Runs release.yml's stage check over a folder holding `names`. */
function stage(names, { version = '4.6.4', prerelease = 'false', mode }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'stage-'))
  fs.mkdirSync(path.join(dir, 'dist'))
  for (const name of names) fs.writeFileSync(path.join(dir, 'dist', name), name)
  const script = path.join(dir, 'stage.sh')
  fs.writeFileSync(script, stepScript('release.yml', 'Check the asset set and write SHA256SUMS.txt'))
  const env = { ...process.env, VERSION: version, PRERELEASE: prerelease, GITHUB_STEP_SUMMARY: posixPath(path.join(dir, 'summary.md')) }
  if (mode) env.LINUX_ARM64 = mode; else delete env.LINUX_ARM64
  const child = spawnSync(bash, ['-eo', 'pipefail', posixPath(script)], { cwd: dir, env, encoding: 'utf8' })
  const sums = path.join(dir, 'dist', 'SHA256SUMS.txt')
  return { status: child.status, output: child.stdout + child.stderr,
    listed: fs.existsSync(sums) ? fs.readFileSync(sums, 'utf8').trim().split('\n').map(line => line.split(/\s+\*?/)[1]).sort() : null }
}

test('release.yml ships with arm64 in the release', () => {
  assert.equal(shippedMode(), 'release')
  const text = releaseYml()
  const job = name => { const at = text.indexOf(`\n  ${name}:\n`); assert.ok(at >= 0, `job ${name}`); return text.slice(at, text.indexOf('\n\n', at + 1)) }
  // the arm64 build runs, with the architecture named, and x64 is called as before
  assert.match(job('linux-arm64'), /uses: \.\/\.github\/workflows\/build-linux\.yml[\s\S]*arch: arm64/)
  assert.doesNotMatch(job('linux'), /arch:/)
  // stage waits for it and takes its four files
  assert.match(text, /\n  stage:\n    needs: \[resolve, windows, macos, linux, linux-arm64, standalone, standalone-agents\]\n/)
  assert.match(text, /\n  draft:\n[\s\S]*?\n    needs: \[resolve, stage\]\n/)
})

test('a candidate arm64 build leaves the staged set exactly as 4.6.3 published it', needsBash, () => {
  for (const [version, prerelease, channel] of [['4.6.4', 'false', 'latest'], ['4.6.4-alpha.1', 'true', 'alpha']]) {
    const x64 = names463(version).map(name => name.replace(/^latest/, channel))
    const staged = stage(x64, { version, prerelease, mode: 'candidate' })
    assert.equal(staged.status, 0, staged.output)
    assert.deepEqual(staged.listed, [...x64].sort())
    // arm64 files that reach the folder anyway are refused, not shipped
    const extra = stage([...x64, ...arm64Names(version, channel)], { version, prerelease, mode: 'candidate' })
    assert.notEqual(extra.status, 0, extra.output)
    assert.match(extra.output, /::error::the builds delivered/)
  }
})

test('once arm64 is in the release, stage wants exactly its four files as well', needsBash, () => {
  const x64 = names463('4.6.4'), arm = arm64Names('4.6.4')
  const staged = stage([...x64, ...arm], { mode: 'release' })
  assert.equal(staged.status, 0, staged.output)
  assert.deepEqual(staged.listed, [...x64, ...arm].sort())
  assert.notEqual(stage(x64, { mode: 'release' }).status, 0, 'a release without the arm64 files is refused')
  assert.notEqual(stage([...x64, ...arm.slice(1)], { mode: 'release' }).status, 0, 'and one missing the arm64 AppImage')
  for (const mode of [undefined, 'yes']) {
    const bad = stage(x64, { mode })
    assert.notEqual(bad.status, 0, `LINUX_ARM64=${mode} is refused`)
    assert.match(bad.output, /LINUX_ARM64 must be candidate or release/)
  }
})

// ---- the published release ------------------------------------------------------------
const TAG = 'v4.6.4', COMMIT = 'c'.repeat(40)
/** A published release as GitHub serves it: 4.6.3's set at 4.6.4, plus `extra` files. */
function published(extra = {}) {
  const v = '4.6.4'
  const x64 = fakeAppImage('x64 release'), installer = Buffer.from('installer')
  const buildInfo = more => Buffer.from(JSON.stringify({ version: v, commit: COMMIT, ...more }))
  const files = Object.fromEntries(names463(v).map(name => [name, Buffer.from(name)]))
  Object.assign(files, {
    [`Orgtree-${v}.AppImage`]: x64.bytes, 'latest-linux.yml': Buffer.from(feedText(v, `Orgtree-${v}.AppImage`, x64)),
    [`Orgtree-Setup-${v}.exe`]: installer,
    'latest.yml': Buffer.from(`version: ${v}\npath: Orgtree-Setup-${v}.exe\nsha512: ${sha512(installer)}\nsize: ${installer.length}\n`),
    'build-info.json': buildInfo({ channel: 'release', dirty: false }), 'build-info-macos.json': buildInfo(), 'build-info-linux.json': buildInfo(),
  })
  const tar = name => files[`orgtree-engine-standalone-${v}-${name}.tar.gz`]
  files['build-info-standalone.json'] = buildInfo({
    binary: { file: `orgtree-engine-standalone-${v}-linux-x86_64.tar.gz`, sha256: sha256(tar('linux-x86_64')) },
    image: { file: `orgtree-engine-standalone-${v}-docker-amd64.tar.gz`, sha256: sha256(tar('docker-amd64')), repository: 'ghcr.io/o/r', config_digest: 'sha256:a', engine_sha256: 'e' } })
  files['build-info-standalone-agents.json'] = buildInfo({
    image: { file: `orgtree-engine-standalone-${v}-agents-docker-amd64.tar.gz`, sha256: sha256(tar('agents-docker-amd64')), repository: 'ghcr.io/o/r', config_digest: 'sha256:b', engine_sha256: 'e', base_config_digest: 'sha256:a' },
    tools: { 'claude-code': { version: '1.0.0' }, codex: { version: '1.0.0' } } })
  for (const [name, bytes] of Object.entries(extra)) { if (bytes === null) delete files[name]; else files[name] = bytes }
  files['SHA256SUMS.txt'] = Buffer.from(Object.keys(files).sort().map(name => `${sha256(files[name])}  ${name}`).join('\n') + '\n')
  return files
}
/** Runs verify-published.mjs against `files`, with GitHub answered from the folder. GHCR is
 *  unreadable (one read, no wait) unless `ghcr` maps a tag to the config digests its reads
 *  return in turn (the last one repeats; null = no such tag yet); `env` adds to the verifier's environment. */
function verify(files, { ghcr = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'published-'))
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes)
  const stub = path.join(dir, '_github.mjs')
  fs.writeFileSync(stub, `
import fs from 'node:fs'
import path from 'node:path'
const dir = ${JSON.stringify(dir)}
const names = fs.readdirSync(dir).filter(name => name !== '_github.mjs')
const json = body => new Response(JSON.stringify(body), { status: 200 })
const ghcr = ${JSON.stringify(ghcr)}, reads = {}
globalThis.fetch = async address => {
  const url = new URL(String(address))
  if (ghcr && url.host === 'ghcr.io') {
    if (url.pathname === '/token') return json({ token: 'b' })
    const prefix = '/v2/o/r/manifests/', tag = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null
    const answers = ghcr[tag]
    if (!answers) return new Response('', { status: 404 })
    const config = answers[Math.min(reads[tag] = (reads[tag] ?? -1) + 1, answers.length - 1)]
    console.log('ghcr read ' + tag + ' -> ' + config)
    if (config === null) return new Response('', { status: 404 })   // not pushed yet
    return new Response(JSON.stringify({ config: { digest: config } }), { status: 200, headers: { 'docker-content-digest': 'sha256:m-' + config } })
  }
  if (url.host === 'fake.invalid') return new Response(fs.readFileSync(path.join(dir, decodeURIComponent(url.pathname.slice(1)))))
  if (url.host !== 'api.github.com') return new Response('', { status: 404 })   // GHCR: not readable here
  const route = url.pathname.replace('/repos/o/r/', '')
  if (route === 'releases/tags/${TAG}') return json({ draft: false, prerelease: false,
    assets: names.map(name => ({ name, size: fs.statSync(path.join(dir, name)).size, browser_download_url: 'https://fake.invalid/' + encodeURIComponent(name) })) })
  if (route === 'git/ref/tags/${TAG}') return json({ object: { type: 'commit', sha: '${COMMIT}' } })
  if (route === 'releases/latest') return json({ tag_name: '${TAG}', prerelease: false })
  return new Response('', { status: 404 })
}
`)
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, ci('releasing', 'verify-published.mjs')],
    { env: { ...process.env, TAG, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 't', GHCR_WAIT_S: '0', ...env }, encoding: 'utf8' })
  return { status: child.status, output: child.stdout + child.stderr }
}
function arm64Release(change = () => {}) {
  const v = '4.6.4', image = fakeAppImage('arm64 release')
  const files = {
    [`Orgtree-${v}-arm64.AppImage`]: image.bytes,
    'latest-linux-arm64.yml': Buffer.from(feedText(v, `Orgtree-${v}-arm64.AppImage`, image)),
    [`orgtree_${v}_arm64.deb`]: Buffer.from('deb'),
    'build-info-linux-arm64.json': Buffer.from(JSON.stringify({ version: v, commit: COMMIT })),
  }
  change(files, image)
  return files
}

test('a published release without arm64 files is checked exactly as before', () => {
  const result = verify(published())
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /ok {3}latest-linux\.yml path Orgtree-4\.6\.4\.AppImage/)
  assert.doesNotMatch(result.output, /arm64\.AppImage|linux-arm64/)
  // and an x64 fault is still a fault
  const broken = verify(published({ 'latest-linux.yml': Buffer.from(feedText('4.6.4', 'Orgtree-4.6.4.AppImage', fakeAppImage('another'))) }))
  assert.notEqual(broken.status, 0, broken.output)
})

test('a published release with the arm64 files has them checked like the x64 ones', () => {
  const result = verify(published(arm64Release()))
  assert.equal(result.status, 0, result.output)
  for (const line of [/ok {3}asset Orgtree-4\.6\.4-arm64\.AppImage is present/, /ok {3}asset orgtree_4\.6\.4_arm64\.deb is present/,
    /ok {3}latest-linux-arm64\.yml path Orgtree-4\.6\.4-arm64\.AppImage/, /ok {3}latest-linux-arm64\.yml top-level sha512 is the AppImage's/,
    /ok {3}build-info-linux-arm64\.json commit is the tag's/, /ok {3}Orgtree-4\.6\.4-arm64\.AppImage matches SHA256SUMS\.txt/]) assert.match(result.output, line)
})

test('a published arm64 build that is incomplete or wrong is a red check', () => {
  const failing = [
    ['no feed', files => { delete files['latest-linux-arm64.yml'] }, /FAIL asset latest-linux-arm64\.yml is present/],
    ['no AppImage', files => { delete files['Orgtree-4.6.4-arm64.AppImage'] }, /FAIL asset Orgtree-4\.6\.4-arm64\.AppImage is present/],
    ['a feed for another file', files => { files['latest-linux-arm64.yml'] = Buffer.from(feedText('4.6.4', 'Orgtree-4.6.4-arm64.AppImage', fakeAppImage('other'))) }, /FAIL latest-linux-arm64\.yml sha512/],
    ['a feed that names the x64 AppImage', (files, image) => { files['latest-linux-arm64.yml'] = Buffer.from(feedText('4.6.4', 'Orgtree-4.6.4.AppImage', image)) }, /FAIL latest-linux-arm64\.yml path Orgtree-4\.6\.4\.AppImage/],
    ['another commit', files => { files['build-info-linux-arm64.json'] = Buffer.from(JSON.stringify({ version: '4.6.4', commit: 'd'.repeat(40) })) }, /FAIL build-info-linux-arm64\.json commit/],
  ]
  for (const [what, change, line] of failing) {
    const result = verify(published(arm64Release(change)))
    assert.notEqual(result.status, 0, `${what}: ${result.output}`)
    assert.match(result.output, line, what)
  }
})

// 4.7.0 (verify-release run 45989923633): the check read latest-agents 32 s before
// publish-standalone-image pushed it, saw 4.6.9's image and failed the release.
test('the published check waits for publish-standalone-image instead of racing its push', () => {
  const race = { '4.6.4': ['sha256:a'], latest: ['sha256:a'], '4.6.4-agents': [null, 'sha256:b'], 'latest-agents': ['sha256:old', 'sha256:old', 'sha256:b'] }
  const missing = { ...race, '4.6.4-agents': [null] }
  const waited = verify(published(), { ghcr: race, env: { GHCR_WAIT_S: '30', GHCR_POLL_S: '0' } })
  assert.equal(waited.status, 0, waited.output)
  assert.match(waited.output, /ok {3}ghcr\.io\/o\/r:latest-agents is the release's image \(sha256:b\)/)
  assert.equal(waited.output.match(/ghcr read latest-agents/g).length, 3, waited.output)
  // without the wait the same moment is a red check, as it was in 4.7.0
  const once = verify(published(), { ghcr: race })
  assert.notEqual(once.status, 0, once.output)
  assert.match(once.output, /FAIL ghcr\.io\/o\/r:latest-agents is the release's image/)
  // a tag still missing when the wait ends stays a note; another image at the end still fails
  const late = verify(published(), { ghcr: missing, env: { GHCR_WAIT_S: '0.2', GHCR_POLL_S: '0.05' } })
  assert.equal(late.status, 0, late.output)
  assert.match(late.output, /note ghcr\.io\/o\/r:4\.6\.4-agents not readable yet/)
  const wrong = verify(published(), { ghcr: { ...race, latest: ['sha256:old'] }, env: { GHCR_WAIT_S: '0.2', GHCR_POLL_S: '0.05' } })
  assert.notEqual(wrong.status, 0, wrong.output)
  assert.match(wrong.output, /FAIL ghcr\.io\/o\/r:latest is the release's image \(sha256:a\)/)
})
