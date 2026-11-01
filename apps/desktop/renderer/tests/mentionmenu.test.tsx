// mentionmenu.test.tsx — THE @ MENU OFFERS EVERY KIND, NEWEST FIRST (USER 2026-10-27):
//   m042c82fb0228 "and i should be able to mention apps, panels, and presentations from my @ mention menu";
//   mdb3b4aef1062 "if i write @doc: then it should list all presentations, if i write @item: it should list
//     all tickets, and if i write @agent: it should list all agents", and m35d9b7cf74f6 "Yes, all kinds";
//   m79e889ce1609 "and ofc sort all items by most recently mentioned / operated on / presented".
// Tickets, presentations, apps and panels come from the engine's one bounded read (mention-candidates), which
// pages; agents and projects from the window's tree, by their latest turn, status or mention in mail.
//   §1 apps and panels are offered by name with their marks; completing one inserts @app:/@panel: slugs
//   §2 one order for every kind: the latest mention, use or presenting first, then by name
//   §3 a kind prefix lists only that kind, all of it; text after the colon (or a long form's org) filters
//   §4 "all" is read a page at a time as the list is read, never in one read
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs mentionmenu
import { FakeServer, flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useRef, useState } from 'react'
import { setKnownOrgs, useAgentMentions } from '../src/canvas/agentmentions'
import type { MentionCandidate } from '../src/canvas/agentmentions'
import { resetMentionSearchForTests } from '../src/canvas/mentionsearch'
import { resetNetMentions, setNetRoster } from '../src/canvas/netmentions'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The engine's read through the shared fake; every request is kept. */
function engine(t: TestContext, setup: (s: FakeServer) => void, nodes: { name: string; at: string }[] = [],
  outside: { kind: 'net' | 'org'; key: string; at: string }[] = [], recent: Record<string, string> = {}) {
  resetMentionSearchForTests()
  const server = new FakeServer()
  setup(server)
  const asked: URLSearchParams[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw), 'http://local')
    if (url.pathname.endsWith('/net/recent')) return json({ recent })
    if (!url.pathname.endsWith('/mention-candidates')) return json({})
    asked.push(url.searchParams)
    const page = server.mentionCandidates(url) as { nodes?: unknown }
    return json(page.nodes ? { ...page, nodes, outside } : page)
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original; resetMentionSearchForTests() })
  return { server, asked }
}

function Composer({ org, candidates }: { org: string; candidates: MentionCandidate[] }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement | null>(null)
  const mentions = useAgentMentions({ value: text, onChange: setText, inputRef: box, candidates, org })
  return <div><textarea className="fake-composer" ref={box} value={text} onChange={e => setText(e.target.value)}
    onKeyDown={e => { mentions.onKeyDown(e) }} />{mentions.menu}</div>
}
async function mount(t: TestContext, org: string, candidates: MentionCandidate[] = []) {
  const view = await mountView(<Composer org={org} candidates={candidates} />, el => el)
  t.after(() => view.unmount())
  return view.el.querySelector<HTMLTextAreaElement>('.fake-composer')!
}
async function typeInto(box: HTMLTextAreaElement, value: string) {
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
    box.dispatchEvent(new window.Event('input', { bubbles: true }))
    box.focus()
    box.setSelectionRange(value.length, value.length)
    box.dispatchEvent(new window.Event('select', { bubbles: true }))
    await flush(6)
  })
  for (let i = 0; i < 4; i++) await inAct(async () => { await flush(4) })
}
async function press(box: Element, key: string) {
  await inAct(async () => {
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await flush(4)
  })
}
const rows = () => [...document.querySelectorAll<HTMLElement>('.agent-mentions .agent-mention-item')]
/** best first (the list is drawn bottom-up, the best next to the box) */
const ranked = () => rows().reverse().map(r => r.querySelector('.agent-mention-name')?.textContent ?? '')
const kindOf = (r: HTMLElement) => ['ticket', 'presentation', 'app', 'panel'].find(k => r.classList.contains(`mention-${k}`)) ?? 'agent'

