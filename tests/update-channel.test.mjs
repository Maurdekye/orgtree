// update-channel.test.mjs — WHICH RELEASE AN INSTALLED BUILD IS OFFERED.
//
// Installing a release candidate left the updater unable to reach the next
// normal release. The cause was never version ordering — semver has always said
// 2.1.5 > 2.1.5-RC3 — but CHANNEL SELECTION inside electron-updater's GitHub
// provider, together with release metadata that marked every build, candidates
// included, as GitHub's "latest" release.
//
// The provider reads the first dot-separated component of a version's
// prerelease label as a CHANNEL NAME, and accepts only a release on a matching
// channel. `2.1.5-RC3` sits on a channel called "RC3" whose only member is
// itself. It recognises exactly two names as a prerelease LINE that also moves
// up to stable: `alpha` and `beta`. Hence `2.1.5-beta.4`.
//
// ⚠ THESE TESTS DRIVE THE REAL PROVIDER, not a restatement of its rules.
// electron-updater's own GitHubProvider.getLatestVersion() runs against a
// controlled releases feed, configured with the app's OWN compiled rule and the
// same GitHub options the packaged app-update.yml carries. Asserting on a
// helper of ours would only prove we agree with ourselves; the library decides
// this.
//
// Nothing here touches the network — the provider's httpRequest and executor
// are replaced — and nothing is built, published, tagged or released.
//
// Run: node --test tests/update-channel.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

import {
  CANONICAL_ASSET_NAMES, channelFileName, isPrereleaseVersion, releaseChannelOf,
  releaseVisibility, validReleaseVersion, verifyPublicRelease,
} from '../tools/release-windows.mjs'

const require_ = createRequire(import.meta.url)
const { GitHubProvider } = require_('electron-updater/out/providers/GitHubProvider')
const semver = require_('semver')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-update-channel-'))

/** The app's own rule, compiled from the shipped source. Every expectation
 *  below is driven through whatever it returns, so a change to the rule changes
 *  the measured outcome rather than silently diverging from it. */
const outfile = path.join(tmp, 'build-channel.cjs')
await build({
  entryPoints: ['apps/desktop/main/build-channel.ts'], outfile,
  bundle: true, format: 'cjs', platform: 'node',
})
const { allowPrereleaseUpdates, updateChannelOf, PRERELEASE_CHANNELS } = require_(outfile)

/** The GitHub options the PACKAGED app-update.yml carries, read from
 *  package.json's publish block rather than typed out here. */
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const publish = (pkg.build?.publish ?? []).find(entry => entry?.provider === 'github')

// ---------------------------------------------------------------- the harness

function atomFeed(tags) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<feed xmlns="http://www.w3.org/2005/Atom">'
    + tags.map(tag =>
      `<entry><link rel="alternate" type="text/html" href="https://github.com/${publish.owner}`
      + `/${publish.repo}/releases/tag/${tag}"/>`
      + `<id>tag:github.com,2008:Repository/1/${tag}</id>`
      + '<updated>2026-09-15T00:00:00Z</updated>'
      + '<content type="html">notes</content></entry>').join('')
    + '</feed>'
}

const manifestYml = (version) => `version: ${version}\n`
  + `files:\n  - url: Orgtree-Setup-${version}.exe\n    sha512: ${'A'.repeat(88)}\n    size: 1\n`
  + `path: Orgtree-Setup-${version}.exe\nsha512: ${'A'.repeat(88)}\n`
  + 'releaseDate: \'2026-09-15T00:00:00.000Z\'\n'

/** ⚠ GITHUB'S /releases/latest RETURNS THE NEWEST NON-PRERELEASE RELEASE.
 *  `prereleaseTags` is how a test states which releases were PUBLISHED as
 *  GitHub prereleases — the metadata half of this fix, and the half that
 *  decides whether a stable install ever sees a beta. */
function latestEndpointTag(tags, prereleaseTags) {
  return tags.find(tag => !prereleaseTags.includes(tag)) ?? null
}

/** Runs the REAL provider. Returns what it offered and which manifest files it
 *  asked GitHub for. `publishedManifests` lets a test publish a release whose
 *  channel manifest is missing, so the fallback path is measurable. */
