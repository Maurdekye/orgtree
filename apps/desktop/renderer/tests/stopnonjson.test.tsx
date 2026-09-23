import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { haltNode, interruptNode, listOrgs } from '../src/api'

// THE SCREENSHOT THIS FILE EXISTS FOR (user report, 2026-09-20). Stopping an
// agent that was stuck `halting` showed:
//
//     error: Unexpected token 'I', "Internal S"... is not valid JSON
//
// That is our own JSON parser complaining about our own error page. The
// backend answered an unhandled exception with Starlette's default 500 — the
// literal bytes `Internal Server Error`, `text/plain` — and `req` fed every
// non-ok body straight to `r.json()`. Nothing in the message named the agent,
// the stop, or the `[Errno 22] Invalid argument` that actually happened.
//
// Docket: fix-agents-stuck-halting-and-non-json-stop-error. The backend half
// (a JSON catch-all so this body never leaves the server) is pinned in
// tests/test_api_nonjson_error_shape.py. BOTH halves are fixed on purpose:
// either alone still leaves a real failure mode, because a plain-text body
// can come from a layer that is not our handler at all — a proxy, a crash
// before routing, a 502 from something in front.

const withFetch = async (
  reply: () => Response, run: () => Promise<void>,
): Promise<void> => {
  const old = globalThis.fetch
  globalThis.fetch = (async () => reply()) as typeof fetch
  try { await run() } finally { globalThis.fetch = old }
}

const plainText = (status: number, body: string) => () =>
  new Response(body, {
    status,
    statusText: body,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })

test('a plain-text 500 becomes a readable error, not a JSON parse complaint', async () => {
  await withFetch(plainText(500, 'Internal Server Error'), async () => {
    const e = await haltNode('org', 'worker').then(
      () => { throw new Error('the failed stop resolved') },
      (err: unknown) => err as Error)
    // the defect, stated as an assertion: this is what the user was shown
    assert.doesNotMatch(e.message, /is not valid JSON/)
    assert.doesNotMatch(e.message, /Unexpected token/)
    // and what they are shown instead — the status, and the server's words
    assert.match(e.message, /^500: /)
    assert.match(e.message, /Internal Server Error/)
  })
})

test('the same guard covers interrupt, the other verb the stop button reaches', async () => {
  await withFetch(plainText(500, 'Internal Server Error'), async () => {
    const e = await interruptNode('org', 'worker').then(
      () => { throw new Error('the failed interrupt resolved') },
      (err: unknown) => err as Error)
    assert.doesNotMatch(e.message, /is not valid JSON/)
    assert.match(e.message, /^500: Internal Server Error/)
  })
})

test('a JSON error body reads BYTE FOR BYTE as it always did', async () => {
  // The compatibility guarantee, asserted rather than hoped for. Every error
  // string this app shows passes through `failure`, so the normal case — the
  // server stated a reason — must come out undecorated, exactly as
  // `b.detail || r.statusText` produced it.
  const detail = 'halt is still settling — wait for the active turn to end'
  await withFetch(() => new Response(JSON.stringify({ detail }), {
    status: 409, headers: { 'Content-Type': 'application/json' },
  }), async () => {
    const e = await haltNode('org', 'worker').then(
      () => { throw new Error('resolved') }, (err: unknown) => err as Error)
    assert.equal(e.message, detail)
  })
})

test('a stub response exposing only json() is read the same way', async () => {
  // Most suites in this folder hand-roll a Response with `json()` and no
  // `text()`. `failure` must still find the detail through it.
  const detail = 'no capacity on that account'
  await withFetch(() => ({
    ok: false, status: 409, statusText: 'err', headers: new Headers(),
    json: async () => ({ detail }),
  } as unknown as Response), async () => {
    const e = await haltNode('org', 'worker').then(
      () => { throw new Error('resolved') }, (err: unknown) => err as Error)
    assert.equal(e.message, detail)
  })
})

test('an empty error body still says something', async () => {
  // `new Error(b.detail || r.statusText)` produced `new Error('')` here,
  // which renders as no message at all — a failed call that looked like
  // nothing happening.
  await withFetch(() => new Response('', { status: 502, statusText: '' }), async () => {
    const e = await haltNode('org', 'worker').then(
      () => { throw new Error('resolved') }, (err: unknown) => err as Error)
    assert.ok(e.message.trim().length > 3, JSON.stringify(e.message))
    assert.match(e.message, /502/)
  })
})

test('an HTML error page is quoted, not pasted whole', async () => {
  const page = '<html><body>' + 'x'.repeat(5000) + '</body></html>'
  await withFetch(() => new Response(page, {
    status: 503, statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/html' },
  }), async () => {
    const e = await haltNode('org', 'worker').then(
      () => { throw new Error('resolved') }, (err: unknown) => err as Error)
    assert.doesNotMatch(e.message, /is not valid JSON/)
    assert.ok(e.message.length < 400, `message was ${e.message.length} chars`)
    assert.match(e.message, /^503: /)
  })
})

test('the status code rides on the error for callers that branch on it', async () => {
  await withFetch(plainText(409, 'Conflict'), async () => {
    const e = await haltNode('org', 'worker').then(
      () => { throw new Error('resolved') }, (err: unknown) => err as Error)
    assert.equal((e as Error & { status?: number }).status, 409)
    assert.match(e.message, /Conflict/)
  })
})

test('a 2xx that is not JSON is reported as such rather than as a parse error', async () => {
  await withFetch(() => new Response('not json at all', {
    status: 200, headers: { 'Content-Type': 'text/plain' },
  }), async () => {
    const e = await listOrgs().then(
      () => { throw new Error('resolved') }, (err: unknown) => err as Error)
    assert.match(e.message, /was not JSON/)
    assert.match(e.message, /text\/plain/)
  })
})

// THE NEGATIVE CONTROL. The old expression, run against the same response, so
// the message the user actually saw is measured here rather than quoted from
// a screenshot — and so the assertions above cannot pass vacuously.
test('negative control: the pre-fix expression produces the reported message', async () => {
  const r = plainText(500, 'Internal Server Error')()
  const e = await r.json().then(
    () => { throw new Error('the plain-text body parsed as JSON') },
    (err: unknown) => err as Error)
  assert.match(e.message, /is not valid JSON/)
  assert.match(e.message, /Internal S/)
})