const agent = (id: string, at?: string): MentionCandidate => ({ id, tier: 'sol', kind: 'agent', ...(at ? { at: Date.parse(at) } : {}) })
const project = (id: string): MentionCandidate => ({ id, tier: 'project', kind: 'project' })
const ticket = (slug: string, title: string, at: string) => ({ slug, title, status: 'open', archived: false, docket_at: at, updated_at: at })
const doc = (id: string, title: string, at: string, dismissed = false) => ({ id, title, at, format: 'markdown', dismissed })

test('§1 apps and panels are offered by name with their marks; completing one inserts its @app:/@panel: slug', async t => {
  engine(t, s => {
    s.apps = [{ id: 'caption-board', name: 'Caption board', at: '2026-10-27T10:00:00Z' }]
    s.panels = [{ id: 'caption-board-panel-1', app: 'caption-board', label: 'Panel 1', at: '2026-10-27T11:00:00Z' }]
  })
  const box = await mount(t, 'acme')
  await typeInto(box, 'open @capt')
  const offered = rows().reverse().map(r => ({ kind: kindOf(r), name: r.querySelector('.agent-mention-name')?.textContent,
    mark: !!r.querySelector(`.mention-${kindOf(r)}-mark svg`), label: r.getAttribute('aria-label'), title: r.getAttribute('title') }))
  assert.deepEqual(offered, [
    { kind: 'panel', name: 'Caption board · Panel 1', mark: true, label: 'panel Caption board · Panel 1', title: '@panel:acme/caption-board-panel-1' },
    { kind: 'app', name: 'Caption board', mark: true, label: 'app Caption board', title: '@app:acme/caption-board' },
  ], 'the panel used at 11:00 before the app changed at 10:00')
  await press(box, 'Tab')
  assert.equal(box.value, 'open @panel:acme/caption-board-panel-1 ')
  // a slug's words find it too; the arrow walks from the best to the next
  await typeInto(box, 'and @caption-bo')
  assert.deepEqual(ranked(), ['Caption board · Panel 1', 'Caption board'])
  await press(box, 'ArrowUp')
  await press(box, 'Enter')
  assert.equal(box.value, 'and @app:acme/caption-board ')
})

test('§2 one order for every kind: the latest mention, use or presenting first, then by name', async t => {
  engine(t, s => {
    s.workItems = [ticket('fix-login', 'Fix the login page', '2026-10-27T10:05:00Z')]
    s.documents = [doc('weekly-status', 'Weekly status', '2026-10-27T10:00:00Z'), doc('draft', 'Draft', '2026-10-27T12:00:00Z', true)]
    s.apps = [{ id: 'notes', name: 'Notes', at: '2026-10-27T10:10:00Z' }]
  }, [{ name: 'writer', at: '2026-10-27T10:07:00Z' }])
  // boss worked at 10:20; writer last worked at 09:00 but was mentioned in mail at 10:07; the project has no time
  const box = await mount(t, 'acme', [agent('boss', '2026-10-27T10:20:00Z'), agent('writer', '2026-10-27T09:00:00Z'), project('launch')])
  await typeInto(box, '@')
  assert.deepEqual(ranked(), ['@boss', 'Notes', '@writer', 'Fix the login page', 'Weekly status', '@launch'],
    'boss worked 10:20, the Notes app changed 10:10, writer was mentioned 10:07, the ticket changed 10:05, the presentation 10:00; '
    + 'the project with no known time last; the dismissed Draft is never offered')
})

