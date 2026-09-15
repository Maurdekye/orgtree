// private-update-feed.test.mjs — THE ISOLATED FEED AND THE DECISION THAT USES IT.
//
// The fixture only substitutes at the HANDOFF, which is the end of a flow that
// begins with a feed saying a newer version exists. So a rehearsal build needs a
// feed before its in-app entry is reachable at all, and the whole design goal of
// that feed is ISOLATION: a build composed for rehearsal must never reach the
// public release feed, or a private test could download a real update.
//
// ⚠ THE STRICT DIRECTION IS THE SAFE ONE HERE, and it is the opposite of the
// fixture's production rule. A rehearsal build with no private feed does not
// fall back to the packaged feed — it stops checking entirely. Falling back
// would be precisely the isolation failure this exists to prevent.
//
// Run: node --test tests/private-update-feed.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-private-feed-'))
const require_ = createRequire(import.meta.url)

async function composed(permitted) {
  const outfile = path.join(root, `update-fixture-${permitted}.cjs`)
  await build({
    entryPoints: ['apps/desktop/main/update-fixture.ts'], outfile,
    bundle: true, format: 'cjs', platform: 'node',
    define: { __ORGTREE_UPDATE_FIXTURE__: JSON.stringify(
      'ORGTREE-UPDATE-FIXTURE-BUILD:' + (permitted ? 'enabled' : 'disabled')) },
  })
  return require_(outfile)
}
const enabled = await composed(true)
const disabled = await composed(false)

const feed = await import('../tools/private-update-feed.mjs')

const LOOPBACK = 'http://127.0.0.1:53219/'

// ------------------------------------------------------------ what counts as isolated

test('§1 ⚠ ONLY LOOPBACK COUNTS AS ISOLATED — the guarantee made checkable', () => {
  for (const good of [
    'http://127.0.0.1:1234/', 'http://localhost:9/', 'https://localhost:443/feed/',
    'http://[::1]:8080/', 'http://LOCALHOST:1/', 'http://127.0.0.1/',
  ]) {
    assert.equal(enabled.isLoopbackFeedUrl(good), true, `${good} must be accepted`)
  }
  for (const bad of [
    // The whole point: a public URL cannot be talked into counting as private,
    // however reassuring its name is.
    'https://github.com/Maurdekye/orgtree/releases/',
    'http://localhost.evil.test/', 'http://127.0.0.1.evil.test/',
    'http://not-localhost/', 'https://127.0.0.2/', 'http://10.0.0.1/',
    'file:///C:/feed/', 'ftp://localhost/', 'localhost:1234', '', 'not a url',
  ]) {
    assert.equal(enabled.isLoopbackFeedUrl(bad), false, `${bad} must be rejected`)
  }
})

// ----------------------------------------------------- compiled mode routes first

test('§2 a PRODUCTION build keeps its packaged feed, whatever the environment says', () => {
  assert.deepEqual(disabled.privateFeedDecision({ requested: undefined }), { kind: 'default' })
  assert.deepEqual(disabled.privateFeedDecision({ requested: '  ' }), { kind: 'default' })
  for (const requested of [LOOPBACK, 'https://github.com/x/y/', 'anything']) {
    const decision = disabled.privateFeedDecision({ requested })
    assert.equal(decision.kind, 'ignored', `${requested} must not redirect a released build`)
    assert.match(decision.reason, /IGNORED/)
    assert.match(decision.reason, /keeps its packaged release feed and updates normally/)
  }
})

test('§3 ⚠ A REHEARSAL BUILD WITH NO PRIVATE FEED STOPS CHECKING — it does not fall back', () => {
  for (const requested of [undefined, '', '   ']) {
    const decision = enabled.privateFeedDecision({ requested })
    assert.equal(decision.kind, 'refused')
    assert.match(decision.reason, /will NOT check for updates/)
    assert.match(decision.reason, /would point a rehearsal build at the public feed/)
  }
})

test('§4 a rehearsal build refuses a feed that is not isolated', () => {
  for (const requested of ['https://github.com/Maurdekye/orgtree/releases/', 'http://example.test/']) {
    const decision = enabled.privateFeedDecision({ requested })
    assert.equal(decision.kind, 'refused')
    assert.match(decision.reason, /not an isolated loopback feed/)
    assert.match(decision.reason, /rather than reach a feed outside this machine/)
  }
})

