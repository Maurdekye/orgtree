// restart.test.ts — the forced refresh when orgtree is restarted (D-60).
//
// A redeploy replaces both halves of the app but only restarts the server one:
// every open tab keeps running the bundle it loaded, against an API that may
// have changed underneath it. The backend stamps each response with the id of
// the process that answered (`api.INSTANCE`, fresh per start); the client keeps
// the first one it sees and reloads the page when a different one arrives.
//
// The whole mechanism is four lines in one function, and all four are the kind
// that fail silently: a baseline captured from the wrong response reloads on
// the first request; a missing latch reloads N times for N in-flight responses;
// reading the header only on `ok` responses misses a restart during an outage,
// which is exactly when one happens.
//
// Run:  cd frontend && node tests/run.mjs restart

import './harness'
import { FakeServer, installFetch } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getChat } from '../src/api'

/** injected by tests/run.mjs — the bundle does not sit next to the sources */
declare const __SRC_DIR__: string

/** replace `location` with a stand-in whose reload() we can count.
 *
 *  ⚠ a Proxy over the real jsdom Location does NOT work: `reload` is a
 *  non-configurable own property, so the proxy invariant forbids returning a
 *  different function for it. A plain object carrying the three fields the app
 *  reads is the way. */
function watchReload(): { count: () => number } {
  let n = 0
  const real = globalThis.location
  Object.defineProperty(globalThis, 'location', {
    value: {
      href: real.href, pathname: real.pathname, host: real.host,
      protocol: real.protocol, search: real.search, origin: real.origin,
      reload: () => { n += 1 },
    },
    configurable: true, writable: true,
  })
  return { count: () => n }
}

// ⚠ ONE test, deliberately. `api.ts` holds the baseline and the reload latch in
// module scope — as it must, since they describe the PAGE — so a second test
// would run against whatever the first left behind. The sequence below is the
// whole lifecycle in order.
test('the page reloads once when the backend id changes, and not before', async () => {
  const server = new FakeServer()
  installFetch(server)
  const rl = watchReload()

  // ① the first response is the BASELINE, never a reload — nothing has changed
  //   yet, and a client that reloads here loops forever on load
  await getChat('org', 'agent')
  assert.equal(rl.count(), 0, 'the first response must only set the baseline')

  // ② the same server, many times over: still nothing
  for (let i = 0; i < 5; i++) await getChat('org', 'agent')
  assert.equal(rl.count(), 0, 'an unchanged id is not an event')

  // ③ a FAILED response from the same server is not a restart either
  server.fail = 500
  await getChat('org', 'agent').catch(() => {})
  server.fail = null
  assert.equal(rl.count(), 0, 'a 500 from the same process is not a restart')

  // ④ the redeploy
  server.instance = 'inst-1'
  await getChat('org', 'agent')
  assert.equal(rl.count(), 1, 'a new backend id reloads the page')

  // ⑤ …exactly once, however many responses were already in flight. Without
  //   the latch every one of them calls reload() on a page that is already
  //   tearing down.
  await Promise.all([getChat('org', 'agent'), getChat('org', 'agent'),
                     getChat('org', 'agent')])
  assert.equal(rl.count(), 1, 'the reload latches — one per restart, not one '
    + 'per response')

  server.instance = 'inst-2'
  await getChat('org', 'agent')
  assert.equal(rl.count(), 1, 'and it stays latched: the page is going away')
})

test('the detector reads a header the server actually sends', () => {
  // a spelling drift on either side silently disables the whole feature —
  // there is no error path, the header is simply never found. Pin the name to
  // the source of truth on both sides.
  const src = readFileSync(path.join(__SRC_DIR__, 'api.ts'), 'utf8')
  assert.ok(/r\.headers\.get\('X-Orgtree-Instance'\)/.test(src),
    'api.ts no longer reads X-Orgtree-Instance')
  const api = readFileSync(
    path.join(__SRC_DIR__, '..', '..', 'backend', 'orgtree', 'api.py'), 'utf8')
  assert.ok(/b"x-orgtree-instance"/.test(api),
    'the backend no longer sends x-orgtree-instance — drift guard')
  assert.ok(/INSTANCE = secrets\.token_hex/.test(api),
    'the instance id is no longer per-process — drift guard')
})