test('§3 a kind prefix lists only that kind, all of it; text after the colon filters, and picking inserts the normal mention', async t => {
  const { asked } = engine(t, s => {
    s.workItems = [ticket('fix-login', 'Fix the login page', '2026-10-27T10:05:00Z')]
    s.workBacklogged = [ticket('weekly-plan', 'Weekly plan', '2026-10-27T09:00:00Z')]
    s.documents = [doc('weekly-status', 'Weekly status', '2026-10-27T10:00:00Z'), doc('launch-deck', 'Launch deck', '2026-10-27T08:00:00Z')]
    s.apps = [{ id: 'notes', name: 'Notes', at: '2026-10-27T10:10:00Z' }]
    s.panels = [{ id: 'notes-panel-1', app: 'notes', label: 'Panel 1', at: '2026-10-27T10:11:00Z' }]
  })
  const box = await mount(t, 'acme', [agent('boss', '2026-10-27T10:20:00Z'), agent('weekly-bot'), project('launch')])
  const kinds = () => [...new Set(rows().map(kindOf))]
  await typeInto(box, 'see @doc:')
  assert.deepEqual([kinds(), ranked()], [['presentation'], ['Weekly status', 'Launch deck']], '@doc: lists every presentation, newest first')
  assert.equal(asked.at(-1)?.get('kinds'), 'doc', 'the engine is asked for that kind only')
  await typeInto(box, 'see @doc:launch')
  assert.deepEqual(ranked(), ['Launch deck'], 'text after the colon filters')
  await typeInto(box, 'see @doc:acme/week')
  assert.deepEqual(ranked(), ['Weekly status'], 'a long form being typed filters by what follows its org')
  await press(box, 'Tab')
  assert.equal(box.value, 'see @doc:acme/weekly-status ', 'picking inserts the normal mention')
  await typeInto(box, 'see @item:')
  assert.deepEqual([kinds(), ranked()], [['ticket'], ['Fix the login page', 'Weekly plan']], 'tickets by their full titles')
  await typeInto(box, 'see @app:')
  assert.deepEqual([kinds(), ranked()], [['app'], ['Notes']])
  await typeInto(box, 'see @panel:')
  assert.deepEqual([kinds(), ranked()], [['panel'], ['Notes · Panel 1']])
  await typeInto(box, 'see @agent:')
  assert.deepEqual(ranked(), ['@boss', '@weekly-bot'], '@agent: lists agents only, never projects')
  await typeInto(box, 'see @agent:week')
  assert.deepEqual(ranked(), ['@weekly-bot'])
  await press(box, 'Tab')
  assert.equal(box.value, 'see @weekly-bot ', 'an agent is completed as the plain @name')
  await typeInto(box, 'see @project:')
  assert.deepEqual(ranked(), ['@launch'], '@project: lists projects only')
  await typeInto(box, 'see @zzz:')
  assert.equal(document.querySelector('.agent-mentions'), null, 'another @word: form opens no list')
})

test('§5 outside addresses are mentionable: @ lists them with the other kinds, @net: / @org: list only that kind, and picking inserts the address', async t => {
  engine(t, () => {})
  setKnownOrgs(['local-org'])
  setNetRoster('acme', { slug: 'home.000001', picture_revision: null, hubs: [{ id: 'local', address: 'http://127.0.0.1:7370', enabled: true,
    connected: true, queued: 0, roster: [
      { slug: 'alice.77ded7', username: 'Alice', online: true, kind: 'person' },
      { slug: 'acme.12ab34', org_name: 'Acme Labs', online: false, kind: 'org' },
    ] }] } as never)
  t.after(() => { resetNetMentions(); setKnownOrgs([]) })
  const box = await mount(t, 'acme', [agent('boss', '2026-10-27T10:20:00Z')])
  const kindsShown = () => rows().map(r => r.getAttribute('title')?.slice(0, 4) ?? 'agent')
  await typeInto(box, '@')
  assert.equal(ranked()[0], '@boss')
  assert.equal(rows().filter(r => r.classList.contains('mention-net')).length, 2, '@ mixes the @net: contacts in with the other kinds')
  assert.equal(rows().filter(r => r.classList.contains('mention-org')).length, 1, 'and the local org')
  await typeInto(box, 'see @net:')
  assert.deepEqual(new Set(kindsShown()), new Set(['@net']), '@net: lists only @net: addresses')
  assert.equal(rows().length, 2)
  await typeInto(box, 'see @net:ali')
  assert.deepEqual(ranked(), ['Alice (@net:alice.77ded7)'], 'further characters filter by name and address')
  await typeInto(box, 'see @net:labs')
  assert.deepEqual(ranked(), ['Acme Labs (@net:acme.12ab34)'], 'the display name matches too')
  await press(box, 'Tab')
  assert.equal(box.value, 'see @net:acme.12ab34 ', 'picking inserts the canonical address')
  await typeInto(box, 'see @org:')
  assert.deepEqual(ranked(), ['@org:local-org'], '@org: lists only orgs')
  await press(box, 'Tab')
  assert.equal(box.value, 'see @org:local-org ')
})

