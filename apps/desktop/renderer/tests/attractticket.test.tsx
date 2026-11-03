// Attract mode opening a CHANGED ticket (@item:orgtree/attract-mode-only-canvas-interaction-interrupts-i,
// points i-l): USER 2026-11-03 11:15:07Z m73037cb0a404 "when attract mode opens a ticket that's changed,
// it should expand the relevant sections & scroll down to the content that's changed"; refinement
// 11:15:22Z m472583486fbb "should observe the diff to locate where exactly that occurred at, first
// position"; decision @coordinator-opus mf102bc2f510a (in-memory text snapshot, no engine storage).
import { flush, inAct, mountView } from './harness'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { compatibilityWorkFixture } from './workcompat.fixture'
import { DocketModal } from '../src/canvas/docket'
import { CurrentOrg } from '../src/popout'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_ITEMS, clearTicketSnapshots, firstTextChange, historySection, locateChange,
  recordTicketSnapshot, ticketFields, ticketSnapshot,
} from '../src/attract/ticketsnap'
import { showTicketChange } from '../src/attract/ticketdom'
import { canvasAttractRoutes } from '../src/attract/canvas'

const item = (over: Record<string, unknown> = {}): any => ({
  slug: 't', rev: 1, status: 'in_progress', objective: 'Problem: x. Solution: y.',
  blocked_reason: null, dropped_reason: null, done_so_far: ['one', 'two'], working_on_next: ['next a'],
  evidence: [{ note: 'ev one', ref: 'r1' }, { ref: 'no note' }], history: [], ...over,
})
const ids = (it: any) => ticketFields(it).map(f => f.id)

test('§1 the text fields, in the order the ticket pane draws them, named as the pane names them', () => {
  assert.deepEqual(ids(item()), ['objective', 'done_so_far#0', 'done_so_far#1', 'working_on_next#0', 'evidence.note#0'])
  assert.deepEqual(ids(item({ status: 'blocked', blocked_reason: 'waiting on X' })),
    ['objective', 'blocked_reason', 'done_so_far#0', 'done_so_far#1', 'working_on_next#0', 'evidence.note#0'])
  assert.deepEqual(ids(item({ status: 'dropped', dropped_reason: 'no longer needed', objective: '' })),
    ['dropped_reason', 'done_so_far#0', 'done_so_far#1', 'working_on_next#0', 'evidence.note#0'])
  assert.equal(ticketFields(item()).find(f => f.id === 'done_so_far#1')!.section, 'DONE SO FAR')
})

test('§2 the FIRST differing position, in document order: new entries, edits, deletions, nothing', () => {
  const base = ticketFields(item())
  assert.equal(firstTextChange(base, ticketFields(item())), null, 'identical text: no change')
  // an appended progress entry: that whole entry
  assert.deepEqual(firstTextChange(base, ticketFields(item({ done_so_far: ['one', 'two', 'three'] }))),
    { kind: 'text', field: 'done_so_far#2', section: 'DONE SO FAR', offset: 0, length: 5, snippet: 'three' })
  // an edit in the middle of the description: the changed span only (common prefix and suffix are kept)
  const edited = item({ objective: 'Problem: x. NEW SENTENCE. Solution: y.' })
  const got = firstTextChange(base, ticketFields(edited))
  assert.deepEqual(got, { kind: 'text', field: 'objective', section: 'DESCRIPTION', offset: 12, length: 14, snippet: 'NEW SENTENCE. ' })
  assert.equal(edited.objective.slice(12, 26), 'NEW SENTENCE. ')
  // a pure deletion is a position, not a span
  assert.deepEqual(firstTextChange(base, ticketFields(item({ objective: 'Problem: x.' }))),
    { kind: 'text', field: 'objective', section: 'DESCRIPTION', offset: 11, length: 0, snippet: 'Problem: x.' })
  // several changes: the one earliest in the pane wins, whichever was made last
  assert.equal((firstTextChange(base, ticketFields(item({ objective: 'Problem: z. Solution: y.', done_so_far: ['one', 'changed'] }))) as any).field, 'objective')
  assert.equal((firstTextChange(base, ticketFields(item({ working_on_next: ['next b'], done_so_far: ['one', 'two!'] }))) as any).field, 'done_so_far#1')
  // an entry that vanished: its section, no text to point at
  assert.deepEqual(firstTextChange(base, ticketFields(item({ done_so_far: ['one'] }))), { kind: 'section', section: 'DONE SO FAR' })
  // a state reason that appeared
  assert.equal((firstTextChange(base, ticketFields(item({ status: 'blocked', blocked_reason: 'why' }))) as any).field, 'blocked_reason')
})

