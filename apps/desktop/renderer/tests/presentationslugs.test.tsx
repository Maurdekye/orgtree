// tests/presentationslugs.test.tsx — presentations identified by a readable slug (USER 2026-10-27 m4efbc12ac94e,
// @item:orgtree/4-5-0-presentations-identified-by-a-readable-slu). The renderer half:
//   §1-§2 a jump by an OLD generic id (an old notification, a restored reader, an old @doc: token) lands on the
//         presentation the engine located, which every list holds by its slug (`located_id`);
//   §3-§5 a presentation mention shows its current full title (USER m7bb9eb904138), read through the shared label
//         path for the exact references on screen and again on every documents_changed frame; an old id shows the
//         same title; without an answer the chip keeps its slug and stays a link;
//   §6-§8 the composer's @ list offers presentations (USER mb21c096e5dc4): shown by title with the document icon,
//         found by title or slug words, newest first among every kind (m79e889ce1609, the engine's
//         mention-candidates read); completing one inserts @doc:<org>/<slug>; one mentioned in the transcript is
//         offered first.
// Each test uses its own org slug: answers are kept per org.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useMemo, useRef, useState } from 'react'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import type { DocRow } from '../src/api'
import { RefProse, useRefRoutes } from '../src/canvas/reflinks'
import { refNames } from '../src/canvas/refnames'
import { extractMentionRecency, filterMentionCandidates, mentionText, useAgentMentions } from '../src/canvas/agentmentions'
import type { MentionCandidate } from '../src/canvas/agentmentions'

const tick = async () => { for (let i = 0; i < 8; i++) await flush() }
const noop = () => {}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const row = (id: string, title: string, at: string): DocRow => ({
  id, node: 'writer', title, at, viewed_at: at, evicted: false, node_state: 'live', format: 'markdown',
})
/** what the engine holds after migration 0073: slugs, and the old ids they had */
const ROWS = [
  row('weekly-status-2', 'Weekly status', '2026-10-27T09:00:00.000Z'),
  row('launch-plan', 'Launch plan', '2026-10-27T08:00:00.000Z'),
  row('weekly-status', 'Weekly status', '2026-10-27T07:00:00.000Z'),
]
const OLD: Record<string, string> = { d00000000c001: 'weekly-status', d00000000c003: 'weekly-status-2' }

/** The documents API as the engine answers it: a slug or an old id opens a presentation; `locate` echoes the
 *  request as `located` and names the slug as `located_id`; `refs` answers titles; `search` matches words. */
