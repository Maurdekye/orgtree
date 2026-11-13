// people.test.tsx: several people on one organization, in the window
// (docs/rust-engine/remote-org.md, "Several people on one organization").
// An action by someone else carries their name; one's own looks as it always
// did, and so does a record that names no computer.
//
// Run:  node tests/run.mjs people
import { flush, inAct, mountView, StrictMode } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AskCard } from '../src/canvas/asks'
import { Msg } from '../src/canvas/desk'
import { OrgRecord } from '../src/canvas/mail'
import { EventCard } from '../src/events/card'
import { MailMessage, isSegments } from '../src/events/segments'
import { HistoryController } from '../src/historycontroller'
import type { HistoryAnswer, UserHistory } from '../src/historyapi'
import { HistorySurface } from '../src/historyui'
import { otherPerson, ownOrigin, useOwnOrigin } from '../src/people'
import { RemoteChip } from '../src/shell/remotes'
import { setDisplayZone } from '../src/timefmt'
import type { AskInfo, OrgEvent } from '../src/types'
import { remoteFeed, remoteView } from './remotefeed.fixture'
declare const __SRC_DIR__: string

const SAM = { id: 'c-sam', name: 'Sam', on: 'Orgtree desktop (PC2)' }
const hired = JSON.parse(readFileSync(path.resolve(__SRC_DIR__, '../tests/fixtures/events/lifecycle.hired.json'), 'utf8')) as { private: Record<string, unknown>; body: string }
/** "Agent hired" by the user, as a transcript row carries it; `via` is the computer it came through. */
const hire = (via?: unknown) => ({ ev: { ...hired.private, actor: { kind: 'user', id: '@user' } }, body: hired.body, from: '@user', ...(via ? { via } : {}) })
const actor = (el: Element) => el.querySelector('.event-actor')!

/** The window keeps its own connection current, as App does. */
function Here() { useOwnOrigin(); return null }

/** A window of a local organization: its app feed is open and names no connection of its own.
 *  (The feed's state is one per document, so a test that needs a local window says so.) */