async function offeredTo(currentVersion, {
  tags,
  prereleaseTags = tags.filter(tag => tag.includes('-')),
  allowPrerelease = allowPrereleaseUpdates(currentVersion),
  publishedManifests = null,
} = {}) {
  const updater = { currentVersion, allowPrerelease, channel: null, fullChangelog: false }
  const asked = []
  const provider = new GitHubProvider(
    { provider: 'github', owner: publish.owner, repo: publish.repo },
    updater,
    {
      isUseMultipleRangeRequest: false,
      executor: {
        request: async (options) => {
          const href = `${options.path ?? options.href ?? ''}`
          const file = href.split('/').pop()
          const tag = String(href.split('/').at(-2)).replace(/^v/, '')
          asked.push(`${tag}/${file}`)
          if (publishedManifests && !publishedManifests.includes(file)) {
            throw Object.assign(new Error(`404 ${href}`), { statusCode: 404 })
          }
          return manifestYml(tag)
        },
      },
    })
  provider.httpRequest = async (url) => {
    const href = String(url)
    if (href.endsWith('.atom')) return atomFeed(tags)
    if (href.endsWith('/latest')) {
      const tag = latestEndpointTag(tags, prereleaseTags)
      if (tag === null) throw Object.assign(new Error('404 no latest release'), { statusCode: 404 })
      return JSON.stringify({ tag_name: tag })
    }
    throw new Error(`unexpected request ${href}`)
  }
  try {
    const info = await provider.getLatestVersion()
    return { offered: info.version, asked }
  } catch (error) {
    return { offered: null, error: String(error?.message ?? error).split('\n')[0], asked }
  }
}

/** electron-updater's own availability rule is pure semver, so a test can say
 *  "offered AND accepted" rather than merely "offered". */
const wouldInstall = (offered, current) =>
  offered !== null && semver.valid(offered) && semver.gt(offered, current)

// ------------------------------------------------ the required path: beta → stable

test('§1 ⚠ AN INSTALLED BETA MOVES ONTO STABLE', async () => {
  // The whole reason this ticket exists: a prerelease must not be a dead end.
  const result = await offeredTo('2.1.5-beta.4',
    { tags: ['2.1.5', '2.1.5-beta.5', '2.1.5-beta.4', '2.1.4'] })
  assert.equal(result.offered, '2.1.5', result.error ?? '')
  assert.equal(wouldInstall(result.offered, '2.1.5-beta.4'), true,
    'and accepted as newer, not merely offered')
  assert.deepEqual(result.asked, ['2.1.5/latest.yml'],
    'reading the stable release\'s own manifest')
})

test('§2 ⚠ AN INSTALLED BETA ALSO RECEIVES A NEWER BETA', async () => {
  const result = await offeredTo('2.1.5-beta.4', { tags: ['2.1.5-beta.5', '2.1.5-beta.4', '2.1.4'] })
  assert.equal(result.offered, '2.1.5-beta.5', result.error ?? '')
  assert.equal(wouldInstall(result.offered, '2.1.5-beta.4'), true)
  assert.deepEqual(result.asked, ['2.1.5-beta.5/beta.yml'],
    'from beta.yml — which is why the release tooling publishes the manifest '
    + 'under the channel name')
})

test('§3 stable wins over a newer-numbered beta of the same version', async () => {
  // Both are published; semver puts 2.1.5 above every 2.1.5-beta.N, and the
  // provider walks the feed newest-first.
  const result = await offeredTo('2.1.5-beta.4', { tags: ['2.1.5', '2.1.5-beta.9'] })
  assert.equal(result.offered, '2.1.5')
})

// ----------------------------------------------- why the label had to change

test('§4 ⚠ AN RC-LABELLED BUILD IS STRANDED ON ITSELF — the measured defect', async () => {
  // The negative control, and the reason release candidates are now labelled
  // beta.N. The provider derives the channel `RC3` from the whole label and
  // accepts only a release carrying that same label, so the one release it
  // ever finds is the one already installed.
  const stranded = await offeredTo('2.1.5-RC3', {
    tags: ['2.1.5', '2.1.5-RC4', '2.1.5-RC3', '2.1.4'],
    allowPrerelease: true,
  })
  assert.equal(stranded.offered, '2.1.5-RC3', 'it is offered ITSELF')
  assert.equal(wouldInstall(stranded.offered, '2.1.5-RC3'), false,
    'which is not newer, so the installation never moves again')
  assert.notEqual(stranded.offered, '2.1.5-RC4',
    'and it could not see the newer candidate either')
  assert.notEqual(stranded.offered, '2.1.5')
})