function engine(t: TestContext, rows: DocRow[] = ROWS) {
  const s = { rows, refs: [] as string[][], searches: [] as string[] }
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: RequestInfo | URL) => {
    const url = new URL(String(raw), 'http://local'), path = url.pathname
    const slugOf = (ref: string) => OLD[ref] ?? ref
    if (/\/documents\/viewed$/.test(path)) return json({ ok: true })
    const one = path.match(/\/documents\/([^/]+)$/)
    if (one) {
      const r = s.rows.find(x => x.id === slugOf(decodeURIComponent(one[1]!)))
      return r ? json({ ...r, body: `body of ${r.id}` }) : json({ detail: 'that document no longer exists' }, 404)
    }
    // the @ list's read (mention-candidates): presentations by every typed word, newest first
    if (path.endsWith('/mention-candidates')) {
      const q = url.searchParams.get('q') ?? ''
      s.searches.push(q)
      const words = q.toLowerCase().split(/[-_./\s]+/).filter(Boolean)
      const kinds = (url.searchParams.get('kinds') ?? '').split(',')
      const found = kinds.includes('doc') ? s.rows.filter(r => words.every(w => `${r.title} ${r.id}`.toLowerCase().includes(w)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : []
      return json({ items: found.map(r => ({ kind: 'doc', id: r.id, label: r.title, at: r.at, format: r.format })), next_cursor: null, nodes: [] })
    }
    if (!path.endsWith('/documents')) return json({})
    const refs = url.searchParams.get('refs')
    if (refs !== null) {
      const asked = refs.split(',').filter(Boolean)
      s.refs.push(asked)
      return json({ refs: asked.flatMap(ref => {
        const r = s.rows.find(x => x.id === slugOf(ref))
        return r ? [{ ref, id: r.id, title: r.title, format: r.format }] : []
      }) })
    }
    const search = url.searchParams.get('search')
    if (search !== null) {
      s.searches.push(search)
      const words = search.toLowerCase().split(/\s+/).filter(Boolean)
      return json({ documents: s.rows.filter(r => words.every(w => `${r.title} ${r.id}`.toLowerCase().includes(w)))
        .map(r => ({ id: r.id, title: r.title, format: r.format, node: r.node })) })
    }
    const locate = url.searchParams.get('locate') ?? ''
    return json({ documents: s.rows, total: s.rows.length, offset: 0, next_offset: null,
      ...(locate ? { located: locate, located_id: slugOf(locate) } : {}) })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return s
}

const pane = (el: HTMLElement) => el.querySelector('.mailer-read')?.textContent ?? ''

test('§1 the gallery opens a presentation jumped to by its OLD generic id, by the slug the engine located', async t => {
  engine(t)
  const toasts: string[][] = []
  let handled = 0
  const view = await mountView(<DocGalleryModal slug="slugs-gallery" toast={m => { toasts.push(m) }} close={noop}
    jumpTo={{ id: 'd00000000c001', seq: 1 }} onJumpHandled={() => { handled++ }} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  assert.deepEqual(toasts, [], 'no "too far down the list" refusal for a presentation the engine located')
  assert.ok(handled >= 1, 'the jump was answered')
  assert.match(pane(view.el), /body of weekly-status\b/, 'the presentation the old id named is open')
})

test('§2 a desk\'s gallery does the same for a reader restored or a reference clicked with an old id', async t => {
  engine(t)
  const toasts: string[][] = []
  const view = await mountView(<AgentGalleryView slug="slugs-desk" nid="writer" toast={m => { toasts.push(m) }}
    jumpTo={{ id: 'd00000000c003', seq: 1 }} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  assert.deepEqual(toasts, [])
  assert.match(pane(view.el), /body of weekly-status-2\b/)
})

function Prose({ slug, text }: { slug: string; text: string }) {
  const agents = useMemo(() => new Map<string, unknown>(), [])
  const refs = useRefRoutes(slug, agents, { onOpenDoc: noop })
  return <p><RefProse text={text} world={refs.world} onOpen={refs.onOpen} /></p>
}
const docChips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.ref-chip.ref-doc')]
  .map(c => ({ text: c.textContent, live: c.tagName === 'BUTTON', token: c.getAttribute('data-ref-token') }))

test('§3 a presentation mention shows its current full title, also for an old id, read once for the references on screen', async t => {
  const slug = 'slugs-titles', s = engine(t)
  const view = await mountView(<Prose slug={slug}
    text={`Read @doc:${slug}/launch-plan and the old @doc:${slug}/d00000000c001; not @doc:other/launch-plan.`} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  const chips = docChips(view.el)
  assert.deepEqual(chips.slice(0, 2).map(c => [c.text, c.live]), [['Launch plan', true], ['Weekly status', true]])
  assert.deepEqual(s.refs, [['launch-plan', 'd00000000c001']], 'one bounded read; another org\'s presentation is never read here')
  assert.match(view.el.textContent ?? '', /@doc:other\/launch-planother org/, 'another org keeps its token and verdict')
})

test('§4 a retitled presentation\'s chip follows when the titles are read again (the documents_changed frame)', async t => {
  const slug = 'slugs-live', s = engine(t, ROWS.map(r => ({ ...r })))
  const view = await mountView(<Prose slug={slug} text={`See @doc:${slug}/launch-plan.`} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  assert.equal(docChips(view.el)[0]!.text, 'Launch plan')
  s.rows.find(r => r.id === 'launch-plan')!.title = 'Launch plan, final'
  await inAct(tick)
  assert.equal(docChips(view.el)[0]!.text, 'Launch plan', 'nothing re-reads on its own')
  await inAct(async () => { refNames.invalidate(slug, ['doc']); await tick() })
  assert.equal(docChips(view.el)[0]!.text, 'Launch plan, final')
  assert.equal(s.refs.length, 2, 'one read for the screen, one for the change')
})

test('§5 without a title the chip keeps its slug and stays a link: a name read never makes a presentation absent', async t => {
  const slug = 'slugs-missing'
  engine(t)
  const view = await mountView(<Prose slug={slug} text={`See @doc:${slug}/no-such-presentation.`} />, el => el)
  t.after(() => view.unmount())
  await inAct(tick)
  assert.deepEqual(docChips(view.el).map(c => [c.text, c.live]), [['no-such-presentation', true]],
    'the reader it opens says whether it exists')
})

/** A composer as the desks wire it, with its org: the box and its @-completion. */
function Composer({ org, transcript = [] }: { org: string; transcript?: string[] }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement | null>(null)
  const candidates = useMemo<MentionCandidate[]>(() => [{ id: 'writer', tier: 'sol', kind: 'agent' }], [])
  const mentions = useAgentMentions({ value: text, onChange: setText, inputRef: box, candidates, org,
    transcriptTexts: () => transcript })
  return <div><textarea className="fake-composer" ref={box} value={text} onChange={e => setText(e.target.value)}
    onKeyDown={e => { mentions.onKeyDown(e) }} />{mentions.menu}</div>
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
  await inAct(tick)
}
async function press(box: Element, key: string) {
  await inAct(async () => {
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await flush(4)
  })
}
const items = () => [...document.querySelectorAll<HTMLElement>('.agent-mentions .agent-mention-item')]
const presentationRows = () => items().filter(r => r.classList.contains('mention-presentation')).map(r => ({
  name: r.querySelector('.agent-mention-name')?.textContent ?? '',
  icon: !!r.querySelector('.mention-presentation-mark svg'),
  label: r.getAttribute('aria-label'),
}))

test('§6 typing @ offers presentations by title with the document icon; Tab inserts @doc:<org>/<slug>', async t => {
  const org = 'slugs-menu', s = engine(t)
  const view = await mountView(<Composer org={org} />, el => el)
  t.after(() => view.unmount())
  const box = view.el.querySelector<HTMLTextAreaElement>('.fake-composer')!
  await typeInto(box, 'see @launch')
  assert.deepEqual(presentationRows(), [{ name: 'Launch plan', icon: true, label: 'presentation Launch plan' }])
  assert.deepEqual(s.searches.at(-1), 'launch', 'the engine\'s bounded search, for the typed words')
  await press(box, 'Tab')
  assert.equal(box.value, `see @doc:${org}/launch-plan `)
})

test('§7 every typed word finds a presentation in its title or slug, and the list is newest first across kinds', async t => {
  const org = 'slugs-words'
  engine(t)
  const view = await mountView(<Composer org={org} />, el => el)
  t.after(() => view.unmount())
  const box = view.el.querySelector<HTMLTextAreaElement>('.fake-composer')!
  await typeInto(box, 'see @weekly-st')
  assert.deepEqual(presentationRows().map(r => r.name), ['Weekly status', 'Weekly status'],
    'both presentations titled "Weekly status"; their slugs tell them apart in the hover and the inserted reference')
  await typeInto(box, 'see @status-week')
  assert.equal(presentationRows().length, 2, 'words in any order, as the engine\'s search matched them')
  await typeInto(box, 'see @w')
  assert.deepEqual(items().map(r => r.querySelector('.agent-mention-name')?.textContent), ['@writer', 'Weekly status', 'Weekly status'],
    'drawn bottom-up, newest nearest the box (USER m79e889ce1609): the 09:00 presentation, the 07:00 one, then an agent with no known activity')
  assert.equal(items().at(-1)!.getAttribute('aria-label'), 'presentation Weekly status')
  assert.equal(mentionText({ id: 'weekly-status', tier: 'presentation', kind: 'presentation', org, title: 'Weekly status' }),
    `@doc:${org}/weekly-status`)
})

test('§8 a presentation mentioned in the open transcript is offered first, by its own reference only', () => {
  const org = 'slugs-recent'
  // the presentation launch-plan by its reference; an agent-style @launch-deck is not the presentation launch-deck
  const recency = extractMentionRecency([`see @doc:${org}/launch-plan`, 'ping @launch-deck'])
  const candidates: MentionCandidate[] = [
    { id: 'launch-deck', tier: 'presentation', kind: 'presentation', org, title: 'Launch deck' },
    { id: 'launch-plan', tier: 'presentation', kind: 'presentation', org, title: 'Launch plan' }]
  assert.deepEqual(filterMentionCandidates(candidates, 'launch', recency).map(c => c.id), ['launch-plan', 'launch-deck'])
})
