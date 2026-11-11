// Checks a just-published Orgtree release the way installed apps will see it:
// - every public asset downloads and matches SHA256SUMS.txt, and none is missing;
// - latest.yml (beta.yml for a beta) names the installer with its exact size and SHA-512;
// - latest-linux.yml (beta-linux.yml), when the release has one, names the AppImage with
//   its exact size and SHA-512, and the AppImage carries the blockmap that blockMapSize names;
// - build-info.json names the tag's commit, a clean tree and the release channel,
//   and the macOS/Linux copies (build-info-macos.json, -linux.json) the same version and commit;
// - the standalone engine's Linux archive, Docker image archive and build-info-standalone.json
//   are present (from 4.5.12 on; 4.5.11's are added after publishing by
//   release-standalone.yml), build-info-standalone.json names the tag's version and commit
//   and both files' hashes, and GHCR's <version> (and, for a stable release, latest) tag
//   carries that image's config digest once publish-standalone-image.yml has pushed it;
//   likewise the agents image (orgtree-engine-standalone-<v>-agents-docker-amd64.tar.gz,
//   build-info-standalone-agents.json, GHCR <version>-agents and latest-agents), on top of
//   the same engine binary;
// - GitHub's "latest" release is this one for a stable version, and is not for a
//   prerelease (stable installs are offered whatever "latest" is).
//   TAG=v<x.y.z> GITHUB_REPOSITORY=owner/repo GH_TOKEN=... node verify-published.mjs
import crypto from 'node:crypto'
import { checkLinuxUpdateInfo, linuxChannelFile } from '../linux/update-info.mjs'
import { ghcrImage } from '../standalone/ghcr-image.mjs'

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
const expected = ['build-info.json', 'engine-hashes.json', channelFile, installer, `${installer}.blockmap`, 'packaged-hashes.json', 'SHA256SUMS.txt',
  // macOS and Linux prototypes (every release from release.yml carries them; 4.0.x predates them)
  `Orgtree-${version}-arm64.dmg`, `Orgtree-${version}-arm64.zip`, 'build-info-macos.json',
  `Orgtree-${version}.AppImage`, `orgtree_${version}_amd64.deb`, 'build-info-linux.json']
for (const name of expected) check(name in bytes, `asset ${name} is present`)
// The standalone engine (build-standalone.yml). Every release from 4.5.12 on is built with
// it; an older one has it only once release-standalone.yml has added it.
const standalone = [`orgtree-engine-standalone-${version}-linux-x86_64.tar.gz`,
  `orgtree-engine-standalone-${version}-docker-amd64.tar.gz`, 'build-info-standalone.json']
const [major, minor, patch] = version.split(/[.-]/).map(Number)
const standaloneRequired = major * 1e6 + minor * 1e3 + patch > 4005011
if (standaloneRequired || standalone.some(name => name in bytes)) {
  for (const name of standalone) check(name in bytes, `asset ${name} is present`)
} else console.log(`note ${tag} has no standalone engine yet (add it with release-standalone.yml)`)
const agents = [`orgtree-engine-standalone-${version}-agents-docker-amd64.tar.gz`, 'build-info-standalone-agents.json']
if (standaloneRequired || agents.some(name => name in bytes)) {
  for (const name of agents) check(name in bytes, `asset ${name} is present`)
} else console.log(`note ${tag} has no agents image yet (add it with release-standalone.yml part=agents)`)
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
// The AppImage's feed. Releases staged before Linux updates (4.1.0 and earlier) have none;
// release.yml's stage refuses a release without it from then on.
const linuxFeed = linuxChannelFile(version)
if (linuxFeed in bytes) checkLinuxUpdateInfo({ text: bytes[linuxFeed].toString('utf8'), version, asset: name => bytes[name], check })
else console.log(`note ${linuxFeed} is not in this release (Linux updates began after 4.1.0)`)
let commit = (await api(`git/ref/tags/${encodeURIComponent(tag)}`)).object
while (commit.type === 'tag') commit = (await api(`git/tags/${commit.sha}`)).object
// Pushed by publish-standalone-image.yml, which runs alongside this check: a tag it has
// not pushed yet is a note here (re-run this check after it); a different image fails.
async function checkGhcr(info, tags) {
  for (const t of tags) {
    let found
    try { found = await ghcrImage({ image: info.image.repository, tag: t, token }) } catch (e) { found = { error: e.message } }
    if (found?.error || !found) console.log(`note ${info.image.repository}:${t} not readable yet (${found?.error ?? 'no such tag'}); re-run after publish-standalone-image`)
    else check(found.config === info.image.config_digest, `${info.image.repository}:${t} is the release's image (${info.image.config_digest})`)
  }
}
let standaloneInfo
if ('build-info-standalone.json' in bytes) {
  const info = standaloneInfo = JSON.parse(bytes['build-info-standalone.json'].toString('utf8'))
  check(info.version === version, `build-info-standalone.json version ${info.version}`)
  check(info.commit === commit.sha, `build-info-standalone.json commit is the tag's (${commit.sha})`)
  for (const part of ['binary', 'image']) {
    const file = info[part]?.file
    check(file in bytes && info[part].sha256 === sha256(file), `build-info-standalone.json ${part} ${file} has its sha256`)
  }
  await checkGhcr(info, prerelease ? [version] : [version, 'latest'])
}
if ('build-info-standalone-agents.json' in bytes) {
  const info = JSON.parse(bytes['build-info-standalone-agents.json'].toString('utf8'))
  check(info.version === version, `build-info-standalone-agents.json version ${info.version}`)
  check(info.commit === commit.sha, `build-info-standalone-agents.json commit is the tag's (${commit.sha})`)
  const file = info.image?.file
  check(file in bytes && info.image.sha256 === sha256(file), `build-info-standalone-agents.json image ${file} has its sha256`)
  if (standaloneInfo) {
    check(info.image.engine_sha256 === standaloneInfo.image.engine_sha256, 'the agents image carries the plain image engine binary')
    check(info.image.base_config_digest === standaloneInfo.image.config_digest, 'the agents image is built on the release plain image')
  }
  for (const tool of ['claude-code', 'codex']) check(/^\d+\.\d+\.\d+$/.test(info.tools?.[tool]?.version ?? ''), `build-info-standalone-agents.json pins ${tool} (${info.tools?.[tool]?.version})`)
  await checkGhcr(info, prerelease ? [`${version}-agents`] : [`${version}-agents`, 'latest-agents'])
}
for (const name of ['build-info.json', 'build-info-macos.json', 'build-info-linux.json'].filter(n => n in bytes)) {
  const info = JSON.parse(bytes[name].toString('utf8'))
  check(info.version === version, `${name} version ${info.version}`)
  check(info.commit === commit.sha, `${name} commit is the tag's (${commit.sha})`)
  // Only the Windows build runs the release tool, which guarantees these two.
  if (name === 'build-info.json') check(info.channel === 'release' && info.dirty === false, 'build-info.json: release channel, clean tree')
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