test('§5 a rehearsal build accepts an isolated loopback feed', () => {
  assert.deepEqual(enabled.privateFeedDecision({ requested: `  ${LOOPBACK}  ` }),
    { kind: 'private', url: LOOPBACK })
})

test('§6 ⚠ NO ENVIRONMENT VALUE CAN POINT A RELEASED BUILD SOMEWHERE ELSE', () => {
  // The mirror of §3, and the more important half: whatever is set, a released
  // build's feed selection is never changed by it.
  for (const requested of [
    undefined, '', LOOPBACK, 'http://localhost/', 'https://evil.test/',
    'https://github.com/other/repo/', 'file:///C:/feed/',
  ]) {
    const decision = disabled.privateFeedDecision({ requested })
    assert.ok(decision.kind === 'default' || decision.kind === 'ignored',
      `a released build must never take a private feed (${requested})`)
    assert.equal(decision.url, undefined, 'and must never carry a redirected URL')
  }
})

// --------------------------------------------------------------- the feed itself

test('§7 the feed describes the exact bytes it serves', async () => {
  // electron-updater verifies a download against sha512 and size, so a feed that
  // described anything else would be rejected by the real client. Asserting the
  // hash against an independent computation rather than the writer's own.
  const artifact = path.join(root, 'orgtree-update-fixture.exe')
  fs.writeFileSync(artifact, crypto.randomBytes(4096))
  const directory = path.join(root, 'feed')
  const written = feed.writeFeed({
    directory, artifact, version: '9.9.9-fixture', releaseDate: '2026-09-15T00:00:00.000Z',
  })

  const served = fs.readFileSync(path.join(directory, written.file))
  assert.equal(written.size, served.length)
  assert.equal(written.sha512, crypto.createHash('sha512').update(served).digest('base64'))
  assert.match(written.yml, /^version: 9\.9\.9-fixture$/m)
  assert.match(written.yml, new RegExp(`^path: ${written.file.replace('.', '\\.')}$`, 'm'))
  assert.ok(written.yml.includes(written.sha512))
  assert.match(written.yml, new RegExp(`^ {4}size: ${written.size}$`, 'm'))
})

test('§8 the server binds LOOPBACK ONLY and serves the feed it was given', async () => {
  const artifact = path.join(root, 'served-fixture.exe')
  fs.writeFileSync(artifact, crypto.randomBytes(2048))
  const directory = path.join(root, 'feed-served')
  const written = feed.writeFeed({
    directory, artifact, version: '9.9.9-fixture', releaseDate: '2026-09-15T00:00:00.000Z',
  })
  const server = await feed.serveFeed(directory)
  try {
    // The URL the app would be handed must itself pass the isolation check —
    // otherwise the tool and the guard disagree and one of them is wrong.
    assert.equal(enabled.isLoopbackFeedUrl(server.url), true,
      'the served URL must satisfy the same isolation rule the app enforces')
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)

    const yml = await fetch(server.url + 'latest.yml').then(r => r.text())
    assert.equal(yml, written.yml, 'the served manifest must be the one written')

    const body = Buffer.from(await fetch(server.url + written.file).then(r => r.arrayBuffer()))
    assert.equal(body.length, written.size)
    assert.equal(crypto.createHash('sha512').update(body).digest('base64'), written.sha512,
      'the served bytes must match what the manifest promises, or a real client rejects them')

    // No traversal out of the feed directory.
    const escaped = await fetch(server.url + '..%2F..%2Fpackage.json')
    assert.equal(escaped.status, 404)
  } finally { await server.close() }
})