test('§5 ⚠ A DOTTED rc.N LABEL WOULD NOT HAVE FIXED IT EITHER', async () => {
  // Worth pinning, because `rc.4` looks like the obvious tidy-up and is not.
  // `rc` is still a private channel: the beta line reaches stable only because
  // the library hardcodes the NAME.
  const result = await offeredTo('2.1.5-rc.3', {
    tags: ['2.1.5', '2.1.5-rc.4', '2.1.5-rc.3'], allowPrerelease: true,
  })
  assert.equal(result.offered, '2.1.5-rc.4', 'it tracks its own line')
  assert.notEqual(result.offered, '2.1.5', 'but stable is invisible to it')
  assert.deepEqual([...PRERELEASE_CHANNELS], ['alpha', 'beta'],
    'the only two names the library treats as a line that also reaches stable')
})

// ------------------------------------------ stable installs never take prereleases

test('§6 ⚠ A STABLE INSTALL IS NOT OFFERED A BETA', async () => {
  const result = await offeredTo('2.1.4', { tags: ['2.1.5-beta.4', '2.1.4'] })
  assert.equal(result.offered, '2.1.4')
  assert.equal(wouldInstall(result.offered, '2.1.4'), false, 'nothing newer is accepted')
})

test('§7 ⚠ AND THAT HOLDS ONLY BECAUSE THE BETA IS PUBLISHED AS A PRERELEASE', async () => {
  // The metadata half. Same versions, but the beta was published as a NORMAL
  // release the way this tooling used to publish everything — GitHub then hands
  // it out as "latest" and the stable install takes it.
  const asNormalRelease = await offeredTo('2.1.4', {
    tags: ['2.1.5-beta.4', '2.1.4'], prereleaseTags: [],
  })
  assert.equal(asNormalRelease.offered, '2.1.5-beta.4')
  assert.equal(wouldInstall(asNormalRelease.offered, '2.1.4'), true,
    'a stable installation would install a prerelease — the defect the release '
    + 'tooling change prevents')
})

test('§8 a stable install still takes a newer stable', async () => {
  // The positive control: none of this may switch updates off.
  const result = await offeredTo('2.1.4', { tags: ['2.1.5', '2.1.5-beta.4', '2.1.4'] })
  assert.equal(result.offered, '2.1.5')
  assert.equal(wouldInstall(result.offered, '2.1.4'), true)
})

// ------------------------------------------------------------- the app's own rule

test('§9 the shipped rule: a prerelease tracks prereleases, a stable build does not', () => {
  for (const prerelease of ['2.1.5-beta.4', '2.1.5-alpha.1', '2.1.5-RC3']) {
    assert.equal(allowPrereleaseUpdates(prerelease), true, prerelease)
  }
  for (const stable of ['2.1.5', '2.1.4', '3.0.0']) {
    assert.equal(allowPrereleaseUpdates(stable), false, stable)
  }
  assert.equal(updateChannelOf('2.1.5-beta.4'), 'beta')
  assert.equal(updateChannelOf('2.1.5-RC3'), 'RC3', 'the whole label, which is the bug')
  assert.equal(updateChannelOf('2.1.5'), null)
})

test('§10 version ordering was never the problem, and is pinned so it stays that way', () => {
  assert.equal(semver.gt('2.1.5', '2.1.5-beta.4'), true, 'stable is newer than its own beta')
  assert.equal(semver.gt('2.1.5-beta.5', '2.1.5-beta.4'), true)
  assert.equal(semver.gt('2.1.5-beta.4', '2.1.4'), true, 'a beta is newer than the last stable')
  assert.equal(semver.gt('2.1.4', '2.1.5-beta.4'), false)
  assert.deepEqual(semver.prerelease('2.1.5-beta.4'), ['beta', 4])
  assert.deepEqual(semver.prerelease('2.1.5-RC3'), ['RC3'], 'one component, hence one channel')
})

// ═══════════════════════════════════════════════════════════════════════════
// THE PUBLISHING HALF. §7 showed that keeping a stable install off a beta
// depends on the beta being published as a GitHub prerelease, and §2 showed the
// beta line depends on the manifest being published as beta.yml. These drive
// the release tooling's own decisions and its own verification. Nothing here
// publishes, tags or contacts GitHub.
// ═══════════════════════════════════════════════════════════════════════════

test('§11 ⚠ THE RELEASE TOOLING REFUSES AN RC LABEL', () => {
  // The guardrail that stops the stranding being re-published.
  for (const rc of ['2.1.5-RC1', '2.1.5-RC4', '2.1.6-RC1']) {
    assert.equal(validReleaseVersion(rc), false, `${rc} must be refused`)
  }
  for (const good of ['2.1.5', '2.1.5-beta.4', '2.1.5-alpha.1', '10.0.0-beta.0']) {
    assert.equal(validReleaseVersion(good), true, `${good} must be accepted`)
  }
  for (const malformed of ['2.1.5-beta', '2.1.5-beta.x', '2.1.5-BETA.4', '2.1.5-', 'v2.1.5']) {
    assert.equal(validReleaseVersion(malformed), false, `${malformed} must be refused`)
  }
})

