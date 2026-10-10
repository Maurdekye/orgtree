// docketpaged.test.tsx — the docket's paged reads, through the real panel.
//
// 2ac256a made the docket read /work-items-page (one request per group, searched on the server) instead of the
// foreground full list. The old cases that pinned the full-list behaviour were removed with it; this file pins the
// outcomes they protected, against the page requests:
//
//   §1 closed groups are light: Archived and Backlogged are not requested until their box is ticked
//   §2 search is a request: the query goes to the server and finds an item in a closed group
//   §3 a deep link (jumpTo) to an item in a CLOSED group looks it up exactly, turns its group on and selects
//      the row
//   §4 a stale reference (no such item) says so instead of opening something else
//
// Run: cd apps/desktop/renderer && node tests/run.mjs docketpaged

import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'unnamed-fixture-item', rev: 1, kind: 'code', title: 'Item',
  objective: '', status: 'in_progress', blocked_reason: null,
  archived: false, archived_at: null,
  owner: { node: 'agent1', generation: 1 }, owner_current: true,
  owner_state: 'live', participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [],
  acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
  ...o,
} as unknown as WorkItem)

const mkTree = (): TreePayload => ({
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

interface Served { items: WorkItem[]; archived: WorkItem[]; backlogged: WorkItem[] }
interface Requests { pages: URLSearchParams[]; refs: string[][]; details: string[] }

/** the three paged routes of the docket, the way the engine answers them (one complete page per group, the
 *  query filtering on title and slug) */
function pagedServer(s: Served): Requests {
  const seen: Requests = { pages: [], refs: [], details: [] }
  const all = () => [...s.items, ...s.archived, ...s.backlogged]
  const ok = (payload: unknown) => Promise.resolve({
    ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(payload),
  })
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
    const u = new URL(String(url), 'http://localhost')
    if (u.pathname.endsWith('/work-items-page')) {
      seen.pages.push(u.searchParams)
      const group = (u.searchParams.get('group') ?? 'items') as 'items' | 'archived' | 'backlogged'
      const query = (u.searchParams.get('query') ?? '').toLowerCase()
      const rows = s[group].filter(r => !query || r.slug.includes(query) || r.title.toLowerCase().includes(query))
      const totals = { items: s.items.length, archived: s.archived.length, backlogged: s.backlogged.length }
      return ok({ format: 'orgtree.work-page/v1', group, rows, total: rows.length, totals, matched: totals,
        counts: { attention: 0, active: s.items.length, archived: s.archived.length, backlogged: s.backlogged.length },
        next_offset: null, revision: 'r1', at: '2026-09-05T10:00:00.000Z' })
    }
    if (u.pathname.endsWith('/work-item-references')) {
      const names = (u.searchParams.get('names') ?? '').split(',').filter(Boolean)
      seen.refs.push(names)
      return ok({ references: all().filter(r => names.includes(r.slug))
        .map(({ slug, title, parent, archived, status, rev }) => ({ slug, title, parent, archived, status, rev })) })
    }
    const one = /\/work-items\/([^/?]+)$/.exec(u.pathname)
    if (one) {
      seen.details.push(one[1]!)
      return ok({ item: all().find(r => r.slug === one[1]) })
    }
    return ok({})
  }) as unknown as typeof fetch
  return seen
}

function uiTest(name: string, body: (mount: (v: React.ReactElement) => Promise<HTMLElement>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { unmount: () => Promise<void> } | null = null
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    window.localStorage.removeItem('orgtree.docket.group')
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      return view.el
    })
  })
}

const modal = () => <DocketModal slug="org1" toast={() => {}} close={() => {}} tree={mkTree()} />
const names = (el: HTMLElement) =>
  [...el.querySelectorAll('.mailrow.docket-row')].map((r) => r.querySelector('.l1 .mfrom')?.textContent ?? '')