test('§3 the snapshot store: rev kept, refreshed on every show, LRU by item count and by bytes', () => {
  clearTicketSnapshots()
  assert.equal(ticketSnapshot('acme', 't'), null, 'first sight: nothing')
  recordTicketSnapshot('acme', item({ rev: 4 }))
  assert.equal(ticketSnapshot('acme', 't')!.rev, 4)
  assert.equal(ticketSnapshot('other', 't'), null, 'per organization')
  recordTicketSnapshot('acme', item({ rev: 5, objective: 'changed' }))
  assert.equal(ticketSnapshot('acme', 't')!.rev, 5)
  assert.equal(ticketFields(item({ objective: 'changed' }))[0]!.text, ticketSnapshot('acme', 't')!.fields[0]!.text)
  // count cap: the least recently used goes
  clearTicketSnapshots()
  for (let i = 0; i < SNAPSHOT_MAX_ITEMS + 5; i++) {
    recordTicketSnapshot('acme', item({ slug: 's' + i }))
    if (i >= 2) ticketSnapshot('acme', 's0')   // a read counts as use
  }
  assert.ok(ticketSnapshot('acme', 's0'), 'recently read: kept')
  assert.equal(ticketSnapshot('acme', 's1'), null, 'oldest unread: dropped')
  assert.ok(ticketSnapshot('acme', 's' + (SNAPSHOT_MAX_ITEMS + 4)))
  // byte cap
  clearTicketSnapshots()
  const big = 'x'.repeat(400_000)
  for (let i = 0; i < 8; i++) recordTicketSnapshot('acme', item({ slug: 'b' + i, objective: big }))
  const kept = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => ticketSnapshot('acme', 'b' + i))
  assert.ok(kept.length * 400_000 <= SNAPSHOT_MAX_BYTES, 'about two megabytes at most: kept ' + kept.length)
  assert.ok(ticketSnapshot('acme', 'b7'), 'the newest is kept')
  clearTicketSnapshots()
})

test('§4 without a snapshot the history says where: an evidence row since the last input points at EVIDENCE NOTES, otherwise nothing', () => {
  const since = Date.parse('2026-11-03T10:00:00Z')
  const row = (op: string, at: string) => ({ op, at })
  assert.equal(historySection(item({ history: [row('evidence', '2026-11-03T10:30:00Z')] }), since), 'EVIDENCE NOTES')
  assert.equal(historySection(item({ history: [row('evidence', '2026-11-03T09:00:00Z')] }), since), null, 'before the last input: already seen')
  assert.equal(historySection(item({ history: [row('update', '2026-11-03T10:30:00Z')] }), since), null, 'an update row names no field')
  assert.equal(historySection(item({ history: 'junk' }), since), null)
})

test('§5 locating: a newer snapshot diffs; an equal rev or no snapshot falls back; nothing determinable shows the top', () => {
  clearTicketSnapshots()
  const since = Date.parse('2026-11-03T10:00:00Z')
  const old = item({ rev: 3 })
  recordTicketSnapshot('acme', old)
  const now = item({ rev: 4, done_so_far: ['one', 'two', 'three'] })
  assert.equal((locateChange(ticketSnapshot('acme', 't'), now, since) as any).field, 'done_so_far#2')
  assert.equal(locateChange(ticketSnapshot('acme', 't'), item({ rev: 3 }), since), null, 'same rev: the user saw this text')
  assert.equal(locateChange(ticketSnapshot('acme', 't'), item({ rev: 4, status: 'review' }), since), null, 'a non-text change: the top')
  assert.deepEqual(locateChange(null, item({ rev: 4, history: [{ op: 'evidence', at: '2026-11-03T10:30:00Z' }] }), since),
    { kind: 'section', section: 'EVIDENCE NOTES' })
  assert.equal(locateChange(null, item({ rev: 4 }), since), null)
  clearTicketSnapshots()
})

