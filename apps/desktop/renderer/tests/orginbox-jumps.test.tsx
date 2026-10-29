// orginbox-jumps.test.tsx — A LINK INTO THE ORG INBOX OPENS ITS MESSAGE IN THE
// FOLDER THAT HOLDS IT, AND A LOOKED-UP MESSAGE READS LIKE A LISTED ONE
// (user bug 2026-10-29, @item:orgtree/frontend-crashes-when-opening-the-received-tab-o).
//
// On the neoja org the user opened the org inbox from a link to a message the
// org had SENT, clicked Received, and the whole frontend stopped: "Cannot read
// properties of undefined (reading 'startsWith')" in the reading pane's sender.
// The panel's two folders are one MailList instance, so the jump went on into
// Received, which did not hold the message and so looked it up by id. The
// engine answers an org-box lookup with the org inbox's own entry ({dir, peer,
// by}); the panel handed that to the list as a mail row with no `from` or
// `to`, and the pane's sender renderer called startsWith on nothing.
//
//   §1  the reported path: a link to a Sent message, then Received, then Sent.
//   §2  a link to a Sent message the canvas preview does not hold (the panel
//       started on Received and crashed at once).
//   §3  a link to a received message older than the loaded window is looked
//       up and read in Received, with its sender.
//   §4  a link to a sent message older than the window: the answer belongs in
//       Sent, so the panel moves there and names the recipient.
//   §5  a new link while the panel is open on Received moves to the folder
//       that holds its message.
//
// Every fetch answers with the engine's own wire shapes: GET org_inbox lists
// orginbox::entry rows, oldest first, and GET mail/org/<id> answers
// {found, mail} with that same entry (http/mailbox.rs mail_by_id).
//
// Run:  node apps/desktop/renderer/tests/run.mjs orginbox-jumps
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { OrgInboxEntry } from '../src/types'

// the message the user's link opened: sent through a hub to a recipient who
// was offline, so it is still queued
const SENT: OrgInboxEntry = { id: 'x0queued0001', dir: 'out', peer: '@net:offline.peer', by: 'user',
  body: 'Queued while the recipient is offline', at: '2026-10-29T09:54:05Z', state: 'queued', state_at: '2026-10-29T09:54:05Z' }
// received mail of the kinds a busy org gets: Hebrew text, video, image and archive attachments
const HEBREW: OrgInboxEntry = { id: 'in-hebrew', dir: 'in', peer: '@net:star.peer', body: 'שלום! הקבצים מצורפים', at: '2026-10-29T09:56:00Z',
  attachments: [{ name: 'clip.mp4', bytes: 1048576 }, { name: 'shot.png', bytes: 20480 }, { name: 'bundle.zip', bytes: 4096 }] }
const LATEST: OrgInboxEntry = { id: 'in-latest', dir: 'in', peer: '@net:second.peer', body: 'The newest received message', at: '2026-10-29T09:58:00Z' }
// older than the newest-100 window the panel loads: only a lookup by id finds them
const OLD_IN: OrgInboxEntry = { id: 'old-in', dir: 'in', peer: '@net:far.peer', body: 'An older received message', at: '2026-10-01T08:00:00Z' }
const OLD_OUT: OrgInboxEntry = { id: 'old-out', dir: 'out', peer: '@net:far.peer', by: 'user', body: 'An older sent message', at: '2026-10-01T08:05:00Z', state: 'delivered' }
const LOG = [SENT, HEBREW, LATEST]