async function localWindow(t: TestContext) {
  const feed = remoteFeed(t, () => new Response('{}'))
  const view = await mountView(<Here />, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([])
  assert.equal(ownOrigin(), 'local')
}

test('whose a record is: someone else by name, one\'s own and an unnamed one as before', () => {
  assert.deepEqual(otherPerson(SAM, 'local'), { name: 'Sam', title: 'Sam, on Orgtree desktop (PC2)' })
  assert.equal(otherPerson(SAM, 'c-sam'), null, 'one\'s own action')
  assert.equal(otherPerson(undefined, 'local'), null, 'a record from before, or one the engine could not tell')
  assert.equal(otherPerson(null, 'local'), null)
  assert.deepEqual(otherPerson({ id: 'local', name: 'PC1' }, 'c-sam'), { name: 'PC1', title: 'PC1' }, 'the host\'s own desktop, seen from another computer')
  assert.deepEqual(otherPerson({ id: 'c-x', name: 'Orgtree desktop (PC9)', on: 'Orgtree desktop (PC9)' }, 'local'),
    { name: 'Orgtree desktop (PC9)', title: 'Orgtree desktop (PC9)' }, 'a computer name is not said twice')
  for (const broken of ['Sam', 7, {}, { id: 'c-sam' }, { id: 'c-sam', name: '' }, { id: 3, name: 'Sam' }]) {
    assert.equal(otherPerson(broken, 'local'), null, JSON.stringify(broken))
  }
  assert.equal(ownOrigin(), 'local', 'a window of a local organization')
})

test('a transcript header says "User · Sam" for someone else and "User" for one\'s own', async (t) => {
  await localWindow(t)
  const view = await mountView(<div>
    <div id="theirs"><EventCard part="header" org="org" profile="operator" row={hire(SAM)} /></div>
    <div id="mine"><EventCard part="header" org="org" profile="operator" row={hire({ id: 'local', name: 'PC1' })} /></div>
    <div id="old"><EventCard part="header" org="org" profile="operator" row={hire()} /></div>
  </div>, (el) => el)
  t.after(() => view.unmount())
  const theirs = actor(view.el.querySelector('#theirs')!)
  assert.equal(theirs.textContent, 'User · Sam')
  const name = theirs.querySelector('[data-streamer-field="external"]')!
  assert.equal(name.textContent, 'Sam', 'the name is an outside name to Streamer mode')
  assert.equal(name.getAttribute('title'), 'Sam, on Orgtree desktop (PC2)', 'the tooltip sits on the masked element')
  assert.equal(actor(view.el.querySelector('#mine')!).textContent, 'User')
  assert.equal(actor(view.el.querySelector('#old')!).textContent, 'User')
})

test('in a window of a remote organization, one\'s own is the client this desktop is there', async (t) => {
  const feed = remoteFeed(t, () => new Response('{}'))
  const view = await mountView(<div><Here />
    <div id="mine"><EventCard part="header" org="org" profile="operator" row={hire({ id: 'c-me', name: 'Me' })} /></div>
    <div id="host"><EventCard part="header" org="org" profile="operator" row={hire({ id: 'local', name: 'HOST-PC' })} /></div>
  </div>, (el) => el)
  t.after(() => view.unmount())
  const here = remoteView({ me: { id: 'c-me', name: 'Me' } })
  await feed.remotes([here], here)
  assert.equal(ownOrigin(), 'c-me')
  assert.equal(actor(view.el.querySelector('#mine')!).textContent, 'User')
  assert.equal(actor(view.el.querySelector('#host')!).textContent, 'User · HOST-PC', 'the host\'s own desktop is someone else here')
  // an engine that has not said who this desktop is: nothing is known to be one's own
  const unknown = remoteView({ me: null })
  await feed.remotes([unknown], unknown)
  assert.equal(ownOrigin(), null)
  assert.equal(actor(view.el.querySelector('#mine')!).textContent, 'User · Me')
})

test('a plain mail row and the organization record carry the name too', async (t) => {
  const row = (via?: unknown) => ({ id: 'm1', from: '@user', kind: 'message', body: 'hello', at: '2026-11-13T14:02:00Z', ...(via ? { via } : {}) })
  await localWindow(t)
  const events: OrgEvent[] = [
    { at: '2026-11-13T14:00:00Z', op: 'settings', actor: '@user', detail: {} },
    { at: '2026-11-13T14:01:00Z', op: 'hire', actor: '@user', detail: { node: 'scout' }, via: SAM },
    { at: '2026-11-13T14:02:00Z', op: 'status', actor: 'lead', detail: {} },
  ]
  const view = await mountView(<div>
    <div id="theirs"><MailMessage row={row(SAM)} profile="operator" slug="org" nid="lead" /></div>
    <div id="mine"><MailMessage row={row()} profile="operator" slug="org" nid="lead" /></div>
    <div id="record"><OrgRecord events={events} /></div>
  </div>, (el) => el)
  t.after(() => view.unmount())
  assert.equal(actor(view.el.querySelector('#theirs')!).textContent, 'User · Sam')
  assert.equal(actor(view.el.querySelector('#mine')!).textContent, 'User')
  // newest first: the agent, Sam's hire, one's own settings change
  assert.deepEqual([...view.el.querySelectorAll('#record .rec-actor')].map((el) => el.textContent), ['lead', 'User · Sam', 'you'])
})

test('a delivered message that names a person is still drawn as its card', async (t) => {
  // The desk draws a delivery from its typed rows only when every row is one it knows; otherwise the whole
  // delivery falls back to its plain text, headers and names gone (events/wire.ts).
  const delivery = (via?: unknown) => [{ kind: 'mail', rows: [{ id: 'm1', from: '@user', kind: 'message', body: 'hello from the other computer',
    at: '2026-11-13T14:02:00Z', ...(via === undefined ? {} : { via }) }] }]
  const text = 'FROM @user\nhello from the other computer'
  assert.ok(isSegments(delivery(), 'operator'), 'a row that names no computer')
  assert.ok(isSegments(delivery(SAM), 'operator'), 'who the mail came through is part of the row')
  assert.ok(isSegments(delivery({ id: 'local', name: 'PC1' }), 'operator'), 'the same for the own record of this computer')
  assert.ok(isSegments(delivery('turn'), 'operator'), 'the delivery word an older engine wrote there')
  for (const broken of [7, true, ['Sam']]) assert.equal(isSegments(delivery(broken), 'operator'), false, JSON.stringify(broken))
  await localWindow(t)
  const view = await mountView(<div>
    <div id="theirs"><Msg slug="org" nid="lead" m={{ role: 'user', text, segments: delivery(SAM) }} /></div>
    <div id="mine"><Msg slug="org" nid="lead" m={{ role: 'user', text, segments: delivery({ id: 'local', name: 'PC1' }) }} /></div>
  </div>, (el) => el)
  t.after(() => view.unmount())
  for (const id of ['theirs', 'mine']) assert.ok(view.el.querySelector(`#${id} .turn-mail`), `${id}: the delivery is a card, not its plain text`)
  assert.equal(actor(view.el.querySelector('#theirs')!).textContent, 'User · Sam')
  assert.equal(actor(view.el.querySelector('#mine')!).textContent, 'User')
})

test('a request someone else settled says who and when', async (t) => {
  setDisplayZone('UTC')
  t.after(() => setDisplayZone(null))
  await localWindow(t)
  const ask = (extra: Partial<AskInfo>): AskInfo => ({ id: 'q-people-' + Object.keys(extra).length, node: 'lead', at: '2026-11-13T14:00:00Z',
    resolved_at: '2026-11-13T14:02:00Z', status: 'answered', kind: 'question', rev: 1, question: 'Which colour?', header: 'Colour',
    options: [{ label: 'Blue' }, { label: 'Green' }], questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Blue' }, { label: 'Green' }] }], ...extra })
  const view = await mountView(<StrictMode><div>
    <div id="theirs"><AskCard ask={ask({ answered_via: SAM })} slug="org" toast={() => {}} /></div>
    <div id="mine"><AskCard ask={ask({ answered_via: { id: 'local', name: 'PC1' }, reason: '' })} slug="org" toast={() => {}} /></div>
    <div id="old"><AskCard ask={ask({})} slug="org" toast={() => {}} /></div>
  </div></StrictMode>, (el) => el)
  t.after(() => view.unmount())
  const tag = (id: string) => view.el.querySelector(`#${id} .ask-null-tag`)!
  assert.equal(tag('theirs').textContent, 'answered by Sam at 14:02')
  assert.equal(tag('theirs').querySelector('[data-streamer-field="external"]')!.textContent, 'Sam')
  assert.equal(tag('mine').textContent, 'answered')
  assert.equal(tag('old').textContent, 'answered')
})

test('undoing someone else\'s action asks first, by name; one\'s own does not', async (t) => {
  const entry = (id: number, via?: unknown) => ({ id, kind: 'retool' as const, label: `Settings: agent ${id}`, at: '2026-11-13T14:00:00Z', state: 'done' as const, ...(via ? { via } : {}) })
  const history = (undo: number | null, redo: number | null = null): UserHistory => ({ bound: 100,
    undo: undo == null ? null : { id: undo, kind: 'retool', label: `Settings: agent ${undo}`, at: '2026-11-13T14:00:00Z' },
    redo: redo == null ? null : { id: redo, kind: 'retool', label: `Settings: agent ${redo}`, at: '2026-11-13T14:00:00Z' },
    entries: [entry(5, SAM), entry(4, { id: 'local', name: 'PC1' }), entry(3)] })
  const calls: [string, number][] = []
  let now = history(5)
  const controller = new HistoryController({ read: async () => now, report: () => {}, changed: () => {}, own: () => 'local',
    apply: async (direction, id): Promise<HistoryAnswer> => {
      calls.push([direction, id])
      now = direction === 'undo' ? history(id - 1, id) : history(id)
      return { status: direction === 'undo' ? 'undone' : 'redone', id, label: `Settings: agent ${id}`, history: now }
    } })
  const view = await mountView(<HistorySurface controller={controller} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(() => controller.refresh())
  await inAct(() => controller.run('undo'))
  assert.deepEqual(calls, [], 'nothing is undone before the answer')
  assert.deepEqual(controller.getSnapshot().other, { direction: 'undo', id: 5, label: 'Settings: agent 5', name: 'Sam' })
  assert.equal(controller.can('undo'), false, 'a second shortcut waits for the answer')
  const dialog = () => view.el.ownerDocument.querySelector('[role="dialog"], .modal')
  assert.match(dialog()?.textContent ?? '', /This was Sam's change\. Undo it\?/)
  // Cancel undoes nothing
  await inAct(() => controller.cancelOther())
  assert.deepEqual(calls, [])
  assert.equal(controller.getSnapshot().other, null)
  // Undo: now it is done
  await inAct(() => controller.run('undo'))
  await inAct(() => controller.confirmOther())
  assert.deepEqual(calls, [['undo', 5]])
  // the next entry is one's own, and the one after names nobody: no question
  await inAct(() => controller.run('undo'))
  await inAct(() => controller.run('undo'))
  assert.deepEqual(calls, [['undo', 5], ['undo', 4], ['undo', 3]])
  assert.equal(controller.getSnapshot().other, null)
  // redoing someone else's action is asked about the same way
  now = history(4, 5)
  await inAct(() => controller.refresh())
  await inAct(() => controller.run('redo'))
  assert.deepEqual(controller.getSnapshot().other, { direction: 'redo', id: 5, label: 'Settings: agent 5', name: 'Sam' })
  assert.match(dialog()?.textContent ?? '', /This was Sam's change\. Redo it\?/)
  await inAct(() => controller.confirmOther())
  assert.deepEqual(calls.at(-1), ['redo', 5])
})

test('Connection details: the name shown to others, and who else is connected', async (t) => {
  setDisplayZone('UTC')
  t.after(() => setDisplayZone(null))
  const sent: { url: string; method: string; body: unknown }[] = []
  let shown = 'TEST-PC'
  const people = { supported: true, people: [
    { id: 'c-me', label: 'TEST-PC', name: 'Orgtree desktop (TEST-PC)', connected: true, since: '2026-11-13T13:00:00Z', last_seen_at: null, scope: 'full', you: true },
    { id: 'c-dana', label: 'Dana', name: 'Orgtree desktop (PC-DANA)', connected: true, since: '2026-11-13T13:30:00Z', last_seen_at: null, scope: 'full', you: false },
    { id: 'c-gone', label: 'Old laptop', name: 'Old laptop', connected: false, since: null, last_seen_at: '2026-11-12T09:00:00Z', scope: 'full', you: false }] }
  const feed = remoteFeed(t, (url, init) => {
    const method = init?.method ?? 'GET'
    sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url === '/api/remotes' && method === 'GET') return new Response(JSON.stringify({ remotes: [], me: { id: 'local', name: shown } }))
    if (url === '/api/remotes/shown-as') { shown = (sent.at(-1)!.body as { label: string | null }).label ?? 'TEST-PC'; return new Response(JSON.stringify({ shown_as: shown, me: { id: 'local', name: shown } })) }
    if (url === '/api/remotes/r1/people') return new Response(JSON.stringify(people))
    return new Response('{}')
  })
  const view = await mountView(<span><RemoteChip slug="org" /></span>, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([remoteView({ me: { id: 'c-me', name: 'TEST-PC' } })])
  const doc = view.el.ownerDocument
  await inAct(async () => { (view.el.querySelector('.remote-chip') as HTMLElement).click(); await flush(8) })
  const row = (label: string) => [...doc.querySelectorAll('.remote-details .set-row')].find((r) => r.querySelector('.set-label')!.textContent!.trim() === label)!
  const input = row('Shown to others as').querySelector('input') as HTMLInputElement
  assert.equal(input.value, 'TEST-PC')
  assert.equal(input.getAttribute('data-streamer-field'), 'external')
  const others = [...row('Also connected').querySelectorAll('.remote-people li')].map((li) => li.textContent)
  assert.deepEqual(others, ['Dana · Orgtree desktop (PC-DANA) · since ' + new Date('2026-11-13T13:30:00Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })],
    'the others who are connected now: not this desktop, not a computer that is away')
  // a new name is saved when the field is left
  const setter = Object.getOwnPropertyDescriptor(doc.defaultView!.HTMLInputElement.prototype, 'value')!.set!
  await inAct(async () => { setter.call(input, 'Sam'); input.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true })); await flush(2) })
  await inAct(async () => { input.dispatchEvent(new doc.defaultView!.FocusEvent('focusout', { bubbles: true })); await flush(8) })
  assert.deepEqual(sent.filter((c) => c.method === 'PUT'), [{ url: '/api/remotes/shown-as', method: 'PUT', body: { label: 'Sam' } }])
  assert.equal((row('Shown to others as').querySelector('input') as HTMLInputElement).value, 'Sam')
  // until that engine has taken the name, the row says what the others still see there
  assert.match(row('Shown to others as').textContent ?? '', /On Galaxy they see TEST-PC\./)
})

test('Connection details: an engine that does not say who is connected', async (t) => {
  const feed = remoteFeed(t, (url) => new Response(url === '/api/remotes/r1/people' ? JSON.stringify({ supported: false, people: [] }) : '{}'))
  const view = await mountView(<span><RemoteChip slug="org" /></span>, (el) => el)
  t.after(() => view.unmount())
  await feed.remotes([remoteView()])
  const doc = view.el.ownerDocument
  await inAct(async () => { (view.el.querySelector('.remote-chip') as HTMLElement).click(); await flush(8) })
  const row = (label: string) => [...doc.querySelectorAll('.remote-details .set-row')].find((r) => r.querySelector('.set-label')!.textContent!.trim() === label)!
  assert.equal(row('Also connected').querySelector('.set-control')!.textContent, 'That engine does not say who is connected.')
})