test('§12 ⚠ A PRERELEASE IS PUBLISHED AS A PRERELEASE AND IS NOT LATEST', () => {
  for (const prerelease of ['2.1.5-beta.4', '2.1.5-alpha.1']) {
    assert.equal(isPrereleaseVersion(prerelease), true, prerelease)
    const visibility = releaseVisibility(prerelease)
    assert.equal(visibility.prerelease, true)
    assert.equal(visibility.latest, false, `${prerelease} must not become GitHub's latest`)
    assert.deepEqual(visibility.flags, ['--prerelease=true', '--latest=false'])
  }
  for (const stable of ['2.1.5', '2.1.4']) {
    assert.equal(isPrereleaseVersion(stable), false, stable)
    assert.deepEqual(releaseVisibility(stable).flags, ['--prerelease=false', '--latest=true'])
  }
})

test('§13 ⚠ THE MANIFEST IS PUBLISHED UNDER THE NAME THE UPDATER ASKS FOR', () => {
  // §2 measured the updater requesting beta.yml. The release asset set has to
  // contain that exact name, or every beta check 404s before falling back.
  assert.equal(channelFileName('2.1.5-beta.4'), 'beta.yml')
  assert.equal(channelFileName('2.1.5-alpha.1'), 'alpha.yml')
  assert.equal(channelFileName('2.1.5'), 'latest.yml')
  assert.equal(releaseChannelOf('2.1.5-beta.4'), 'beta')
  assert.equal(releaseChannelOf('2.1.5'), null)

  assert.ok(CANONICAL_ASSET_NAMES('2.1.5-beta.4').includes('beta.yml'))
  assert.ok(!CANONICAL_ASSET_NAMES('2.1.5-beta.4').includes('latest.yml'))
  assert.ok(CANONICAL_ASSET_NAMES('2.1.5').includes('latest.yml'))
  assert.equal(CANONICAL_ASSET_NAMES('2.1.5-beta.4').length, 6, 'still six assets')
})

test('§14 a beta release missing beta.yml falls back, which is why it is published', async () => {
  // Shows the cost of getting §13 wrong: the check still works, but only by
  // making a failed request first. Measured rather than assumed.
  const result = await offeredTo('2.1.5-beta.4', {
    tags: ['2.1.5-beta.5', '2.1.5-beta.4'], publishedManifests: ['latest.yml'],
  })
  assert.equal(result.offered, '2.1.5-beta.5')
  assert.deepEqual(result.asked, ['2.1.5-beta.5/beta.yml', '2.1.5-beta.5/latest.yml'],
    'beta.yml is asked for first and 404s')
})

test('§15 the publication step uses the visibility decision rather than fixed flags', () => {
  // The tooling previously passed --prerelease=false --latest=true for every
  // release. A behavioural test cannot reach the `gh` invocation without
  // actually publishing, so this pins the one thing behaviour cannot: that the
  // hard-coded pair is gone and the decision is what is passed.
  const source = fs.readFileSync('tools/release-windows.mjs', 'utf8')
  assert.ok(!/'--prerelease=false', '--latest=true'/.test(source),
    'the unconditional flags that published every prerelease as latest must be gone')
  assert.match(source, /releaseVisibility\(manifest\.version\)\.flags/)
})

// ------------------------------------------------- verification, both directions

const responseJson = (value, status = 200) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => value })
const responseBytes = (bytes, status = 200) => {
  const buffer = Buffer.from(bytes)
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }
}
const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sha512Of = (bytes) => crypto.createHash('sha512').update(bytes).digest('base64')