/** the engine: `log` is the loaded window, `held` every row a lookup can find */
function serve(t: TestContext, log: OrgInboxEntry[], held: OrgInboxEntry[] = log) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const byId = /\/mail\/org\/([^/?]+)/.exec(url)
    const mail = byId ? held.find((e) => e.id === decodeURIComponent(byId[1]!)) ?? null : null
    const body = url.endsWith('/org_inbox') ? { entries: log, total: held.length, unread: 0 }
      : byId ? { found: mail !== null, mail }
      : { transfers: [] }
    return new Response(JSON.stringify(body), { headers: { 'X-Orgtree-Instance': 'fixture' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
}

// a lookup can lead to a folder move and a second lookup: several rounds
async function settle() { for (let i = 0; i < 4; i++) await inAct(() => flush(8)) }

/** the panel as the canvas opens it from a link: `preview` is the tree's
 *  newest few rows, `jumpTo` the linked message */
async function open(t: TestContext, preview: OrgInboxEntry[], jumpTo: string) {
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const panel = (id: string, seq: number) => (
    <OrgInboxModal slug="mine" map={new Map()} toast={() => {}} close={() => {}}
      inbox={{ entries: preview, total: LOG.length, unread: 0, visible: true, holders: [] }}
      jumpTo={id} jumpSeq={seq} />)
  const view = await mountView(panel(jumpTo, 1), (host) => host)
  t.after(() => view.unmount())
  await settle()
  return {
    el: view.el,
    /** another link clicked while the panel is open */
    jump: async (id: string, seq: number) => { await view.render(panel(id, seq)); await settle() },
  }
}

const folder = (el: HTMLElement, name: 'inbox' | 'sent') =>
  [...el.querySelectorAll<HTMLButtonElement>('.mail-folders > button')]
    .find((b) => (b.textContent ?? '').trim().startsWith(name))
const isOpen = (el: HTMLElement, name: 'inbox' | 'sent') => Boolean(folder(el, name)?.classList.contains('on'))
async function choose(el: HTMLElement, name: 'inbox' | 'sent') {
  const button = folder(el, name)
  assert.ok(button, `the ${name} folder exists`)
  await inAct(async () => { button.click(); await flush(8) })
  await settle()
}
const pane = (el: HTMLElement) => el.querySelector<HTMLElement>('.mailer-read')?.textContent ?? ''
const list = (el: HTMLElement) => el.querySelector<HTMLElement>('.mailer-list')?.textContent ?? ''
const named = (el: HTMLElement, address: string) =>
  el.querySelector(`.mailer-read [data-hub-address="${address}"]`) !== null

test('§1 a link to a Sent message, then Received: Received lists its mail and the message stays in Sent', async (t) => {
  serve(t, LOG)
  const { el } = await open(t, [SENT], SENT.id)
  assert.ok(isOpen(el, 'sent'), 'the link opened Sent')
  assert.match(pane(el), /Queued while the recipient is offline/)
  await choose(el, 'inbox')
  assert.ok(el.querySelector('.mailwrap'), 'the org inbox is still on screen')
  assert.ok(isOpen(el, 'inbox'), 'Received is the open folder')
  assert.match(list(el), /שלום! הקבצים מצורפים/)
  assert.match(list(el), /The newest received message/)
  assert.doesNotMatch(pane(el), /Queued while the recipient/, 'the Sent message is not read in Received')
  assert.match(pane(el), /select a mail to read it/)
  await choose(el, 'sent')
  assert.match(pane(el), /Queued while the recipient is offline/, 'back in Sent, the linked message is still open')
})

test('§2 a link to a Sent message the canvas preview does not hold opens it in Sent', async (t) => {
  serve(t, LOG)
  const { el } = await open(t, [LATEST], SENT.id)
  assert.ok(isOpen(el, 'sent'), 'the panel moved to Sent')
  assert.match(pane(el), /Queued while the recipient is offline/)
  assert.ok(named(el, SENT.peer), 'the recipient is named')
})

test('§3 a link to a received message older than the window is looked up and read in Received with its sender', async (t) => {
  serve(t, LOG, [OLD_IN, ...LOG])
  const { el } = await open(t, [], OLD_IN.id)
  assert.ok(isOpen(el, 'inbox'), 'Received holds it')
  assert.match(pane(el), /An older received message/)
  assert.ok(named(el, OLD_IN.peer), 'its sender is named')
  assert.match(list(el), /The newest received message/, 'the list beside it is the loaded window')
})

test('§4 a link to a sent message older than the window opens it in Sent with its recipient', async (t) => {
  serve(t, LOG, [OLD_OUT, ...LOG])
  const { el } = await open(t, [], OLD_OUT.id)
  assert.ok(isOpen(el, 'sent'), 'the answer belongs in Sent')
  assert.match(pane(el), /An older sent message/)
  assert.ok(named(el, OLD_OUT.peer), 'its recipient is named')
  await choose(el, 'inbox')
  assert.doesNotMatch(pane(el), /An older sent message/, 'Received does not read it')
  assert.match(list(el), /The newest received message/)
})

test('§5 a new link while the panel is open on Received moves to the folder that holds its message', async (t) => {
  serve(t, LOG)
  const { el, jump } = await open(t, [SENT, LATEST], LATEST.id)
  assert.ok(isOpen(el, 'inbox'))
  assert.match(pane(el), /The newest received message/)
  await jump(SENT.id, 2)
  assert.ok(isOpen(el, 'sent'), 'the new link moved the panel to Sent')
  assert.match(pane(el), /Queued while the recipient is offline/)
  await jump(LATEST.id, 3)
  assert.ok(isOpen(el, 'inbox'), 'and a link back to received mail returns to Received')
  assert.match(pane(el), /The newest received message/)
})
