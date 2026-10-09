// Checks a just-published Orgtree release the way installed apps will see it:
// - every public asset downloads and matches SHA256SUMS.txt, and none is missing;
// - latest.yml (beta.yml for a beta) names the installer with its exact size and SHA-512;
// - build-info.json names the tag's commit, a clean tree and the release channel;
// - GitHub's "latest" release is this one for a stable version, and is not for a
//   prerelease (stable installs are offered whatever "latest" is).
//   TAG=v<x.y.z> GITHUB_REPOSITORY=owner/repo GH_TOKEN=... node verify-published.mjs
import crypto from 'node:crypto'

const { TAG: tag, GITHUB_REPOSITORY: repo, GH_TOKEN: token } = process.env
const version = /^v(.+)$/.exec(tag ?? '')?.[1] ?? fail(`not a version tag: ${tag}`)
const prerelease = /-(alpha|beta)\.\d+$/.test(version)
const channelFile = prerelease ? `${/-(alpha|beta)\./.exec(version)[1]}.yml` : 'latest.yml'
const installer = `Orgtree-Setup-${version}.exe`
const api = async path => {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'orgtree-verify' } })
  if (!response.ok) fail(`GET ${path}: HTTP ${response.status}`)
  return response.json()
}
const problems = []
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) problems.push(message) }

const release = await api(`releases/tags/${encodeURIComponent(tag)}`)
check(!release.draft, `release ${tag} is public`)
check(!!release.prerelease === prerelease, `prerelease flag is ${!!release.prerelease} (version ${version} wants ${prerelease})`)

// Public download URLs, unauthenticated, exactly as the updater fetches them.
const bytes = {}
for (const asset of release.assets) {
  const response = await fetch(asset.browser_download_url)
  if (!response.ok) { check(false, `${asset.name} downloads (HTTP ${response.status})`); continue }
  bytes[asset.name] = Buffer.from(await response.arrayBuffer())
  check(bytes[asset.name].length === asset.size, `${asset.name}: ${asset.size} bytes`)
}
const sha256 = name => crypto.createHash('sha256').update(bytes[name]).digest('hex')
const expected = ['build-info.json', 'engine-hashes.json', channelFile, installer, `${installer}.blockmap`, 'packaged-hashes.json', 'SHA256SUMS.txt']
for (const name of expected) check(name in bytes, `asset ${name} is present`)
if ('SHA256SUMS.txt' in bytes) {
  const listed = new Map(bytes['SHA256SUMS.txt'].toString('utf8').trim().split('\n').map(line => line.split(/\s+\*?/).reverse()))
  for (const name of Object.keys(bytes).filter(n => n !== 'SHA256SUMS.txt')) {
    check(listed.get(name) === sha256(name), `${name} matches SHA256SUMS.txt`)
  }
  for (const name of listed.keys()) check(name in bytes, `${name} (in SHA256SUMS.txt) is published`)
}
if (channelFile in bytes && installer in bytes) {
  const yml = bytes[channelFile].toString('utf8')
  const field = key => new RegExp(`^${key}:\\s*'?([^'\\r\\n]+)'?`, 'm').exec(yml)?.[1]
  const sha512 = crypto.createHash('sha512').update(bytes[installer]).digest('base64')
  check(field('version') === version, `${channelFile} version ${field('version')}`)
  check(field('path') === installer, `${channelFile} path ${field('path')}`)
  check(field('sha512') === sha512, `${channelFile} sha512 is the installer's`)
  check(yml.includes(`size: ${bytes[installer].length}`), `${channelFile} size is the installer's (${bytes[installer].length})`)
}
let commit = (await api(`git/ref/tags/${encodeURIComponent(tag)}`)).object
while (commit.type === 'tag') commit = (await api(`git/tags/${commit.sha}`)).object
if ('build-info.json' in bytes) {
  const info = JSON.parse(bytes['build-info.json'].toString('utf8'))
  check(info.version === version, `build-info.json version ${info.version}`)
  check(info.commit === commit.sha, `build-info.json commit is the tag's (${commit.sha})`)
  check(info.channel === 'release' && info.dirty === false, 'build-info.json: release channel, clean tree')
}
const latest = await api('releases/latest')
if (prerelease) check(latest.tag_name !== tag && !latest.prerelease, `"latest" stays a stable release (${latest.tag_name})`)
else check(latest.tag_name === tag, `"latest" is ${tag} (it is ${latest.tag_name})`)

if (problems.length) fail(`${problems.length} problem(s) with the published ${tag}; see docs/ci-release.md, "Rolling back"`)
console.log(`${tag} is published correctly`)

function fail(message) {
  console.log(`::error::${message}`)
  process.exit(1)
}