// ------------------------------------------------------------------ the pane
/** the docket pane as DocketSection draws it: a section with a heading, a toggle and a hidden body */
function pane() {
  const d = window.document
  const root = d.createElement('div')
  root.className = 'docket-pane-scroll'
  root.style.overflowY = 'auto'
  let top = 0
  const rect = (y: number, h = 20) => ({ top: y, bottom: y + h, left: 0, right: 100, width: 100, height: h, x: 0, y }) as DOMRect
  root.getBoundingClientRect = () => rect(0, 400)
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 400 })
  Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2400 })
  const sections: Record<string, { section: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement; field?: HTMLElement }> = {}
  const add = (title: string, collapsed: boolean, field?: { name: string; entry?: number; text: string; y: number; folded?: boolean }) => {
    const section = d.createElement('section')
    const h = d.createElement('h4'); h.className = 'docket-detail-section-title'; h.textContent = title
    const toggle = d.createElement('button'); toggle.className = 'docket-detail-toggle'
    toggle.setAttribute('aria-expanded', String(!collapsed))
    const body = d.createElement('div'); body.hidden = collapsed
    toggle.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); body.hidden = !open })
    section.append(h, toggle, body)
    let fieldEl: HTMLElement | undefined
    if (field) {
      fieldEl = d.createElement('span'); fieldEl.setAttribute('data-docket-field', field.name)
      if (field.entry !== undefined) fieldEl.setAttribute('data-docket-entry', String(field.entry))
      fieldEl.textContent = field.text
      fieldEl.getBoundingClientRect = () => rect(field.y - top)
      if (field.folded) {
        // DocketDescription's fold: a clipped body with its own 'show all N lines' toggle (canvas/docketdesc.tsx)
        const fold = d.createElement('div'); fold.className = 'docket-desc-fold folded'
        const more = d.createElement('button'); more.className = 'docket-desc-toggle'; more.setAttribute('aria-expanded', 'false')
        more.addEventListener('click', () => { const open = more.getAttribute('aria-expanded') !== 'true'; more.setAttribute('aria-expanded', String(open)); fold.classList.toggle('folded', !open) })
        // the marked field WRAPS the description component, and so its fold (DocketSelection around DocketDescription)
        const clip = d.createElement('span'); clip.textContent = field.text; fieldEl.textContent = ''
        fold.append(clip, more)
        fieldEl.append(fold)
        body.append(fieldEl)
      } else body.append(fieldEl)
    }
    root.append(section)
    sections[title] = { section, body, toggle, ...(fieldEl ? { field: fieldEl } : {}) }
  }
  d.body.append(root)
  Object.defineProperty(root, 'scrollTop', { configurable: true, get: () => top, set: v => { top = v } })
  return { root, sections, add, scrollTop: () => top, remove: () => root.remove() }
}

test('§6 the pane: a collapsed section is expanded, the first change scrolled to and highlighted, and everything put back', async () => {
  const p = pane()
  p.add('DESCRIPTION', false, { name: 'objective', text: 'Problem: x. NEW SENTENCE. Solution: y.', y: 100 })
  p.add('DONE SO FAR', false, { name: 'done_so_far', entry: 2, text: 'three', y: 900 })
  p.add('EVIDENCE NOTES', true, { name: 'evidence.note', entry: 0, text: 'ev one', y: 1500 })
  const marks: string[] = []
  const g = globalThis as any
  const hadCSS = g.CSS
  g.CSS = { ...(hadCSS ?? {}), highlights: { set: (_n: string, h: any) => marks.push('set:' + h.text), delete: () => marks.push('delete') } }
  g.Highlight = class { text: string; constructor(r: any) { this.text = r.toString() } }
  try {
    const show = showTicketChange({ kind: 'text', field: 'evidence.note#0', section: 'EVIDENCE NOTES', offset: 0, length: 6, snippet: 'ev one' }, document)
    const len = await show.length
    assert.ok(len > 0, 'a scroll has a length: ' + len)
    assert.equal(p.sections['EVIDENCE NOTES']!.body.hidden, false, 'the section holding the change is expanded')
    assert.equal(p.sections['DESCRIPTION']!.body.hidden, false, 'others are left alone')
    assert.ok(marks.some(m => m === 'set:ev one'), 'the changed text is highlighted: ' + marks.join('|'))
    show.restore()
    assert.equal(p.sections['EVIDENCE NOTES']!.body.hidden, true, 'put back as it was')
    assert.ok(marks.includes('delete'), 'highlight cleared')
    // a section that was already open stays open when restoring
    const open = showTicketChange({ kind: 'text', field: 'objective', section: 'DESCRIPTION', offset: 12, length: 14, snippet: 'NEW SENTENCE.' }, document)
    await open.length
    open.restore()
    assert.equal(p.sections['DESCRIPTION']!.body.hidden, false, 'a section the user had open is not collapsed')
    // released (the user touched the pane or interrupted): the expansion stays, the highlight goes
    const rel = showTicketChange({ kind: 'section', section: 'EVIDENCE NOTES' }, document)
    await rel.length
    assert.equal(p.sections['EVIDENCE NOTES']!.body.hidden, false)
    rel.release()
    rel.restore()
    assert.equal(p.sections['EVIDENCE NOTES']!.body.hidden, false, 'released: restore no longer collapses it')
  } finally { g.CSS = hadCSS; delete g.Highlight; p.remove() }
})