test('§9 the app-side wiring reads the decision and only ever redirects on private', () => {
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(index, /const updateFeed = privateFeedDecision\(\{ requested: process\.env\[UPDATE_FEED_ENV\] \}\)/)
  // A refused feed must remove the updater entirely, not merely skip the redirect.
  assert.match(index, /const updatesSupported = identity\.updatesSupported && updateFeed\.kind !== 'refused'/)
  assert.match(index, /if \(updateFeed\.kind === 'private'\) \{\s*\r?\n\s*autoUpdater\.setFeedURL\(\{ provider: 'generic', url: updateFeed\.url \}\)/)
  assert.match(index, /updateLog\.record\('update-feed-private'/,
    'a private feed must be recorded so a rehearsal is never mistaken for a real check')
})

// ------------------------------------- CONFINEMENT, DRIVEN THROUGH THE REAL CLIENT
//
// ⚠ EVERYTHING BELOW EXISTS BECAUSE CHECKING THE FEED URL WAS NOT ISOLATION, and
// review proved it with the real GenericProvider and a real HTTP executor rather
// than by argument. Admitting `http://127.0.0.1:…/` says where the MANIFEST is
// fetched from and nothing about where the client goes next:
//
//   - the manifest's `files[].url` may be ABSOLUTE, so a loopback feed can hand
//     back `https://public.invalid/real-setup.exe` and resolveFiles returns it;
//   - a loopback manifest may answer HTTP 302 toward an external host, and the
//     executor follows redirects.
//
// A URL allow-list would have to anticipate each kind of URL separately and
// would still miss the redirect, so the confinement is at the transport boundary
// every request passes through. These tests drive that boundary with the real
// provider, not with parseUpdateInfo — the earlier revision tested the parser
// and the parser was never where the escape was.

const { GenericProvider } = require_('electron-updater/out/providers/GenericProvider.js')
const { NodeHttpExecutor } = require_('builder-util/out/nodeHttpExecutor.js')
const http = await import('node:http')

/** The REAL executor, confined by the SHIPPED function — not a test double of
 *  either. `attempts` records every host the client tried, so a blocked escape
 *  is visible as an attempt that was refused rather than as an absence. */
function confinedExecutor(attempts, blocked) {
  const executor = new NodeHttpExecutor()
  const original = executor.createRequest.bind(executor)
  executor.createRequest = (options, callback) => {
    attempts.push(String(options?.hostname ?? options?.host ?? ''))
    return original(options, callback)
  }
  return enabled.confineExecutorToLoopback(executor, (host) => blocked.push(host))
}

const providerFor = (url, executor) => new GenericProvider(
  { provider: 'generic', url },
  { channel: null, isAddNoCacheQuery: false },
  { platform: 'win32', executor })

test('§10 the real provider reads the generated manifest over loopback', async () => {
  const artifact = path.join(root, 'confined-fixture.exe')
  fs.writeFileSync(artifact, Buffer.from('inert bytes; never executed'))
  const directory = path.join(root, 'feed-confined')
  const written = feed.writeFeed({
    directory, artifact, version: '9.9.9-fixture', releaseDate: '2026-09-15T00:00:00.000Z',
  })
  const server = await feed.serveFeed(directory)
  const attempts = [], blocked = []
  try {
    const client = providerFor(server.url, confinedExecutor(attempts, blocked))
    const info = await client.getLatestVersion()
    assert.equal(info.version, '9.9.9-fixture')
    const resolved = client.resolveFiles(info)
    assert.equal(resolved[0].url.origin, new URL(server.url).origin)
    assert.equal(blocked.length, 0, 'a well-formed loopback feed must not be blocked')
    assert.ok(attempts.every(h => h === '127.0.0.1'), `only loopback was contacted: ${attempts}`)
    void written
  } finally { await server.close() }
})

test('§11 ⚠ AN ABSOLUTE EXTERNAL ARTIFACT URL IS REFUSED — the first measured escape', async () => {
  // resolveFiles happily returns the external URL: that is the library's
  // behaviour and this does not change it. What must be true is that the URL is
  // never REACHED, and that we can say so before downloading rather than after.
  const escapedInfo = {
    version: '9.9.9-fixture',
    files: [{ url: 'https://public.invalid/real-setup.exe', sha512: 'x', size: 1 }],
    path: 'real-setup.exe', sha512: 'x', releaseDate: '2026-09-15T00:00:00.000Z',
  }
  const attempts = [], blocked = []
  const executor = confinedExecutor(attempts, blocked)
  const client = providerFor('http://127.0.0.1:1/', executor)
  const resolved = client.resolveFiles(escapedInfo)
  assert.equal(resolved[0].url.href, 'https://public.invalid/real-setup.exe',
    'the library still resolves it — the escape is real, not hypothetical')

  // The shipped manifest check names it before any request is made.
  const escapes = enabled.manifestEscapes(resolved.map(entry => entry.url))
  assert.deepEqual(escapes, ['https://public.invalid/real-setup.exe'])

  // And the transport refuses it even if something tried anyway.
  assert.throws(() => executor.createRequest({ hostname: 'public.invalid', path: '/real-setup.exe' }, () => {}),
    /not the isolated loopback feed/)
  assert.deepEqual(blocked, ['public.invalid'])
})

test('§12 ⚠ A LOOPBACK FEED THAT REDIRECTS OFF-MACHINE IS REFUSED — the second escape', async () => {
  // The initial URL passes every string check: it IS loopback. The escape is
  // what the server answers, which no admission check on the URL can see.
  const redirect = http.createServer((_request, response) => {
    response.writeHead(302, { Location: 'https://public.invalid/latest.yml' }).end()
  })
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${redirect.address().port}/`
  const attempts = [], blocked = []
  try {
    assert.equal(enabled.privateFeedDecision({ requested: url }).kind, 'private',
      'the redirecting feed is admitted by the URL check — that is the point')
    const client = providerFor(url, confinedExecutor(attempts, blocked))
    await assert.rejects(client.getLatestVersion(), /not the isolated loopback feed/,
      'the redirect must be stopped at the transport boundary')
    assert.deepEqual(blocked, ['public.invalid'],
      'the escape must be named, not merely prevented')
    // ⚠ AND NO EXTERNAL REQUEST EVER REACHED THE TRANSPORT. The recorder sits
    // INSIDE the guard, so a host that appears in `attempts` is one the real
    // executor was actually asked to dial. `public.invalid` is absent from it
    // and present in `blocked`: the client tried, and was stopped before the
    // request existed. That ordering is the assertion, not an accident of it.
    assert.ok(attempts.length > 0, 'the loopback manifest request itself was made')
    assert.deepEqual([...new Set(attempts)], ['127.0.0.1'],
      `only loopback reached the transport, got ${[...new Set(attempts)]}`)
  } finally { await new Promise(resolve => redirect.close(resolve)) }
})

test('§13 the confinement covers EVERY kind of URL, not a list of the ones we thought of', () => {
  // Manifest, artifact, package, blockmap and any future shape all reach the
  // network the same way, which is why the boundary was chosen over an
  // allow-list. This asserts the predicate directly for each.
  const attempts = [], blocked = []
  const executor = confinedExecutor(attempts, blocked)
  for (const host of ['public.invalid', 'example.test', '10.0.0.1', '127.0.0.2', 'localhost.evil.test']) {
    assert.throws(() => executor.createRequest({ hostname: host, path: '/anything' }, () => {}),
      /not the isolated loopback feed/, `${host} must be refused`)
  }
  assert.deepEqual(blocked,
    ['public.invalid', 'example.test', '10.0.0.1', '127.0.0.2', 'localhost.evil.test'])
})

test('§14 manifestEscapes names every offender and passes a clean manifest', () => {
  assert.deepEqual(enabled.manifestEscapes([
    'http://127.0.0.1:1/a.exe', 'http://localhost/b.exe', 'https://[::1]/c.exe',
  ]), [])
  assert.deepEqual(enabled.manifestEscapes([
    'http://127.0.0.1:1/a.exe', 'https://public.invalid/b.exe', 'not a url', 'http://10.0.0.1/d',
  ]), ['https://public.invalid/b.exe', 'not a url', 'http://10.0.0.1/d'])
})

test('§15 ⚠ PRODUCTION IS UNTOUCHED — the confinement is installed on one branch only', () => {
  const index = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  // Exactly ONE call site, and it is inside the private-feed branch. A second
  // one anywhere would mean a released build's networking had been altered.
  const calls = index.split('confineExecutorToLoopback(').length - 1
  assert.equal(calls, 1, `confineExecutorToLoopback must be called exactly once, found ${calls}`)
  const branchAt = index.indexOf("if (updateFeed.kind === 'private') {")
  const callAt = index.indexOf('confineExecutorToLoopback(', branchAt)
  assert.ok(branchAt > 0 && callAt > branchAt && callAt - branchAt < 2000,
    'the only call must sit inside the private-feed branch')
  assert.match(index.slice(branchAt, branchAt + 3000), /exposes no HTTP executor to confine/,
    'a rehearsal that cannot be confined must refuse rather than run unconfined')
})
