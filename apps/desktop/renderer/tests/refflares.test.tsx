// tests/refflares.test.tsx — ticket and presentation links show their full title and a state flare
// (@item:orgtree/4-5-0-ticket-and-presentation-chips-show-full-ti). USER 2026-10-27: m43beb8089dd4 "add a flare with
// the ticket's status as a color, similar to ticket links"; m3eb804e5023a "also make these links use the full name"
// (an orgtree_work ticket chip in a tool-call row showed the slug); m919f12828686 "unread or modified presentation
// links should be highlighted in a similar manner as well"; mc1c4ab23c4bf "also presentation cards should be
// highlighted if unread or modified".
//   §1-§2 a ticket mention wears a flare in its docket status colour, named in its tooltip, in React and Markdown
//         prose, and follows a docket write;
//   §3    a tool-call ticket chip shows the ticket's full title and keeps its status flare;
//   §4    a bare ticket name in docket prose wears the flare, named with the title in its tooltip;
//   §5    the idle-docket reminder card's link shows the recorded title;
//   §6-§7 a presentation mention flares unread or modified since it was read, never once read; opening it clears
//         the flare without another read;
//   §8    presentation cards (a tool row's card, a desk badge) highlight unread and modified from the current state;
//   §9    the Presented list tells unread from modified; §10 a presentation's hover names its state.
// Each test uses its own org slug: answers and read marks are kept per org.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useMemo } from 'react'
import { RefProse, useRefRoutes } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { WorkRefText, buildMentionIndex } from '../src/canvas/workrefs'
import { docketFeed } from '../src/canvas/itemrefs'
import { md } from '../src/canvas/shared'
import { ToolChip } from '../src/canvas/desk'
import { PresentationCard } from '../src/canvas/docs'
import { DocGalleryModal } from '../src/canvas/gallery'
import { IdleDocketCards } from '../src/events/idledocket'
import { markDocViewed } from '../src/canvas/docviewed'
import { objectTooltipProps, registerObjectNativeTooltipDocument } from '../src/canvas/objecttooltip'

const tick = async () => { for (let i = 0; i < 8; i++) await flush() }
const noop = () => {}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Ticket = { slug: string; title: string; status: string }
type Doc = { id: string; title: string; at: string; viewed_at: string | null }
const AT = '2026-10-27T10:00:00.000Z', EARLIER = '2026-10-27T09:00:00.000Z'
const TICKETS: Ticket[] = [
  { slug: 'build-docs', title: 'Build the docs site from main', status: 'in_progress' },
  { slug: 'fix-login', title: 'Fix the login redirect', status: 'blocked' },
  { slug: 'ship-it', title: 'Ship the release', status: 'done' },
]
/** never opened; replaced since it was opened; opened at its current version */
const DOCS: Doc[] = [
  { id: 'launch-plan', title: 'Launch plan', at: AT, viewed_at: null },
  { id: 'release-notes', title: 'Release notes', at: AT, viewed_at: EARLIER },
  { id: 'old-notes', title: 'Old notes', at: EARLIER, viewed_at: EARLIER },
]

/** The engine as these surfaces read it: the bounded ticket and presentation reads of the exact references on
 *  screen (the presentation answer with the times a chip tells unread from modified with), one presentation, the
 *  gallery list and the viewed marks. */
function engine(t: TestContext, tickets: Ticket[] = TICKETS.map(x => ({ ...x })), docs: Doc[] = DOCS.map(x => ({ ...x }))) {
  const s = { tickets, docs, ticketReads: [] as string[][], docReads: [] as string[][] }
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw), 'http://local'), path = url.pathname
    if (/\/work-item-references$/.test(path)) {
      const names = (url.searchParams.get('names') ?? '').split(',').filter(Boolean)
      s.ticketReads.push(names)
      return json({ references: s.tickets.filter(x => names.includes(x.slug)).map(x => ({ ...x, parent: null, archived: false, rev: 1 })) })
    }
    if (/\/work-items\/[^/]+$/.test(path)) {
      const item = s.tickets.find(x => path.endsWith('/' + x.slug))
      return item ? json({ item }) : json({ detail: 'no such item' }, 404)
    }
    if (/\/documents\/viewed$/.test(path)) return json({ ok: true })
    const one = path.match(/\/documents\/([^/]+)$/)
    if (one) {
      const d = s.docs.find(x => x.id === decodeURIComponent(one[1]!))
      return d ? json({ ...d, node: 'writer', format: 'markdown', body: `body of ${d.id}` }) : json({ detail: 'that document no longer exists' }, 404)
    }
    if (path.endsWith('/documents')) {
      const refs = url.searchParams.get('refs')
      if (refs !== null) {
        const asked = refs.split(',').filter(Boolean)
        s.docReads.push(asked)
        return json({ refs: asked.flatMap(ref => s.docs.filter(d => d.id === ref)
          .map(d => ({ ref, id: d.id, title: d.title, format: 'markdown', at: d.at, viewed_at: d.viewed_at }))) })
      }
      return json({ documents: s.docs.map(d => ({ ...d, node: 'writer', evicted: false, node_state: 'live', tier: 'sol', format: 'markdown' })),
        total: s.docs.length, offset: 0, next_offset: null })
    }
    return json({ ok: true })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return s
}