test('§4 "all" is read a page at a time as the list is read: the end of what is drawn asks for the next page', async t => {
  const { asked } = engine(t, s => {
    s.documents = Array.from({ length: 45 }, (_, i) => doc(`deck-${String(i).padStart(2, '0')}`, `Deck ${String(i).padStart(2, '0')}`,
      new Date(Date.parse('2026-10-27T10:00:00Z') - i * 60_000).toISOString()))
  })
  // the reader reaching the end of the list: the marker drawn there is seen at once
  const Saved = (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
  class Seen { constructor(private fire: (e: { isIntersecting: boolean }[]) => void) {}
    observe() { queueMicrotask(() => this.fire([{ isIntersecting: true }])) }
    disconnect() {} }
  ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Seen
  t.after(() => { (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Saved })
  const box = await mount(t, 'acme')
  await typeInto(box, '@doc:')
  for (let i = 0; i < 6; i++) await inAct(async () => { await flush(6) })
  assert.equal(rows().length, 45, 'every presentation, read as the list was read')
  assert.deepEqual(asked.map(q => q.get('after') ?? ''), ['', '20', '40'], 'three bounded reads of 20, each after the last')
  assert.equal(ranked()[0], 'Deck 00')
  assert.equal(ranked()[44], 'Deck 44')
  assert.equal(document.querySelector('.agent-mention-more'), null, 'nothing more to read: no marker')
})

test('§6 outside addresses rank by recency: the latest of mail sent/received and mention in mail, among the other kinds', async t => {
  engine(t, () => {}, [], [{ kind: 'net', key: 'acme.12ab34', at: '2026-10-27T11:00:00Z' }, { kind: 'org', key: 'local-org', at: '2026-10-27T10:30:00Z' }],
    { 'alice.77ded7': '2026-10-27T10:25:00Z', 'acme.12ab34': '2026-10-27T09:00:00Z' })
  setKnownOrgs(['local-org'])
  setNetRoster('acme', { slug: 'home.000001', picture_revision: null, hubs: [{ id: 'local', address: 'http://127.0.0.1:7370', enabled: true,
    connected: true, queued: 0, roster: [
      { slug: 'alice.77ded7', username: 'Alice', online: true, kind: 'person' },
      { slug: 'acme.12ab34', org_name: 'Acme Labs', online: false, kind: 'org' },
    ] }] } as never)
  t.after(() => { resetNetMentions(); setKnownOrgs([]) })
  const box = await mount(t, 'acme', [agent('boss', '2026-10-27T10:20:00Z')])
  await typeInto(box, '@')
  assert.deepEqual(ranked(), ['Acme Labs (@net:acme.12ab34)', '@org:local-org', 'Alice (@net:alice.77ded7)', '@boss'],
    'acme mentioned 11:00 (later than its 09:00 mail), the org mentioned 10:30, alice mailed 10:25, boss worked 10:20')
  await typeInto(box, 'see @net:')
  assert.deepEqual(ranked(), ['Acme Labs (@net:acme.12ab34)', 'Alice (@net:alice.77ded7)'], '@net: keeps the same order')
})