test('§6c a change inside the clipped description opens the description fold, and moving on folds it back', async () => {
  const p = pane()
  p.add('DESCRIPTION', false, { name: 'objective', text: 'Problem: x. NEW SENTENCE. Solution: y.', y: 900, folded: true })
  const more = p.root.querySelector<HTMLElement>('.docket-desc-toggle')!
  const fold = p.root.querySelector<HTMLElement>('.docket-desc-fold')!
  try {
    const show = showTicketChange({ kind: 'text', field: 'objective', section: 'DESCRIPTION', offset: 12, length: 14, snippet: 'NEW SENTENCE.' }, document)
    await show.length
    assert.equal(more.getAttribute('aria-expanded'), 'true', 'the description fold is opened so the text is not clipped')
    assert.equal(fold.classList.contains('folded'), false)
    show.restore()
    assert.equal(more.getAttribute('aria-expanded'), 'false', 'folded back as it was')
    assert.equal(fold.classList.contains('folded'), true)
    // a fold the user had open is left open
    more.click()
    const again = showTicketChange({ kind: 'text', field: 'objective', section: 'DESCRIPTION', offset: 12, length: 14, snippet: 'NEW SENTENCE.' }, document)
    await again.length
    again.restore()
    assert.equal(more.getAttribute('aria-expanded'), 'true', 'not folded by attract when the user had it open')
  } finally { p.remove() }
})

test('§6b no change means the top: nothing expands, nothing scrolls, length 0', async () => {
  const p = pane()
  p.add('EVIDENCE NOTES', true, { name: 'evidence.note', entry: 0, text: 'ev', y: 1500 })
  try {
    const show = showTicketChange(null, document)
    assert.equal(await show.length, 0)
    assert.equal(p.sections['EVIDENCE NOTES']!.body.hidden, true)
    assert.equal(p.scrollTop(), 0)
    show.restore()
  } finally { p.remove() }
})

test('§7 the ticket route: the diff is taken BEFORE the docket opens, the pane is driven, the sections are put back on moving on', async () => {
  clearTicketSnapshots()
  localStorage.clear()
  const realFetch = globalThis.fetch
  const cur = item({ rev: 9, done_so_far: ['one', 'two', 'three'] })
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (u.includes('/work-items/t')) return json({ item: cur })
    return json({})
  }) as typeof fetch
  const p = pane()
  p.add('DONE SO FAR', true, { name: 'done_so_far', entry: 2, text: 'three', y: 900 })
  try {
    recordTicketSnapshot('acme', item({ rev: 5 }))
    const calls: string[] = []
    const routes = canvasAttractRoutes(() => ({
      enabled: true, slug: 'acme', tree: { user_inbox_count: 0 } as any, map: new Map(), pinnedIds: () => new Set(),
      goToAgent: () => {}, fitAll: () => {}, openDoc: () => {}, readerIds: () => [], closeReader: () => {},
      onPanel: (pn) => calls.push('panel:' + (pn === 'release' ? 'release' : pn ? pn.kind : 'close')),
    }))
    const len = await routes.show({ kind: 'ticket', slug: 't', mark: 'm' })
    assert.deepEqual(calls, ['panel:docket'])
    assert.ok(Number(len) > 0, 'the dwell lasts at least the scroll')
    assert.equal(p.sections['DONE SO FAR']!.body.hidden, false, 'expanded for the change')
    assert.equal(ticketSnapshot('acme', 't')!.rev, 9, 'the snapshot is refreshed to what was shown')
    routes.hide({ kind: 'ticket', slug: 't', mark: 'm' })
    assert.equal(p.sections['DONE SO FAR']!.body.hidden, true, 'put back')
    assert.deepEqual(calls, ['panel:docket', 'panel:close'])
    // interrupted while shown: the sections stay as the user's
    await routes.show({ kind: 'ticket', slug: 't', mark: 'm' })
    routes.stop?.()
    assert.equal(ticketSnapshot('acme', 't')!.rev, 9)
  } finally { globalThis.fetch = realFetch; p.remove(); clearTicketSnapshots(); localStorage.clear() }
  await flush()
})

