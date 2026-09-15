// An ISOLATED LOOPBACK UPDATE FEED, for rehearsing the in-app update route
// against the harmless fixture instead of a real release.
//
//   node tools/private-update-feed.mjs --artifact <exe> --version 9.9.9-fixture
//
// It writes `latest.yml` beside a copy of the artifact and serves both over
// http://127.0.0.1:<port>. The app only accepts a loopback feed, and only on a
// build composed for rehearsal — see update-fixture.ts, privateFeedDecision.
//
// ⚠ NOTHING HERE PUBLISHES. The server binds the loopback interface explicitly,
// so the feed is not reachable from another machine, and it serves a directory
// this tool created rather than anything in the release pipeline.
//
// ⚠ THE ARTIFACT IS THE FIXTURE. electron-updater verifies what it downloads
// against the sha512 and size in latest.yml, so the feed has to describe the
// real bytes it serves — which means the thing offered as "the update" is the
// harmless fixture that installs nothing, not a real installer.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

/** ⚠ THE SAME DEFINITION OF "LOOPBACK" THE APP ENFORCES, restated here because
 *  the tooling runs outside the bundle and cannot import the TypeScript.
 *  tests/update-rehearsal.test.mjs drives BOTH this copy and the compiled
 *  apps/desktop/main/update-fixture.ts one over a shared table of cases and
 *  fails if they ever disagree — a tool that would happily serve or accept a
 *  feed the app rejects, or vice versa, is how an isolation guarantee rots. */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function isLoopbackFeedUrl(value) {
  let url
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname)
}

/** electron-updater's generic provider reads this shape. `path` is resolved
 *  against the feed URL, so a bare filename keeps the feed self-contained. */
export function latestYml({ version, file, sha512, size, releaseDate }) {
  return [
    `version: ${version}`,
    `files:`,
    `  - url: ${file}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')
}

/** Build the feed directory. Returns what was written, so a caller can assert
 *  on it rather than re-deriving it. */
export function writeFeed({ directory, artifact, version, releaseDate }) {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.basename(artifact)
  const target = path.join(directory, file)
  if (path.resolve(artifact) !== path.resolve(target)) fs.copyFileSync(artifact, target)
  const sha512 = sha512Base64(target)
  const size = fs.statSync(target).size
  const yml = latestYml({ version, file, sha512, size, releaseDate })
  fs.writeFileSync(path.join(directory, 'latest.yml'), yml)
  return { directory, file, sha512, size, version, yml }
}

/** Serve the feed on loopback. Resolves with the bound port and a close().
 *
 *  ⚠ A NON-LOOPBACK HOST IS REFUSED RATHER THAN BOUND. The default was already
 *  127.0.0.1, but a default is a convention and this is meant to be a
 *  guarantee: binding 0.0.0.0 would put a directory full of update artifacts on
 *  the local network, which is the one thing a PRIVATE feed must never do. */
export function serveFeed(directory, { host = '127.0.0.1', port = 0 } = {}) {
  if (!isLoopbackHost(host)) {
    return Promise.reject(new Error(
      `refusing to serve a private update feed on [${host}]: loopback only`))
  }
  const server = http.createServer((request, response) => {
    // No traversal: only files that are direct children of the feed directory.
    const name = path.basename(decodeURIComponent((request.url ?? '/').split('?')[0]))
    const target = path.join(directory, name)
    if (!name || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    const size = fs.statSync(target).size
    response.writeHead(200, { 'content-length': String(size) })
    fs.createReadStream(target).pipe(response)
  })
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const bound = server.address()
      resolve({
        url: `http://${host}:${bound.port}/`,
        port: bound.port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

// ---------------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`
  || import.meta.url.endsWith(path.basename(process.argv[1] ?? ''))) {
  const argv = process.argv.slice(2)
  const value = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : fallback
  }
  if (argv.includes('--help') || !value('--artifact')) {
    console.log('usage: node tools/private-update-feed.mjs --artifact <exe> '
      + '[--version 9.9.9-fixture] [--dir <feed dir>] [--port 0] [--serve]')
    process.exit(value('--artifact') ? 0 : 1)
  }
  const written = writeFeed({
    directory: path.resolve(value('--dir', 'dist/private-feed')),
    artifact: path.resolve(value('--artifact')),
    version: value('--version', '9.9.9-fixture'),
    releaseDate: new Date().toISOString(),
  })
  console.log(`feed written to ${written.directory}`)
  console.log(`  version ${written.version}, ${written.file}, ${written.size} bytes`)
  if (argv.includes('--serve')) {
    const served = await serveFeed(written.directory, { port: Number(value('--port', '0')) })
    console.log(`serving ${served.url} — loopback only. Ctrl-C to stop.`)
    console.log(`  ORGTREE_UPDATE_FEED=${served.url}`)
  }
}
