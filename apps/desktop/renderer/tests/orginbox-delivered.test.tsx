import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { OrgInboxEntry } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

// USER 2026-10-29 ma660da825904: the detail of a mail in the org inbox lists
// every agent the mail was delivered to, as the outbox lists who sent it as the
// org. The engine records the list at delivery (`delivered_to`).
const received = (delivered?: string[]): OrgInboxEntry => ({ id: 'in-1', dir: 'in', peer: '@net:alice.fixture',
  body: 'Hello org', at: '2026-10-18T12:00:00Z', ...(delivered ? { delivered_to: delivered } : {}) }) as OrgInboxEntry
const sent: OrgInboxEntry = { id: 'out-1', dir: 'out', peer: '@net:peer.fixture', by: 'coordinator-opus',
  body: 'Outbox body', at: '2026-10-18T12:05:00Z', state: 'read' }
const map = new Map<string, CanvasNode>([
  ['coordinator-opus', { id: 'coordinator-opus', tier: 'opus', state: 'live' } as CanvasNode],
  ['liaison-opus', { id: 'liaison-opus', tier: 'opus', state: 'live' } as CanvasNode],
  ['old-reviewer', { id: 'old-reviewer', tier: 'sonnet', state: 'archived' } as CanvasNode],
])
async function open(t: { after: (fn: () => void) => void }, entries: OrgInboxEntry[], jumpTo: string) {
  const saved = globalThis.fetch
  globalThis.fetch = (async input => new Response(JSON.stringify(String(input).endsWith('/org_inbox')
    ? { entries, total: entries.length, unread: 0 } : { transfers: [] }))) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const focus: unknown[][] = []
  const v = await mountView(<OrgInboxModal slug="fixture" inbox={{ entries, total: entries.length, unread: 0, visible: true, holders: [] }}
    map={map} onFocusAgent={(...args) => focus.push(args)} toast={() => {}} close={() => {}} jumpTo={jumpTo} />, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(5) })
  return { ...v, focus }
}

test('§1 a received mail lists every agent it was delivered to beside its sender, as the outbox does', async t => {
  const v = await open(t, [received(['coordinator-opus', 'liaison-opus', 'old-reviewer', 'gone-agent'])], 'in-1')
  const group = v.el.querySelector('.mailer-head .org-mail-attribution')
  assert.ok(group, 'the sender and the recipients are one wrapping attribution group')
  assert.ok(group.querySelector('[data-hub-address="@net:alice.fixture"]'), 'the outside sender is still the hub contact link')
  const recipients = group.querySelector('.org-mail-recipient')
  assert.ok(recipients, 'the recipients use the outbox recipient markup')
  assert.match(recipients.textContent ?? '', /→.*coordinator-opus.*liaison-opus.*old-reviewer.*gone-agent/s, 'every agent, in delivery order')
  const live = recipients.querySelector<HTMLButtonElement>('button.ref-agent[data-agent-nav="coordinator-opus"]')
  assert.ok(live, 'a live agent is the shared AgentLink')
  assert.equal(live.textContent, 'O@coordinator-opus')
  await inAct(() => live.click())
  assert.deepEqual(v.focus, [['coordinator-opus']], 'the shared link forwards only the id to camera focus')
})

test('§2 a retired or removed recipient still shows by name, as an inert dim chip', async t => {
  const v = await open(t, [received(['coordinator-opus', 'old-reviewer', 'gone-agent'])], 'in-1')
  const recipients = v.el.querySelector('.mailer-head .org-mail-recipient')
  assert.ok(recipients)
  for (const name of ['old-reviewer', 'gone-agent']) {
    assert.equal(recipients.querySelector(`[data-agent-nav="${name}"]`), null, `${name} does not navigate`)
    const chip = [...recipients.querySelectorAll('.ref-agent')].find(c => (c.textContent ?? '').includes(name))
    assert.ok(chip, `${name} is named`)
    assert.equal(chip.tagName, 'SPAN', `${name} is inert`)
    assert.ok(!chip.classList.contains('ref-ready'), `${name} wears the dim, not-ready chip`)
  }
  const live = recipients.querySelector('[data-agent-nav="coordinator-opus"]')
  assert.ok(live, 'the live recipient beside them still navigates')
})