test('§8 the capture fixture contract: the real DocketModal, fed the way attractticket/docketplain.visual feed it, shows the jumped-to ticket with its text fields marked', async () => {
  const realFetch = globalThis.fetch
  const full = {
    slug: 'changed-ticket', title: 'A ticket that changed', kind: 'code', status: 'in_progress', archived: false, rev: 4,
    owner: null, participants: [], at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T11:00:00Z', docket_at: '2026-11-03T11:00:00Z',
    objective: 'Problem: x. Solution: y.', done_so_far: ['Wrote the red tests'], working_on_next: ['Post the job'],
    questions: [], dependencies: [], history: [], dismissals: [], acceptance: [], effective_attention: false, attention_sources: [],
    evidence: [{ note: 'first evidence', ref: 'r1', kind: 'note', at: '2026-11-03T08:30:00Z', by: 'a' }],
  }
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = compatibilityWorkFixture((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw Error('Blocked fixture write')
    if (String(input).includes('/work-items/changed-ticket')) return json({ item: full })
    return json({ items: [full], archived: [], backlogged: [] })
  }) as typeof fetch)
  const tree = { slug: 'fixture', name: 'Fixture', roots: [], asks: [], epoch: 1, rev: 1 } as never
  const view = await mountView(<CurrentOrg.Provider value="fixture"><DocketModal slug="fixture" tree={tree} toast={() => {}} close={() => {}}
    jumpTo="changed-ticket" jumpSeq={1} /></CurrentOrg.Provider>, el => el)
  try {
    await inAct(async () => { await flush(12) })
    assert.match(view.el.querySelector('.docket-pane-head b')?.textContent ?? '', /A ticket that changed/, 'the pane head names the ticket')
    for (const sel of ['objective', 'done_so_far', 'working_on_next', 'evidence.note'])
      assert.ok(view.el.querySelector(`[data-docket-field="${sel}"]`), 'the pane marks ' + sel)
    assert.ok(view.el.querySelector('.overlay .docket-modal.settings'), 'an ordinary unpinned docket is an .overlay .docket-modal.settings')
  } finally { await view.unmount(); globalThis.fetch = realFetch }
})