const backlogBox = (el: HTMLElement) => el.querySelector('.docket-showbacklog input') as HTMLInputElement
const archivedBox = (el: HTMLElement) => el.querySelector('.docket-showarchived input') as HTMLInputElement
const groupsAsked = (r: Requests) => r.pages.map(p => p.get('group'))
const OPEN = mkItem({ slug: 'open-work', title: 'Open work', objective: '' })
const OLD = mkItem({ slug: 'finished-work', title: 'Finished work', archived: true, status: 'done' })
const LATER = mkItem({ slug: 'later-work', title: 'Later work', status: 'backlogged' })

uiTest('§1 closed groups are light: Archived and Backlogged are requested only once their box is ticked',
  async (mount) => {
    const seen = pagedServer({ items: [OPEN], archived: [OLD], backlogged: [LATER] })
    const el = await mount(modal()); await flush()
    assert.deepEqual(names(el), ['open-work'])
    assert.equal(groupsAsked(seen).includes('archived'), false, 'the archive was fetched while closed')
    assert.equal(groupsAsked(seen).includes('backlogged'), false, 'the backlog was fetched while closed')

    await inAct(() => archivedBox(el).click()); await flush()
    assert.equal(groupsAsked(seen).includes('archived'), true, 'ticking Show archived must request that group')
    assert.ok(names(el).includes('finished-work'), `the archived row is listed — have ${JSON.stringify(names(el))}`)
    assert.equal(groupsAsked(seen).includes('backlogged'), false, 'and the backlog is still closed')

    await inAct(() => backlogBox(el).click()); await flush()
    assert.equal(groupsAsked(seen).includes('backlogged'), true)
    assert.ok(names(el).includes('later-work'))
  })

uiTest('§2 search is a request: the query reaches the server and finds an item in a closed group',
  async (mount) => {
    const seen = pagedServer({ items: [OPEN], archived: [OLD], backlogged: [LATER] })
    const el = await mount(modal()); await flush()
    await inAct(() => archivedBox(el).click()); await flush()
    const box = el.querySelector('input[type="search"], input.docket-search, input[placeholder*="earch"]') as HTMLInputElement | null
    assert.ok(box, 'the docket has a search box')
    await inAct(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(box, 'finished')
      box!.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await advance(600, 50); await flush()
    assert.ok(seen.pages.some(p => p.get('query') === 'finished'), 'the typed query was not sent to the server')
    assert.deepEqual(names(el), ['finished-work'], 'the search shows the matching archived item only')
  })

uiTest('§3 a deep link to a CLOSED item looks it up exactly, turns its group on and selects it',
  async (mount) => {
    const seen = pagedServer({ items: [OPEN], archived: [], backlogged: [LATER] })
    const handled: string[] = []
    const el = await mount(<DocketModal slug="org1" toast={() => {}} close={() => {}} tree={mkTree()}
      jumpTo="later-work" jumpSeq={1} onJumpHandled={() => { handled.push('later-work') }} />)
    await flush(); await advance(100, 50); await flush()
    assert.ok(seen.refs.some(r => r.includes('later-work')), 'the unknown item was looked up exactly')
    assert.equal(backlogBox(el).checked, true, 'its group was turned on')
    assert.ok(groupsAsked(seen).includes('backlogged'), 'and requested')
    assert.ok(names(el).includes('later-work'), `the row is listed — have ${JSON.stringify(names(el))}`)
    assert.match(el.querySelector('.mailer-read')?.textContent ?? '', /Later work/, 'and it is the selected item')
    assert.deepEqual(handled, ['later-work'], 'the jump is consumed once')
  })

uiTest('§4 a stale reference says there is no such item instead of opening something else',
  async (mount) => {
    const seen = pagedServer({ items: [OPEN], archived: [], backlogged: [] })
    const el = await mount(<DocketModal slug="org1" toast={() => {}} close={() => {}} tree={mkTree()}
      jumpTo="long-gone-item" jumpSeq={1} onJumpHandled={() => {}} />)
    await flush(); await advance(100, 50); await flush()
    assert.ok(seen.refs.some(r => r.includes('long-gone-item')), 'it asked whether the item exists')
    assert.match(el.querySelector('.docket-nojump')?.textContent ?? '', /long-gone-item.*not an item/,
      'the reader says the item does not exist')
    assert.equal(el.querySelector('.mailer-read .docket-desc-body'), null, 'and no other item is opened in its place')
  })
