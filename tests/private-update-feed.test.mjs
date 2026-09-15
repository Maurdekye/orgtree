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