test('§3 controls: a mail with no record, the outbox and the list rows are unchanged', async t => {
  const none = await open(t, [received()], 'in-1')
  assert.equal(none.el.querySelector('.mailer-head .org-mail-recipient'), null, 'nothing recorded, nothing drawn')
  assert.equal(none.el.querySelector('.mailer-head .org-mail-attribution'), null)
  assert.match(none.el.querySelector('.mailer-head')?.textContent ?? '', /@net:alice\.fixture/)

  const withList = await open(t, [received(['coordinator-opus', 'liaison-opus'])], 'in-1')
  assert.equal(withList.el.querySelector('.mailrow .org-mail-recipient'), null, 'the list row names only the sender')

  const out = await open(t, [sent], 'out-1')
  assert.equal(out.el.querySelectorAll('.mailer-head .org-mail-attribution .org-mail-recipient').length, 1, 'the outbox keeps its one recipient')
  assert.match(out.el.querySelector('.mailer-head .org-mail-attribution')?.textContent ?? '', /as @org:fixture.*→.*@net:peer\.fixture/)
})

// USER 2026-10-30 md37bd35d3884, on the delivered-to line in 4.5.2-alpha.3: "should say "as @org:xyz" after like in the
// sent tab". The Sent tab names its agent "@agent as @org:<slug> -> @recipient"; the received line names the agents
// the same way, each one followed by the Sent tab's own suffix (the .org-mail-via markup, the shared org link).
test('§4 each agent a received mail was delivered to is followed by "as @org:<slug>", the suffix of the Sent tab', async t => {
  const names = ['coordinator-opus', 'liaison-opus', 'old-reviewer', 'gone-agent']
  const v = await open(t, [received(names)], 'in-1')
  const recipients = v.el.querySelector('.mailer-head .org-mail-recipient')
  assert.ok(recipients, 'the delivered-to line is drawn')
  const vias = [...recipients.querySelectorAll('.org-mail-via')]
  assert.equal(vias.length, names.length, 'one suffix per agent, live, retired and removed alike')
  names.forEach((name, i) => {
    const chip = [...recipients.querySelectorAll('.ref-agent')].find(c => (c.textContent ?? '').includes(name))
    assert.ok(chip, `${name} is named`)
    assert.equal(chip.nextElementSibling, vias[i], `${name} is followed at once by its own suffix`)
    assert.match(vias[i]!.textContent ?? '', /^as\s*@org:fixture$/, `${name} reads "as @org:fixture"`)
    assert.ok(vias[i]!.querySelector('[data-hub-address="@org:fixture"]'), `${name}'s org is the shared org link`)
  })
  assert.match(recipients.textContent ?? '', /→.*coordinator-opus.*as @org:fixture.*liaison-opus.*as @org:fixture.*old-reviewer.*as @org:fixture.*gone-agent.*as @org:fixture/s)
})

test('§5 the suffix is the Sent tab markup itself, and nothing else gains one', async t => {
  const rec = await open(t, [received(['coordinator-opus']), sent], 'in-1')
  const out = await open(t, [received(['coordinator-opus']), sent], 'out-1')
  const got = rec.el.querySelector('.mailer-head .org-mail-recipient .org-mail-via')
  const want = out.el.querySelector('.mailer-head .org-mail-attribution > .org-mail-via')
  assert.ok(got && want, 'both tabs draw the suffix')
  assert.equal(got.outerHTML, want.outerHTML, 'the same element, the same shared org link, byte for byte')
  assert.equal(out.el.querySelectorAll('.mailer-head .org-mail-via').length, 1, 'the Sent tab keeps its one suffix')
  assert.equal(rec.el.querySelectorAll('.mailrow .org-mail-via').length, 0, 'a list row names only the sender')
  const none = await open(t, [received()], 'in-1')
  assert.equal(none.el.querySelector('.mailer-head .org-mail-via'), null, 'no delivery record, no suffix')
})