function verificationFixture(version, { prerelease, latestTag, latestPrerelease = false }) {
  const owner = 'Maurdekye'
  const repo = 'orgtree'
  const tag = `v${version}`
  const commit = 'c'.repeat(40)
  const prefix = `https://github.com/${owner}/${repo}/releases/download/${tag}/`
  const installer = `Orgtree-Setup-${version}.exe`
  const installerBytes = Buffer.from(`installer ${version}`)
  const sha512 = sha512Of(installerBytes)
  const manifest = `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n`
    + `    size: ${installerBytes.length}\npath: ${installer}\nsha512: ${sha512}\n`
    + 'releaseDate: \'2026-09-15T00:00:00.000Z\'\n'
  // ⚠ THE CANONICAL SET FROM THE TOOLING'S OWN LIST, so the fixture follows the
  // channel filename instead of disagreeing with it and failing for that.
  const buildInfo = JSON.stringify({ version, commit, channel: 'release', dirty: false })
  const body = (name) => name === channelFileName(version) ? Buffer.from(manifest)
    : name === installer ? installerBytes
      : name === 'build-info.json' ? Buffer.from(`${buildInfo}\n`)
        : name === 'packaged-hashes.json' ? Buffer.from(`{"commit":"${commit}"}\n`)
          : name.endsWith('.json') ? Buffer.from('{}\n')
            : Buffer.from(`${name}\n`)
  const contents = new Map(CANONICAL_ASSET_NAMES(version).map(name => [name, body(name)]))
  const artifacts = [...contents].map(([name, bytes]) => ({
    name, size: bytes.length, sha256: sha256Of(bytes), sha512: sha512Of(bytes),
  }))
  const release = {
    id: 1, tag_name: tag, name: `Orgtree ${version}`, draft: false, prerelease,
    html_url: `${prefix}..`,
    assets: [...contents].map(([name, bytes]) =>
      ({ name, size: bytes.length, browser_download_url: prefix + name })),
  }
  const api = `https://api.github.com/repos/${owner}/${repo}`
  const fetchImpl = async (url) => {
    if (url === `${api}/releases/tags/${tag}`) return responseJson(release)
    if (url === `${api}/releases/latest`) {
      return responseJson({ tag_name: latestTag, draft: false, prerelease: latestPrerelease })
    }
    if (url === `${api}/git/ref/tags/${tag}`) {
      return responseJson({ object: { type: 'commit', sha: commit } })
    }
    for (const [name, bytes] of contents) if (url === prefix + name) return responseBytes(bytes)
    return responseJson({ message: 'not found' }, 404)
  }
  return { manifest: { version, commit, tag, artifacts }, owner, repo, fetchImpl }
}

const noRetry = { retries: 1, delayMs: 0 }

test('§16 ⚠ VERIFICATION REFUSES A PRERELEASE PUBLISHED AS A NORMAL RELEASE', async () => {
  const fixture = verificationFixture('2.1.5-beta.4', { prerelease: false, latestTag: 'v2.1.5-beta.4' })
  await assert.rejects(() => verifyPublicRelease({ ...fixture, retry: noRetry }),
    /prerelease flag is false, expected true/)
})

test('§17 ⚠ VERIFICATION REFUSES A PRERELEASE THAT BECAME THE LATEST RELEASE', async () => {
  const fixture = verificationFixture('2.1.5-beta.4', { prerelease: true, latestTag: 'v2.1.5-beta.4' })
  await assert.rejects(() => verifyPublicRelease({ ...fixture, retry: noRetry }),
    /would be offered to stable installations/)
})

test('§18 verification refuses when the latest release is itself a prerelease', async () => {
  const fixture = verificationFixture('2.1.5-beta.4',
    { prerelease: true, latestTag: 'v2.1.5-beta.3', latestPrerelease: true })
  await assert.rejects(() => verifyPublicRelease({ ...fixture, retry: noRetry }),
    /is itself a[\s\S]*prerelease/)
})

test('§19 verification refuses a STABLE release published as a prerelease', async () => {
  // The other direction: a stable release marked prerelease reaches nobody.
  const fixture = verificationFixture('2.1.5', { prerelease: true, latestTag: 'v2.1.5' })
  await assert.rejects(() => verifyPublicRelease({ ...fixture, retry: noRetry }),
    /prerelease flag is true, expected false/)
})

test('§20 verification ACCEPTS a correct beta and a correct stable', async () => {
  // Positive controls, so none of the above is passing by refusing everything.
  const beta = verificationFixture('2.1.5-beta.4', { prerelease: true, latestTag: 'v2.1.4' })
  const betaResult = await verifyPublicRelease({ ...beta, retry: noRetry })
  assert.equal(betaResult.release.prerelease, true)
  assert.equal(betaResult.latest.tag, 'v2.1.4', 'the beta did not become latest')

  const stable = verificationFixture('2.1.5', { prerelease: false, latestTag: 'v2.1.5' })
  const stableResult = await verifyPublicRelease({ ...stable, retry: noRetry })
  assert.equal(stableResult.release.prerelease, false)
  assert.equal(stableResult.latest.tag, 'v2.1.5')
})
