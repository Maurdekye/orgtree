// tierwire.test.tsx — `tierOf` is WIRED, not merely accepted.
//
// ⚠ WHY THIS FILE EXISTS. `MailList` gained a `tierOf` resolver so a mail
// sender's name could carry its model chip. A prop that every caller omits
// draws no chip anywhere and every test of the prop itself still passes — the
// parameter is present, plausible and inert. This mounts the REAL `InboxView`
// with a REAL sender and requires the chip to be in the DOM, and its control
// requires the same mount WITHOUT the resolver to draw no chip, so a green
// result cannot come from a component that always draws one.
//
// Run:  cd frontend && node tests/run.mjs tierwire

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { InboxView } from '../src/canvas/mail'

const INBOX = {
  delivered: [{
    id: 'm1', from: 'worker-agent', to: 'boss', at: '2026-09-05T09:00:00.000Z',
    kind: 'message', body: 'hello', read: true,
  }],
  pending: [], sent: [],
}

function stubFetch() {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const body = String(url).includes('/inbox') ? INBOX : {}
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body),
    })
  }) as unknown as typeof fetch
  return () => { (globalThis as { fetch?: typeof fetch }).fetch = had }
}

const chipsIn = (el: HTMLElement) =>
  [...el.querySelectorAll('.mailer-read .tier')].map((n) => n.className)

async function mountInbox(tierOf?: (id: string) => string | null | undefined) {
  const v = await mountView(
    <InboxView slug="mine" nid="boss" onFocusAgent={() => {}} tierOf={tierOf} />,
    (host) => host)
  await flush(); await advance(200, 16); await flush()
  // ⚠ THE SENDER IS RENDERED IN THE READING PANE, not in the list row, so a
  // mail has to be SELECTED before there is a name to carry a chip at all.
  // Without this the test reports "no chip" for a reason that has nothing to
  // do with the wiring — which is exactly what it did on its first run.
  const row = v.el.querySelector('.mailer-list .mailrow') as HTMLElement | null
  if (row) { await inAct(() => { row.click() }); await flush() }
  return v
}

test('the node inbox draws a sender chip when the caller can resolve the model',
  async () => {
    useFakeClock()
    const restore = stubFetch()
    try {
      const wired = await mountInbox((id) => (id === 'worker-agent' ? 'sonnet' : null))
      const rows = wired.el.querySelectorAll('.mailer-list .mailrow').length
      assert.ok(rows > 0,
        'precondition: no mail row rendered at all, so this test would report '
        + 'a missing chip for a reason unrelated to the wiring')
      const chips = chipsIn(wired.el)
      assert.ok(chips.some((c) => c.includes('t-sonnet')),
        `no sonnet chip beside the sender — tierOf is accepted but not wired `
        + `(chips found: ${JSON.stringify(chips)})`)
      await wired.unmount()

      // THE CONTROL. Without the resolver the SAME mount must draw no chip:
      // otherwise the assertion above would also pass on a component that
      // always draws one, and would prove nothing about the wiring.
      const bare = await mountInbox(undefined)
      assert.deepEqual(chipsIn(bare.el), [],
        'CONTROL BROKEN: a chip appeared with no resolver, so the check above '
        + 'is not measuring the wiring')
      await bare.unmount()
    } finally {
      restore(); realClock()
    }
  })