function Surface({ slug, text, markdown }: { slug: string; text: string; markdown?: boolean }) {
  const agents = useMemo(() => new Map<string, unknown>(), [])
  const refs = useRefRoutes(slug, agents, { onOpenItem: noop, onOpenDoc: noop })
  return markdown ? <RefMdBody className="md" html={md(text)} world={refs.world} onOpen={refs.onOpen} />
    : <p><RefProse text={text} world={refs.world} onOpen={refs.onOpen} /></p>
}
/** what each chip of one kind shows, in document order */
const chipsOf = (el: Element, kind: 'item' | 'doc') => [...el.querySelectorAll<HTMLElement>(`.ref-chip.ref-${kind}.ref-ready`)].map(c => ({
  text: c.textContent, flare: [...c.classList].filter(k => k === 'ref-flare' || k.startsWith('status-') || k.startsWith('doc-')).join(' '),
  title: c.getAttribute('title') }))

test('§1 a ticket mention wears a flare in its status colour, named in its tooltip, in prose and in Markdown', async t => {
  const slug = 'flares-tickets'
  engine(t)
  const text = `See @item:${slug}/build-docs, @item:${slug}/fix-login and @item:${slug}/ship-it; not @item:other/build-docs.`
  const view = await mountView(<><div className="react"><Surface slug={slug} text={text} /></div>
    <div className="markdown"><Surface slug={slug} text={text} markdown /></div></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  for (const where of ['react', 'markdown']) {
    assert.deepEqual(chipsOf(view.el.querySelector(`.${where}`)!, 'item'), [
      { text: 'Build the docs site from main', flare: 'ref-flare status-in_progress', title: 'In progress · Build the docs site from main' },
      { text: 'Fix the login redirect', flare: 'ref-flare status-blocked', title: 'Blocked · Fix the login redirect' },
      { text: 'Ship the release', flare: 'ref-flare status-done', title: 'Done · Ship the release' },
    ], `${where}: the title, the status colour and its name`)
  }
  const foreign = view.el.querySelector<HTMLElement>(`[data-ref-token="@item:other/build-docs"]`)
  assert.ok(foreign && !foreign.classList.contains('ref-flare'), 'another org\'s ticket is never read here, so it has no flare')
})

test('§2 the flare follows a docket write: the titles and statuses on screen are read again', async t => {
  const slug = 'flares-live', s = engine(t)
  const view = await mountView(<><Surface slug={slug} text={`See @item:${slug}/build-docs.`} />
    <Surface slug={slug} markdown text={`See @item:${slug}/build-docs.`} /></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  s.tickets[0]!.status = 'review'
  await inAct(async () => { docketFeed(slug, { type: 'docket_changed' }); await tick() })
  assert.deepEqual(chipsOf(view.el, 'item').map(c => [c.flare, c.title]), [
    ['ref-flare status-review', 'Agent review · Build the docs site from main'],
    ['ref-flare status-review', 'Agent review · Build the docs site from main']])
})

test('§3 a tool-call ticket chip shows the ticket\'s full title and keeps its status flare', async t => {
  const slug = 'flares-tool'
  engine(t)
  const call = { id: 'work-1', name: 'mcp__orgtree__orgtree_work', arg: 'update build-docs', result: '{}',
    refs: [{ kind: 'ticket' as const, id: 'build-docs', status_change: { from: 'open', to: 'in_progress' } }] }
  const view = await mountView(<ToolChip t={call} slug={slug} nid="author" onWorkLink={noop} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const chip = view.el.querySelector<HTMLElement>('.tool-ref .ref-chip.ref-item')!
  assert.equal(chip.textContent, 'Build the docs site from main', 'the title, not the slug build-docs')
  assert.ok(chip.classList.contains('status-in_progress'), 'in its current status colour')
  assert.equal(chip.getAttribute('title'), 'In progress · Build the docs site from main', 'named in its tooltip')
  assert.equal(chip.getAttribute('data-object-id'), 'build-docs', 'the slug stays its identity for the ticket menu')
  assert.equal(view.el.querySelector('.tool-work-transition')?.textContent, 'Open → In progress', 'the recorded change is unchanged')
})

test('§3b the tool-call ticket chip is the inline mention link itself, not a box of its own', async t => {
  const slug = 'flares-tool-same'
  engine(t)
  const call = { id: 'work-2', name: 'mcp__orgtree__orgtree_work', arg: 'update build-docs', result: '{}',
    refs: [{ kind: 'ticket' as const, id: 'build-docs' }] }
  const view = await mountView(<>
    <div className="tool"><ToolChip t={call} slug={slug} nid="author" onWorkLink={noop} /></div>
    <div className="prose"><Surface slug={slug} text={`See @item:${slug}/build-docs.`} /></div>
  </>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const tool = view.el.querySelector<HTMLElement>('.tool .tool-ref button')!, inline = view.el.querySelector<HTMLElement>('.prose .ref-chip.ref-item')!
  assert.deepEqual([tool.tagName, tool.className, tool.innerHTML, tool.getAttribute('title')],
    [inline.tagName, inline.className, inline.innerHTML, inline.getAttribute('title')], 'the same element, classes, mark, name and tooltip')
  assert.equal(tool.classList.contains('desk-nav-chip'), false, 'no boxed chip style')
})

test('§4 a bare ticket name in docket prose wears the status flare, named with the title, in React and Markdown', async t => {
  const slug = 'flares-bare'
  engine(t)
  const index = buildMentionIndex([{ slug: 'build-docs', title: 'Build the docs site from main', status: 'in_progress' }])
  const view = await mountView(<div className="docket-modal">
    <p className="react"><WorkRefText text="blocked behind build-docs until it lands" index={index} onPick={noop} /></p>
    <div className="markdown"><RefMdBody html={md('blocked behind build-docs until it lands')} world={{ org: slug }}
      mentions={{ index, onPick: noop }} /></div>
  </div>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  for (const where of ['react', 'markdown']) {
    const link = view.el.querySelector<HTMLElement>(`.${where} .docket-ref`)!
    assert.ok(link.classList.contains('ref-flare') && link.classList.contains('status-in_progress'), `${where}: the status flare`)
    assert.equal(link.getAttribute('title'), 'In progress · Build the docs site from main', `${where}: named in its tooltip`)
  }
})

test('§4b a bare ticket name links by its ticket title; the words around it, and inert prose, stay as written', async t => {
  const slug = 'flares-bare-title'
  engine(t)
  const index = buildMentionIndex([{ slug: 'build-docs', title: 'Build the docs site from main', status: 'in_progress' }])
  const view = await mountView(<div className="docket-modal">
    <p className="react"><WorkRefText text="blocked behind build-docs until it lands" index={index} onPick={noop} /></p>
    <div className="markdown"><RefMdBody html={md('blocked behind build-docs until it lands')} world={{ org: slug }}
      mentions={{ index, onPick: noop }} /></div>
    <p className="inert"><WorkRefText text="blocked behind build-docs until it lands" index={index} /></p>
  </div>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  for (const where of ['react', 'markdown']) {
    assert.equal(view.el.querySelector(`.${where} .docket-ref`)?.textContent, 'Build the docs site from main', `${where}: the title`)
    assert.equal(view.el.querySelector(`.${where}`)!.textContent?.trim(), 'blocked behind Build the docs site from main until it lands')
  }
  assert.equal(view.el.querySelector('.inert')!.textContent, 'blocked behind build-docs until it lands', 'no link, no change')
})

test('§5 the idle-docket reminder card links the ticket by its recorded title, not its slug', async t => {
  const slug = 'flares-idle'
  engine(t)
  const event = { v: 1, variant: 'reminder.idle_docket', actor: { kind: 'system', id: 'engine' }, engine_authored: true,
    object: { kind: 'node', org: slug, id: 'author' }, more: 0,
    items: [{ slug: 'build-docs', title: 'Build the docs site from main', status: 'in_progress', role: 'owner' }] }
  const view = await mountView(<IdleDocketCards event={event as never} org={slug} world={{ org: slug }} onOpen={noop} />, el => el)
  t.after(() => view.unmount())
  const link = view.el.querySelector<HTMLElement>('.idle-ticket button.ref-chip')!
  assert.equal(link.textContent, 'Build the docs site from main')
  assert.equal(link.getAttribute('data-object-id'), 'build-docs')
  assert.equal((view.el.textContent ?? '').split('Build the docs site from main').length - 1, 1, 'the title once, not twice')
})

test('§5b the reminder card links its ticket with the inline mention link itself', async t => {
  const slug = 'flares-idle-same'
  engine(t)
  const event = { v: 1, variant: 'reminder.idle_docket', actor: { kind: 'system', id: 'engine' }, engine_authored: true,
    object: { kind: 'node', org: slug, id: 'author' }, more: 0,
    items: [{ slug: 'build-docs', title: 'Build the docs (as recorded)', status: 'open', role: 'owner' }] }
  function Cards() {
    const agents = useMemo(() => new Map<string, unknown>(), [])
    const refs = useRefRoutes(slug, agents, { onOpenItem: noop })
    return <div className="card"><IdleDocketCards event={event as never} org={slug} world={refs.world} onOpen={refs.onOpen} /></div>
  }
  const view = await mountView(<><Cards /><div className="prose"><Surface slug={slug} text={`See @item:${slug}/build-docs.`} /></div></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const card = view.el.querySelector<HTMLElement>('.card .idle-ticket button')!, inline = view.el.querySelector<HTMLElement>('.prose .ref-chip.ref-item')!
  assert.deepEqual([card.tagName, card.className, card.innerHTML, card.getAttribute('title')],
    [inline.tagName, inline.className, inline.innerHTML, inline.getAttribute('title')], 'the same link: current title and status, as a mention')
  assert.match(view.el.querySelector('.card')!.textContent ?? '', /Open/, 'the card still says the status the reminder recorded')
})

test('§6 a presentation mention flares unread or modified since it was read, and never once read', async t => {
  const slug = 'flares-docs', s = engine(t)
  const text = `Read @doc:${slug}/launch-plan, @doc:${slug}/release-notes and @doc:${slug}/old-notes.`
  const view = await mountView(<><div className="react"><Surface slug={slug} text={text} /></div>
    <div className="markdown"><Surface slug={slug} text={text} markdown /></div></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  for (const where of ['react', 'markdown']) {
    assert.deepEqual(chipsOf(view.el.querySelector(`.${where}`)!, 'doc'), [
      { text: 'Launch plan', flare: 'ref-flare doc-new', title: 'Unread · Launch plan' },
      { text: 'Release notes', flare: 'ref-flare doc-updated', title: 'Modified since you last read it · Release notes' },
      { text: 'Old notes', flare: '', title: 'Old notes' },
    ], `${where}: unread, modified, read`)
  }
  assert.deepEqual(s.docReads, [['launch-plan', 'release-notes', 'old-notes']], 'one bounded read for the references on screen')
})

test('§7 opening a presentation clears its flare everywhere at once, without another read', async t => {
  const slug = 'flares-open', s = engine(t)
  const view = await mountView(<><Surface slug={slug} text={`Read @doc:${slug}/launch-plan.`} />
    <Surface slug={slug} markdown text={`Read @doc:${slug}/launch-plan.`} /></>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  assert.deepEqual(chipsOf(view.el, 'doc').map(c => c.flare), ['ref-flare doc-new', 'ref-flare doc-new'])
  await inAct(async () => { markDocViewed(slug, 'launch-plan', AT); await tick() })
  assert.deepEqual(chipsOf(view.el, 'doc').map(c => [c.flare, c.title]), [['', 'Launch plan'], ['', 'Launch plan']])
  assert.equal(s.docReads.length, 1, 'the read mark is this window\'s own: nothing is read again')
})

test('§8 presentation cards highlight unread and modified from the current read state, and clear on open', async t => {
  const slug = 'flares-cards'
  engine(t)
  const card = (id: string, title: string) => ({ id: 'present-' + id, name: 'mcp__orgtree__orgtree_present', arg: title,
    presentation: { id, title }, result: 'Presented', started_at: '2026-10-27T08:00:00Z', ended_at: '2026-10-27T08:00:00.040Z' })
  const opened: string[] = []
  const view = await mountView(<>
    <ToolChip t={card('launch-plan', 'Launch plan (as presented)')} slug={slug} nid="writer" onOpenDoc={id => opened.push(id)} />
    <ToolChip t={card('release-notes', 'Release notes')} slug={slug} nid="writer" onOpenDoc={id => opened.push(id)} />
    <ToolChip t={card('old-notes', 'Old notes')} slug={slug} nid="writer" onOpenDoc={id => opened.push(id)} />
    <PresentationCard slug={slug} doc={{ ...DOCS[1]!, format: 'markdown' }} className="doc-badge" onOpen={noop}>Release notes</PresentationCard>
  </>, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const cards = () => [...view.el.querySelectorAll<HTMLElement>('.presentation-chat-card')].map(c => ({
    text: c.textContent, state: c.getAttribute('data-doc-unread'), cls: [...c.classList].filter(k => k.startsWith('doc-')).join(' '),
    title: c.getAttribute('title') }))
  assert.deepEqual(cards(), [
    { text: 'Launch plan', state: 'new', cls: 'doc-new', title: 'Unread · Launch plan' },
    { text: 'Release notes', state: 'updated', cls: 'doc-updated', title: 'Modified since you last read it · Release notes' },
    { text: 'Old notes', state: null, cls: '', title: 'Old notes' },
  ], 'the current title and read state, not the card recorded when it was presented')
  assert.equal(view.el.querySelector('.doc-badge')?.getAttribute('title'), 'Modified since you last read it · Release notes',
    'a desk badge names the same state')
  await inAct(async () => { view.el.querySelector<HTMLElement>('.presentation-chat-card')!.click(); await tick() })
  assert.deepEqual(opened, ['launch-plan'])
  assert.deepEqual(cards()[0], { text: 'Launch plan', state: null, cls: '', title: 'Launch plan' }, 'opening clears it')
})

test('§9 the Presented list tells an unread presentation from one modified since it was read', async t => {
  const slug = 'flares-gallery'
  engine(t, [], [{ id: 'read-one', title: 'Read one', at: AT, viewed_at: AT }, ...DOCS.slice(0, 2).map(x => ({ ...x })),
    { id: 'draft-two', title: 'Draft two', at: '2026-10-27T11:00:00.000Z', viewed_at: null }])
  const view = await mountView(<DocGalleryModal slug={slug} toast={noop} close={noop} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const row = (title: string) => [...view.el.querySelectorAll<HTMLElement>('.doc-gallery-row')].find(r => r.querySelector('.mfrom')?.textContent === title)!
  const state = (title: string) => ({ unread: row(title).classList.contains('unread'),
    flare: [...row(title).classList].filter(k => k.startsWith('doc-') && k !== 'doc-gallery-row' && k !== 'doc-mockup').join(' '),
    title: row(title).getAttribute('title') })
  // the gallery opens the oldest unread itself (launch-plan), which reads it
  assert.deepEqual(state('Launch plan'), { unread: false, flare: '', title: 'Launch plan' })
  assert.deepEqual(state('Read one'), { unread: false, flare: '', title: 'Read one' })
  assert.deepEqual(state('Release notes'), { unread: true, flare: 'doc-updated', title: 'Modified since you last read it · Release notes' },
    'modified: the unread styling plus its own flare and words')
  assert.deepEqual(state('Draft two'), { unread: true, flare: 'doc-new', title: 'Unread · Draft two' }, 'unread: a different flare')
})

test('§10 a presentation\'s hover names its state with its current title: unread, modified, or nothing once read', async t => {
  const slug = 'flares-hover'
  engine(t)
  const cleanup = registerObjectNativeTooltipDocument(document)
  t.after(cleanup)
  const view = await mountView(<>{DOCS.map(d => <button key={d.id} {...objectTooltipProps('document', d.id, slug)}>{d.id}</button>)}</>, el => el)
  t.after(() => view.unmount())
  const titles: string[] = []
  for (const link of view.el.querySelectorAll('button')) {
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await inAct(tick)
    titles.push(link.title)
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
  }
  assert.deepEqual(titles, ['Unread · Launch plan', 'Modified since you last read it · Release notes', 'Old notes'])
})