test('§10 REAL pane: a change deep in a long, clipped description opens the fold, is highlighted and is scrolled to; moving on folds it back', async () => {
  clearTicketSnapshots()
  const realFetch = globalThis.fetch
  const g = globalThis as any
  const para = (n: number) => `Paragraph ${n}: the problem statement, then the solution, then the cases it must handle.`
  const OLD = Array.from({ length: 14 }, (_, i) => para(i + 1)).join('\n\n')
  const NEW = OLD.replace(para(9), para(9) + ' ADDED LATER: the delay goes down to zero.')
  const base = {
    slug: 'long-ticket', title: 'A long ticket', kind: 'code', status: 'in_progress', archived: false, owner: null, participants: [],
    at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T11:00:00Z', docket_at: '2026-11-03T11:00:00Z', done_so_far: [], working_on_next: [],
    questions: [], dependencies: [], history: [], dismissals: [], acceptance: [], effective_attention: false, attention_sources: [], evidence: [],
  }
  const oldItem = { ...base, rev: 3, objective: OLD }, full = { ...base, rev: 4, objective: NEW }
  // the window last showed rev 3; the diff is taken BEFORE the docket mounts, as the route does (the pane records what it shows)
  recordTicketSnapshot('fixture', oldItem as never)
  const change = locateChange(ticketSnapshot('fixture', 'long-ticket'), full as never, 0)
  assert.equal((change as any)?.field, 'objective')
  assert.match((change as any).snippet, /ADDED LATER/)
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = compatibilityWorkFixture((async (input: RequestInfo | URL) => {
    if (String(input).includes('/work-items/long-ticket')) return json({ item: full })
    return json({ items: [full], archived: [], backlogged: [] })
  }) as typeof fetch)
  // jsdom has no layout: give the description a box and one row per text node, so it measures as long and folds
  const E = window.Element.prototype as any, H = window.HTMLElement.prototype as any, R = (window as any).Range.prototype
  const saved = { rect: E.getBoundingClientRect, ow: Object.getOwnPropertyDescriptor(H, 'offsetWidth'), rects: R.getClientRects }
  const rows = new Map<Node, number>()
  E.getBoundingClientRect = function () {
    const top = this.getAttribute?.('data-docket-field') === 'objective' ? 1500 : 0
    return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top }
  }
  Object.defineProperty(H, 'offsetWidth', { configurable: true, get: () => 100 })
  R.getClientRects = function () {
    const n = this.startContainer
    if (!rows.has(n)) rows.set(n, rows.size)
    const top = rows.get(n)! * 20
    return [{ top, bottom: top + 18, left: 0, right: 100, width: 100, height: 18, x: 0, y: top }]
  }
  const marks: string[] = []
  const hadCSS = g.CSS
  g.CSS = { ...(hadCSS ?? {}), highlights: { set: (_n: string, h: any) => marks.push('set:' + h.text), delete: () => marks.push('delete') } }
  g.Highlight = class { text: string; constructor(r: any) { this.text = r.toString() } }
  const tree = { slug: 'fixture', name: 'Fixture', roots: [], asks: [], epoch: 1, rev: 1 } as never
  const view = await mountView(<CurrentOrg.Provider value="fixture"><DocketModal slug="fixture" tree={tree} toast={() => {}} close={() => {}}
    jumpTo="long-ticket" jumpSeq={1} /></CurrentOrg.Provider>, el => el)
  let show: ReturnType<typeof showTicketChange> | null = null
  try {
    await inAct(async () => { await flush(12) })
    const more = () => view.el.querySelector<HTMLElement>('.docket-desc-toggle')
    assert.ok(more(), 'the description is long enough to fold: there is a "show all N lines" control')
    assert.equal(more()!.getAttribute('aria-expanded'), 'false', 'and it starts folded, so paragraph 9 is clipped')
    // the pane's scroll container, as the real stylesheet makes it
    const pane = view.el.querySelector<HTMLElement>('.docket-pane-head')!.parentElement as HTMLElement
    pane.style.overflowY = 'auto'
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 5000 })
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 })
    show = showTicketChange(change, document)
    const len = await show.length
    await inAct(async () => { await flush(6) })
    assert.equal(more()!.getAttribute('aria-expanded'), 'true', 'the clipped description is opened')
    assert.ok(len > 3000, 'a scroll to the change is scheduled (' + len + ' ms)')
    assert.ok(marks.some(m => /ADDED LATER/.test(m)), 'the added text is highlighted: ' + marks.join('|'))
    show.restore()
    await inAct(async () => { await flush(6) })
    assert.equal(more()!.getAttribute('aria-expanded'), 'false', 'folded back on moving on')
    assert.ok(marks.includes('delete'))
  } finally {
    show?.restore()
    await view.unmount()
    E.getBoundingClientRect = saved.rect
    if (saved.ow) Object.defineProperty(H, 'offsetWidth', saved.ow); else delete H.offsetWidth
    if (saved.rects) R.getClientRects = saved.rects; else delete R.getClientRects
    g.CSS = hadCSS; delete g.Highlight
    globalThis.fetch = realFetch
    clearTicketSnapshots()
  }
})

declare const __SRC_DIR__: string
test('§9 the capture fixtures survive automatic semicolon insertion: a line starting with ( [ or a backtick follows a line that ends its statement', () => {
  for (const f of ['attractticket.visual.tsx', 'docketplain.visual.tsx', 'attractidle.visual.tsx']) {
    const lines = fs.readFileSync(path.join(__SRC_DIR__, '..', 'tests', f), 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!/^\s*[(\[`]/.test(line)) return
      // the previous line with code on it
      let j = i - 1
      while (j >= 0 && (!lines[j]!.trim() || /^\s*\/\//.test(lines[j]!))) j--
      const prev = (lines[j] ?? '').trim()
      assert.ok(prev === '' || /[;{,(\[=>:?&|+]$/.test(prev),
        `${f}:${i + 1} starts with ${line.trim().slice(0, 12)} after "${prev.slice(-30)}": prefix it with ; (the fetch assignment above would swallow it)`)
    })
  }
})
