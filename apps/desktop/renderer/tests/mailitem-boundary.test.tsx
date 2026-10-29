// mailitem-boundary.test.tsx — ONE MESSAGE THAT CANNOT RENDER IS AN ERROR ROW;
// IT NEVER TAKES THE WINDOW DOWN
// (user bug 2026-10-29, @item:orgtree/frontend-crashes-when-opening-the-received-tab-o).
//
// The neoja org's Received-tab crash was one message whose sender rendered as
// nothing. The only error boundary above a mailbox was the app-wide
// CrashBoundary, so that one message replaced the whole frontend with "Orgtree
// hit a problem and had to stop". Each list row and the reading pane now end
// at their own boundary: the message says it could not be shown, its
// neighbours stay readable, and the same crash report is still filed.
//
// The failure here is made deterministic: a sender renderer that throws for
// one sender, as the org inbox's did for a sender it was never given.
//
//   §1  the row that cannot render is an error row; the others list and open.
//   §2  that message opened by a link: the reading pane is the error, the
//       list beside it still works, and another message opens in its place.
//   §3  the contained failure is still reported, and neither a re-render nor
//       opening the same message afresh reports it again.
//
// Run:  node apps/desktop/renderer/tests/run.mjs mailitem-boundary
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'

const GOOD: MailRow = { id: 'good', from: '@net:good.peer', kind: 'message', body: 'A message that renders', at: '2026-10-29T09:00:00Z' }
const BAD: MailRow = { id: 'bad', from: '@net:bad.peer', kind: 'message', body: 'A message whose sender cannot render', at: '2026-10-29T09:01:00Z' }

/** a sender renderer that throws `message` for BAD's sender */
const failingSender = (message: string) => (id: string) => {
  if (id === BAD.from) throw new TypeError(message)
  return <b className="sender-name">{id}</b>
}

/** crash reports as the crash reporter delivers them (its fetch fallback) */
function reports(t: TestContext) {
  const filed: { kind: string; message: string }[] = []
  const original = globalThis.fetch
  const beacon = Object.getOwnPropertyDescriptor(window.navigator, 'sendBeacon')
  Object.defineProperty(window.navigator, 'sendBeacon', { configurable: true, value: () => false })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/crash-report')) filed.push(JSON.parse(String(init?.body)).report)
    return new Response('{}', { headers: { 'X-Orgtree-Instance': 'fixture' } })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
    if (beacon) Object.defineProperty(window.navigator, 'sendBeacon', beacon)
    else delete (window.navigator as { sendBeacon?: unknown }).sendBeacon
  })
  return filed
}

async function mount(t: TestContext, message: string, jumpTo?: string) {
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const node = <MailList org="mine" delivered={[GOOD, BAD]} sender={failingSender(message)}
    jumpTo={jumpTo} jumpSeq={jumpTo ? 1 : undefined} toast={() => {}} />
  const view = await mountView(node, (host) => host)
  t.after(() => view.unmount())
  await inAct(() => flush(6))
  return { el: view.el, again: async () => { await view.render(node); await inAct(() => flush(6)) } }
}

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.mailer-list .mailrow')]
const errorRows = (el: HTMLElement) => rows(el).filter((r) => r.getAttribute('role') === 'alert')
const pane = (el: HTMLElement) => el.querySelector<HTMLElement>('.mailer-read')?.textContent ?? ''

test('§1 the row that cannot render is an error row; the other rows still list and open', async (t) => {
  reports(t)
  const { el } = await mount(t, 'sender could not render (§1)')
  assert.equal(rows(el).length, 2, 'both messages keep their place in the list')
  const [error] = errorRows(el)
  assert.ok(error, 'the bad message is an error row')
  assert.equal(errorRows(el).length, 1, 'only the bad message')
  assert.match(error.textContent ?? '', /This message could not be shown/)
  const good = rows(el).find((r) => r.textContent?.includes('@net:good.peer'))
  assert.ok(good, 'the good message is listed with its sender')
  await inAct(async () => { good.click(); await flush(6) })
  assert.match(pane(el), /A message that renders/, 'and it opens')
})

test('§2 opened by a link, the message that cannot render is an error pane; the list still works', async (t) => {
  reports(t)
  const { el } = await mount(t, 'sender could not render (§2)', BAD.id)
  const alert = el.querySelector<HTMLElement>('.mailer-read [role="alert"]')
  assert.ok(alert, 'the reading pane says so')
  assert.match(alert.textContent ?? '', /This message could not be shown/)
  assert.doesNotMatch(pane(el), /A message whose sender cannot render/)
  const good = rows(el).find((r) => r.textContent?.includes('@net:good.peer'))
  assert.ok(good, 'the list beside it is intact')
  await inAct(async () => { good.click(); await flush(6) })
  assert.match(pane(el), /A message that renders/, 'another message opens in its place')
  assert.equal(el.querySelector('.mailer-read [role="alert"]'), null, 'with no error left over')
})

test('§3 the contained failure is still reported, and showing it again does not report it again', async (t) => {
  const filed = reports(t)
  const message = 'sender could not render (§3)'
  // the boundary's own reports: React's development build (these tests) also
  // replays a render error through a window error event, which the crash
  // reporter files as well; production React has no such replay
  const mine = () => filed.filter((r) => r.message === message && r.kind === 'react-boundary')
  const { again } = await mount(t, message, BAD.id)
  assert.ok(mine().length > 0, 'a boundary crash report was filed')
  const before = mine().length
  await again(); await again()
  await mount(t, message, BAD.id)
  assert.equal(mine().length, before, 'not again: re-rendered, or opened afresh in a new panel')
})
