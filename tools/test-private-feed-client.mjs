// Drives the REAL electron-updater client against the isolated loopback feed.
//
// WHY THIS EXISTS AND WHY IT IS NOT IN tests/: it starts an HTTP server and
// exercises a third-party client, which is more than `npm test` should do. What
// it establishes is the one claim the unit tests cannot make for themselves —
// that the feed this repo generates is accepted by the SHIPPED update client,
// not merely by our own reader of it. A feed we invented and only we can parse
// would prove nothing about the in-app route.
//
// ⚠ IT TALKS ONLY TO LOOPBACK. The server binds 127.0.0.1 and the client is
// pointed at that address; nothing contacts GitHub or any public feed, which is
// the isolation property the whole private-feed design exists for.
//
// ⚠ NOTHING IS DOWNLOADED INTO THE APP'S CACHE, INSTALLED, ELEVATED OR LAUNCHED.
// It drives the client's own MANIFEST PARSER — the function its provider calls to
// decide whether an update exists and where its bytes are — and then fetches
// those bytes itself to verify them. The full provider cannot be constructed
// outside Electron; see the note at the call site for why stubbing it would make
// the result meaningless. The handoff that would run the fixture is covered by
// tools/test-update-fixture-artifact.mjs and tests/update-fixture.test.mjs.
//
// Run: node tools/test-private-feed-client.mjs

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { serveFeed, writeFeed } from './private-update-feed.mjs'

const require_ = createRequire(import.meta.url)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-private-feed-client-'))

// A stand-in for the artifact. The real fixture is built by
// tools/build-update-fixture.mjs; what matters to the CLIENT is only that the
// bytes match what the manifest promises, so a deterministic blob keeps this
// check independent of whether NSIS is available.
const artifact = path.join(temp, 'orgtree-update-fixture.exe')
fs.writeFileSync(artifact, crypto.createHash('sha256').update('orgtree-fixture').digest())

const written = writeFeed({
  directory: path.join(temp, 'feed'),
  artifact,
  version: '9.9.9-fixture',
  releaseDate: '2026-09-15T00:00:00.000Z',
})
const server = await serveFeed(written.directory)

try {
  console.log(`feed served at ${server.url} (loopback only)`)

  // ⚠ THE FULL PROVIDER CANNOT BE CONSTRUCTED OUTSIDE ELECTRON, and stubbing it
  // would leave exactly the half we care about unexercised. GenericProvider is
  // built with an ElectronHttpExecutor, which reaches for electron's `net`; a
  // stubbed executor would mean testing our own stub's opinion of the manifest
  // rather than the client's. So this drives the client's OWN PARSER against the
  // manifest this repo generates — the same function the provider calls — and
  // then verifies the bytes the parsed manifest points at.
  const { parseUpdateInfo } = require_('electron-updater/out/providers/Provider.js')
  const yml = await fetch(server.url + 'latest.yml').then(r => r.text())
  const info = parseUpdateInfo(yml, 'latest.yml', server.url + 'latest.yml')

  assert.equal(info.version, '9.9.9-fixture',
    "the shipped client's own parser must read the version this repo wrote")
  assert.equal(info.path, written.file)
  assert.equal(info.sha512, written.sha512)
  assert.ok(Array.isArray(info.files) && info.files.length === 1)
  assert.equal(info.files[0].url, written.file)
  assert.equal(info.files[0].size, written.size)
  assert.equal(info.files[0].sha512, written.sha512)
  console.log('PASS electron-updater\'s own parser accepts the generated manifest')

  // And the bytes it points at are the bytes that are there. This is the check a
  // real download performs before handing anything to the installer path.
  const body = Buffer.from(await fetch(server.url + info.files[0].url).then(r => r.arrayBuffer()))
  assert.equal(body.length, info.files[0].size)
  assert.equal(crypto.createHash('sha512').update(body).digest('base64'), info.files[0].sha512)
  console.log('PASS the served bytes satisfy the manifest the client would verify against')

  // The version has to be NEWER than what the app reports, or no offer is made.
  const { default: semver } = await import('semver').catch(() => ({ default: null }))
  if (semver) {
    assert.equal(semver.gt('9.9.9-fixture', '2.1.5-RC3'), true,
      'the fixture version must outrank the shipped one or no update is ever offered')
    console.log('PASS the fixture version outranks the installed one, so an offer would be made')
  } else {
    console.log('NOTE semver unavailable; version ordering not checked here')
  }
} finally {
  await server.close()
  fs.rmSync(temp, { recursive: true, force: true })
}
console.log('Private feed client check contacted loopback only; nothing was downloaded '
  + 'into the app cache, installed, elevated, launched or published.')
