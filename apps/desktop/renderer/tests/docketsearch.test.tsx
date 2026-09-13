// docketsearch.test.tsx — SEARCH IN THE WORK DOCKET
// (add-search-to-the-work-docket).
//
// The panel became hard to navigate as work accumulated, so the header grew a
// query box that narrows the visible ticket list. Four things this suite is
// really defending, because all four are easy to break and none of them is
// visible in a screenshot:
//
//   1. WHAT IS SEARCHED — title, readable slug, the CURRENT description, and
//      the LATEST progress summaries. Nothing else: a hit on text the row does
//      not show reads as a false positive.
//   2. WHAT IS NOT REACHED — a query may never find a backlogged or archived
//      ticket whose box is unticked. Search narrows what is already shown; it
//      is not a second way into a category the reader switched off.
//   3. WHAT SURVIVES A CLEAR — the list, the selection, both folds, the
//      arrangement, the sort and the two filters. Search writes none of them,
//      which is why clearing restores rather than rebuilds.
//   4. WHAT A KEYSTROKE COSTS — no request, and no re-normalising of any
//      description. The item text is built once per item and reused.
import './harness'
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  DocketModal, filterItems, makeHaystack, matchesTerms, queryTerms, searchText,
} from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

// the panel scrolls a flashed row into view; jsdom has no layout
window.HTMLElement.prototype.scrollIntoView = () => {}

interface Call { method: string; url: string }

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'an-item', rev: 1, kind: 'code', title: 'An item',
  objective: 'A description.', status: 'in_progress', blocked_reason: null,
  archived: false, archived_at: null,
  owner: { node: 'agent1', generation: 1 }, owner_current: true,
  owner_state: 'live', reviewer: null, participants: [],
  created_by: { node: 'agent1', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'agent1', generation: 1 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [],
  ...o,
} as WorkItem)

const TREE: TreePayload = {
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [],
} as unknown as TreePayload

function mock(active: WorkItem[], archived: WorkItem[] = [],
              backlogged: WorkItem[] = []): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = String(url)
      calls.push({ method, url: path })
      const headers = new Headers()
      const ok = (payload: unknown) => Promise.resolve(
        { ok: true, status: 200, headers, json: () => Promise.resolve(payload) })
      if (method === 'GET' && path.includes('/work-items')) {
        return ok({
          items: active, archived, backlogged,
          counts: { attention: 0, active: active.length,
                    archived: archived.length, backlogged: backlogged.length },
          now: '2026-09-05T10:00:00.000Z',
        })
      }
      return ok({})
    }) as typeof fetch
  return calls
}

// ---- reading the rendered panel
const rows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow.docket-row')]
const names = (el: HTMLElement) =>
  rows(el).map((r) => r.querySelector('.l1 .mfrom')?.textContent ?? '')
const box = (el: HTMLElement) =>
  el.querySelector('.docket-search-input') as HTMLInputElement
const clearBtn = (el: HTMLElement) =>
  el.querySelector('.docket-search-clear') as HTMLButtonElement | null
const countText = (el: HTMLElement) =>
  el.querySelector('.docket-search-count')?.textContent ?? ''
const archivedBox = (el: HTMLElement) =>
  el.querySelector('.docket-showarchived input') as HTMLInputElement
const backlogBox = (el: HTMLElement) =>
  el.querySelector('.docket-showbacklog input') as HTMLInputElement
const groupSelect = (el: HTMLElement) =>
  el.querySelector('#docket-group') as HTMLSelectElement
const headings = (el: HTMLElement) =>
  [...el.querySelectorAll('.docket-group-head > span:first-child')]
    .map((h) => h.textContent ?? '')

/** type into the controlled input the way React sees a real keystroke */
async function type(el: HTMLElement, value: string) {
  const field = box(el)
  await inAct(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush()
}

async function press(target: HTMLElement, key: string) {
  await inAct(() => {
    target.dispatchEvent(new window.KeyboardEvent(
      'keydown', { key, bubbles: true, cancelable: true }))
  })
  await flush()
}

async function tick(input: HTMLInputElement) {
  await inAct(() => input.click())
  await flush()
}

async function chooseGroup(el: HTMLElement, value: string) {
  await inAct(() => {
    const sel = groupSelect(el)
    sel.value = value
    sel.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await flush()
}

/** ⚠ A FOLDED CATEGORY STILL HAS ITS ROWS IN THE DOM — the section is hidden
 *  with the `hidden` attribute, which jsdom honours for layout it does not do
 *  and not for `querySelectorAll`. So "is this group folded?" has to be asked
 *  of the container, never of whether the rows can be found. */
const sectionOf = (el: HTMLElement, slug: string) =>
  rows(el).find((r) => r.textContent?.includes(slug))
    ?.closest('.docket-section') ?? null
const isFolded = (el: HTMLElement, slug: string) =>
  Boolean(sectionOf(el, slug)
    ?.querySelector('.docket-category-rows')?.hasAttribute('hidden'))
const foldToggle = (el: HTMLElement, heading: string) =>
  [...el.querySelectorAll('.docket-category-toggle')]
    .find((b) => (b.getAttribute('aria-label') ?? '').includes(heading)) as
      HTMLElement | undefined

/** the arrangement is a PERSISTED preference — a test that leans on the
 *  default has to clear it, or it silently inherits the previous test's */
const forgetArrangement = () => {
  window.localStorage.removeItem('orgtree.docket.group')
  window.localStorage.removeItem('orgtree.docket.sort')
}

function rig(name: string, body: (k: {
  mount: (extra?: { close?: () => void }) => Promise<HTMLElement>
}) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    forgetArrangement()
    let open: { unmount: () => Promise<void> } | null = null
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    await body({
      mount: async (extra) => {
        const view = await mountView(
          <DocketModal slug="org1" toast={() => {}} jumpTo={null} tree={TREE}
            close={extra?.close ?? (() => {})} />, (host) => host)
        open = view
        await flush()
        return view.el
      },
    })
  })
}

// ===========================================================================
// THE PURE MATCHER — units, so the rules are pinned independently of any DOM
// ===========================================================================

test('§1 searchText covers exactly the four field groups the ticket names', () => {
  const text = searchText(mkItem({
    title: 'Add Search', slug: 'add-search', objective: 'A DESCRIPTION here.',
    done_so_far: ['Wrote the matcher'], working_on_next: ['Wire the header'],
  }))
  for (const phrase of ['add search', 'add-search', 'a description here.',
                        'wrote the matcher', 'wire the header']) {
    assert.ok(text.includes(phrase), `expected the haystack to carry ${phrase}`)
  }
  // ⚠ AND NOTHING ELSE. A hit on text the row does not show is a match the
  // reader cannot explain, so the owner, the status and the blocked reason are
  // deliberately absent.
  const wider = searchText(mkItem({
    title: 'T', slug: 's', objective: 'o',
    status: 'deploy_ready', blocked_reason: 'waiting on the installer',
    owner: { node: 'some-agent', generation: 1 },
  }))
  assert.ok(!wider.includes('deploy_ready'))
  assert.ok(!wider.includes('installer'))
  assert.ok(!wider.includes('some-agent'))
})

test('§2 the haystack is lowercased once, so matching is case-insensitive', () => {
  const text = searchText(mkItem({ title: 'MiXeD CaSe TiTlE' }))
  assert.equal(text.includes('mixed case title'), true)
  assert.equal(matchesTerms(text, queryTerms('MIXED')), true)
  assert.equal(matchesTerms(text, queryTerms('mIxEd')), true)
})

test('§3 several words mean ALL of them, in any order and across fields', () => {
  const text = searchText(mkItem({
    title: 'Add search to the Work Docket',
    objective: 'Keyboard behavior matters.',
  }))
  // the reader types what they remember, not the exact phrase
  assert.equal(matchesTerms(text, queryTerms('search docket')), true)
  assert.equal(matchesTerms(text, queryTerms('docket search')), true)
  // ...and a term may come from a different field than its neighbour
  assert.equal(matchesTerms(text, queryTerms('search keyboard')), true)
  // every term has to be present — this is AND, not OR
  assert.equal(matchesTerms(text, queryTerms('search nonsense')), false)
  // a single word is still a plain substring, including mid-word
  assert.equal(matchesTerms(text, queryTerms('ocke')), true)
})

test('§4 an empty query is not an empty result — and returns the SAME array', () => {
  const items = [mkItem({ slug: 'a' }), mkItem({ slug: 'b' })]
  const hay = makeHaystack()
  assert.deepEqual(queryTerms('   '), [])
  assert.equal(matchesTerms('anything', []), true)
  // ⚠ IDENTITY, NOT JUST EQUALITY. The unsearched docket must be the exact
  // array the rest of the panel already derives from, or turning search off
  // would quietly invalidate every downstream memo.
  assert.equal(filterItems(items, [], hay), items)
})

test('§5 filterItems preserves the order it was handed', () => {
  const items = ['c-one', 'a-two', 'b-three'].map((slug) =>
    mkItem({ slug, title: slug }))
  const hay = makeHaystack()
  assert.deepEqual(
    filterItems(items, queryTerms('e'), hay).map((i) => i.slug),
    ['c-one', 'a-two', 'b-three'])
})

test('§6 makeHaystack builds an item\'s text ONCE and reuses it', () => {
  const hay = makeHaystack()
  const item = mkItem({ title: 'Original title' })
  assert.ok(hay(item).includes('original title'))
  // A recomputation would pick this up; the cache must not. (Nothing mutates a
  // polled item in the real panel — this is how the test observes the cache at
  // all, without reaching inside it.)
  ;(item as { title: string }).title = 'Rewritten title'
  assert.ok(hay(item).includes('original title'))
  assert.ok(!hay(item).includes('rewritten title'))
  // ...and a DIFFERENT object is a different entry, which is what makes the
  // next poll's replacement rows correct rather than stale.
  assert.ok(hay(mkItem({ title: 'Rewritten title' })).includes('rewritten title'))
})

// ===========================================================================
// THE CONTROL IN THE PANEL
// ===========================================================================

rig('§7 the search box is a labelled control with a search landmark', async (k) => {
  mock([mkItem({ slug: 'only-one', title: 'Only one' })])
  const el = await k.mount()
  const field = box(el)
  assert.ok(field, 'the header carries a search input')
  assert.equal(field.getAttribute('type'), 'search')
  // it has no visible <label>, so the accessible name has to come from here —
  // a placeholder is not a name, it disappears the moment anything is typed
  const label = field.getAttribute('aria-label') ?? ''
  assert.match(label, /search/i)
  for (const field_name of ['title', 'description', 'progress']) {
    assert.match(label.toLowerCase(), new RegExp(field_name))
  }
  assert.ok(el.querySelector('[role="search"]'), 'a search landmark names the group')
  // the live region exists BEFORE it has anything to say — one created at the
  // moment its content appears is not reliably announced
  const live = el.querySelector('.docket-search-count')!
  assert.equal(live.getAttribute('aria-live'), 'polite')
  assert.equal(live.getAttribute('role'), 'status')
  assert.equal(live.textContent, '')
  assert.equal(field.getAttribute('aria-describedby'), live.id)
})

rig('§8 the list narrows as the query changes, by title', async (k) => {
  mock([
    mkItem({ slug: 'add-search-to-the-docket', title: 'Add search to the docket' }),
    mkItem({ slug: 'fix-the-installer', title: 'Fix the installer' }),
    mkItem({ slug: 'rename-the-history', title: 'Rename the history' }),
  ])
  const el = await k.mount()
  assert.equal(rows(el).length, 3)
  await type(el, 'search')
  assert.deepEqual(names(el), ['add-search-to-the-docket'])
  // narrowing FURTHER is still live, not a submit
  await type(el, 'search installer')
  assert.equal(rows(el).length, 0)
  await type(el, 'installer')
  assert.deepEqual(names(el), ['fix-the-installer'])
})

rig('§9 CASE IS IGNORED, and the slug matches as well as the title', async (k) => {
  mock([
    mkItem({ slug: 'redesign-api-key-inference', title: 'Redesign key inference' }),
    mkItem({ slug: 'fix-the-installer', title: 'Fix the installer' }),
  ])
  const el = await k.mount()
  await type(el, 'REDESIGN')
  assert.deepEqual(names(el), ['redesign-api-key-inference'])
  // the readable slug is the ticket's only identifier, so it has to be
  // findable by the hyphenated form somebody copied out of a message
  await type(el, 'api-key')
  assert.deepEqual(names(el), ['redesign-api-key-inference'])
})

rig('§10 the CURRENT description and the LATEST progress both match', async (k) => {
  mock([
    mkItem({ slug: 'by-description', title: 'Alpha',
             objective: 'The renderer must stay responsive on a large docket.' }),
    mkItem({ slug: 'by-done', title: 'Beta',
             done_so_far: ['Rebased onto the landing slot'] }),
    mkItem({ slug: 'by-next', title: 'Gamma',
             working_on_next: ['Freeze an exact candidate sha'] }),
    mkItem({ slug: 'by-nothing', title: 'Delta' }),
  ])
  const el = await k.mount()
  await type(el, 'responsive')
  assert.deepEqual(names(el), ['by-description'])
  await type(el, 'landing slot')
  assert.deepEqual(names(el), ['by-done'])
  await type(el, 'candidate sha')
  assert.deepEqual(names(el), ['by-next'])
})

rig('§11 the match readout counts only the enabled views', async (k) => {
  mock(
    [mkItem({ slug: 'active-hit', title: 'Search me' }),
     mkItem({ slug: 'active-miss', title: 'Not me' })],
    [mkItem({ slug: 'archived-hit', title: 'Search me too', archived: true })])
  const el = await k.mount()
  assert.equal(countText(el), '', 'silent until there is a query')
  await type(el, 'search')
  // 2 active rows are searchable; the archived one is not, because its box is
  // off — and the denominator must not count it either
  assert.equal(countText(el), '1 of 2 match')
  await tick(archivedBox(el))
  assert.equal(countText(el), '2 of 3 match')
})

// ===========================================================================
// WHAT SEARCH MAY NOT REACH
// ===========================================================================

rig('§12 a query NEVER reaches a category whose box is unticked', async (k) => {
  mock(
    [mkItem({ slug: 'active-widget', title: 'Widget in flight' })],
    [mkItem({ slug: 'archived-widget', title: 'Widget long done', archived: true })],
    [mkItem({ slug: 'backlogged-widget', title: 'Widget not started',
              status: 'backlogged' })])
  const el = await k.mount()
  await type(el, 'widget')
  assert.deepEqual(names(el), ['active-widget'],
                   'the hidden groups stay hidden, query or no query')
  await tick(backlogBox(el))
  assert.deepEqual(names(el).sort(), ['active-widget', 'backlogged-widget'])
  await tick(archivedBox(el))
  assert.deepEqual(names(el).sort(),
                   ['active-widget', 'archived-widget', 'backlogged-widget'])
  // ...and unticking takes it straight back out of the results
  await tick(archivedBox(el))
  assert.deepEqual(names(el).sort(), ['active-widget', 'backlogged-widget'])
})

rig('§13 an empty result SAYS it is the query, not that the org is empty', async (k) => {
  mock([mkItem({ slug: 'something', title: 'Something' })])
  const el = await k.mount()
  await type(el, 'zzzznothing')
  assert.equal(rows(el).length, 0)
  const text = el.textContent ?? ''
  assert.match(text, /no items match/)
  assert.match(text, /zzzznothing/)
  assert.ok(!/no work items yet/.test(text),
            '"nothing matched" must not claim the docket is empty')
  // and it points at the two boxes that are excluding work from the search
  assert.match(text, /backlogged and archived/)
})

rig('§14 the two appended groups stay LAST while a query is active', async (k) => {
  mock(
    [mkItem({ slug: 'active-widget', title: 'Widget one' })],
    [mkItem({ slug: 'archived-widget', title: 'Widget two', archived: true })],
    [mkItem({ slug: 'backlogged-widget', title: 'Widget three',
              status: 'backlogged' })])
  const el = await k.mount()
  await tick(backlogBox(el))
  await tick(archivedBox(el))
  await type(el, 'widget')
  const heads = headings(el)
  assert.equal(heads[heads.length - 2], 'Backlogged — not yet approached')
  assert.equal(heads[heads.length - 1], 'Archived')
})

// ===========================================================================
// WHAT SURVIVES A CLEAR
// ===========================================================================

rig('§15 clearing restores the EXACT prior list, selection and filters', async (k) => {
  mock(
    [mkItem({ slug: 'alpha-one', title: 'Alpha one' }),
     mkItem({ slug: 'beta-two', title: 'Beta two' }),
     mkItem({ slug: 'gamma-three', title: 'Gamma three' })],
    [mkItem({ slug: 'delta-archived', title: 'Delta archived', archived: true })])
  const el = await k.mount()
  await tick(archivedBox(el))
  // an arrangement the reader chose, and a row they selected
  await chooseGroup(el, 'agent')
  await inAct(() => {
    (rows(el).find((r) => r.textContent?.includes('beta-two')) as HTMLElement)
      .click()
  })
  await flush()
  const before = names(el)
  const headsBefore = headings(el)
  assert.ok((el.querySelector('.mailer-read')?.textContent ?? '')
    .includes('Beta two'))

  await type(el, 'alpha')
  assert.deepEqual(names(el), ['alpha-one'])
  // ⚠ THE SELECTION IS NOT DESTROYED BY BEING FILTERED OUT. The detail pane
  // reads the full item map, not the visible rows, so the reader can search
  // without losing what they were reading.
  assert.ok((el.querySelector('.mailer-read')?.textContent ?? '')
    .includes('Beta two'))

  await type(el, '')
  assert.deepEqual(names(el), before, 'the same rows, in the same order')
  assert.deepEqual(headings(el), headsBefore, 'the same grouping')
  assert.equal(archivedBox(el).checked, true, 'the archive filter is untouched')
  assert.equal(groupSelect(el).value, 'agent', 'the arrangement is untouched')
  assert.ok((el.querySelector('.mailer-read')?.textContent ?? '')
    .includes('Beta two'), 'and the selection is still the reader\'s')
})

rig('§16 a search renders THROUGH a collapsed category without clearing it',
    async (k) => {
  mock([
    mkItem({ slug: 'blocked-widget', title: 'Widget blocked', status: 'blocked' }),
    mkItem({ slug: 'open-widget', title: 'Widget open', status: 'open' }),
  ])
  const el = await k.mount()
  await chooseGroup(el, 'status')
  // fold the Blocked group away
  const toggle = foldToggle(el, 'Blocked')!
  assert.ok(toggle, 'the Blocked group has a fold control')
  await inAct(() => toggle.click())
  await flush()
  assert.equal(isFolded(el, 'blocked-widget'), true, 'folded away to begin with')

  await type(el, 'widget')
  assert.equal(isFolded(el, 'blocked-widget'), false,
               'a match inside a folded group is shown, or the search is a lie')
  assert.ok(names(el).includes('blocked-widget'))

  await type(el, '')
  assert.equal(isFolded(el, 'blocked-widget'), true,
               'and the fold is exactly as the reader left it')
  assert.equal(foldToggle(el, 'Blocked')!.getAttribute('aria-expanded'), 'false',
               'the fold was BYPASSED for the query, never cleared')
})

rig('§17 a search renders THROUGH a collapsed ancestor without clearing it',
    async (k) => {
  mock([
    mkItem({ slug: 'parent-task', title: 'Parent task' }),
    mkItem({ slug: 'child-widget', title: 'Child widget',
             parent: 'parent-task' } as Partial<WorkItem>),
  ])
  const el = await k.mount()
  assert.deepEqual(names(el).sort(), ['child-widget', 'parent-task'])
  const fold = el.querySelector('.docket-fold') as HTMLElement
  assert.ok(fold, 'the parent row has a subtree fold control')
  await inAct(() => fold.click())
  await flush()
  assert.deepEqual(names(el), ['parent-task'], 'the child is folded away')

  await type(el, 'widget')
  assert.deepEqual(names(el), ['child-widget'],
                   'the match is shown even though its parent is collapsed')

  await type(el, '')
  assert.deepEqual(names(el), ['parent-task'],
                   'and the subtree fold is exactly as the reader left it')
})

rig('§17b the fold arrow never contradicts what is on screen', async (k) => {
  // ⚠ BOTH ROWS MATCH THE QUERY, deliberately: the arrow only exists while the
  // parent still has a child in the filtered section, and this test is about
  // what the arrow SAYS, not about when it appears.
  mock([
    mkItem({ slug: 'parent-widget', title: 'Parent widget' }),
    mkItem({ slug: 'child-widget', title: 'Child widget',
             parent: 'parent-widget' } as Partial<WorkItem>),
  ])
  const el = await k.mount()
  const arrow = () => el.querySelector('.docket-fold') as HTMLButtonElement
  await inAct(() => arrow().click())
  await flush()
  assert.equal(arrow().getAttribute('aria-expanded'), 'false')
  assert.equal(arrow().disabled, false)
  assert.deepEqual(names(el), ['parent-widget'], 'the child is folded away')

  // the search draws the subtree regardless of the fold, so a caret still
  // reporting "collapsed" would tell a screen reader the opposite of the truth
  await type(el, 'widget')
  assert.deepEqual(names(el).sort(), ['child-widget', 'parent-widget'])
  assert.equal(arrow().getAttribute('aria-expanded'), 'true',
               'the arrow describes what is rendered, not the fold set')
  assert.equal(arrow().disabled, true,
               'and it is disabled rather than clickable-but-inert')
  assert.match(arrow().getAttribute('title') ?? '', /search/i,
               'a disabled control has to say why')

  await type(el, '')
  assert.equal(arrow().getAttribute('aria-expanded'), 'false',
               'the reader\'s fold is handed straight back')
  assert.equal(arrow().disabled, false)
  assert.deepEqual(names(el), ['parent-widget'])
})

// ===========================================================================
// KEYBOARD AND THE CLEAR ACTION
// ===========================================================================

// ---------------------------------------------------------------------------
// NO SECOND ROUTE INTO A FOLD WHILE SEARCHING (coordinator review of 7f265fc).
//
// The first cut locked only the row's visible ARROW. Two other controls still
// reached the same state: the category heading's toggle, and the row context
// menu's Show/Hide entry. Neither could change a rendered row during a query —
// which is exactly what made them dangerous: they appeared to do nothing while
// rewriting the fold the reader gets back when they clear the box.
// ---------------------------------------------------------------------------

rig('§17c the CATEGORY fold cannot be mutated during a search', async (k) => {
  mock([
    mkItem({ slug: 'blocked-widget', title: 'Widget blocked', status: 'blocked' }),
    mkItem({ slug: 'open-widget', title: 'Widget open', status: 'open' }),
  ])
  const el = await k.mount()
  await chooseGroup(el, 'status')
  // the reader's posture: Blocked folded away, Open left open
  await inAct(() => foldToggle(el, 'Blocked')!.click())
  await flush()
  assert.equal(isFolded(el, 'blocked-widget'), true)
  assert.equal(isFolded(el, 'open-widget'), false)

  await type(el, 'widget')
  const toggle = foldToggle(el, 'Blocked') as HTMLButtonElement
  assert.equal(toggle.disabled, true,
               'the control cannot change a rendered row, so it must not pretend to')
  assert.match(toggle.getAttribute('title') ?? '', /search/i,
               'a disabled control has to say why')

  // ⚠ THE REAL ASSERTION. Drive the click anyway — a disabled button ignores a
  // real user click, but this proves the STORED fold is untouched even if some
  // other route reached the handler.
  await inAct(() => toggle.click())
  await flush()
  assert.equal(isFolded(el, 'blocked-widget'), false,
               'still showing every match, as the search requires')

  await type(el, '')
  assert.equal(isFolded(el, 'blocked-widget'), true,
               'the reader gets back the EXACT fold they left — a click during '
               + 'the search must not have rewritten it')
  assert.equal(isFolded(el, 'open-widget'), false,
               'and the group they did not fold is still unfolded')
})

rig('§17d the row context menu cannot mutate the subtree fold during a search',
    async (k) => {
  mock([
    mkItem({ slug: 'parent-widget', title: 'Parent widget' }),
    mkItem({ slug: 'child-widget', title: 'Child widget',
             parent: 'parent-widget' } as Partial<WorkItem>),
  ])
  const el = await k.mount()
  const parentRow = () =>
    rows(el).find((r) => r.textContent?.includes('parent-widget')) as HTMLElement
  const openMenu = async () => {
    await inAct(() => parentRow().dispatchEvent(new window.MouseEvent(
      'contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })))
    await flush()
    return [...document.querySelectorAll('.ctxmenu button, [role="menuitem"]')]
      .map((b) => b.textContent ?? '')
  }
  const closeMenu = async () => {
    await inAct(() => document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await flush()
  }

  // NOT SEARCHING: the fold entry is offered, exactly as it always was
  const before = await openMenu()
  assert.ok(before.some((l) => /sub-item/.test(l)),
            'the menu still offers the fold when no query is active')
  await closeMenu()

  await type(el, 'widget')
  const during = await openMenu()
  assert.ok(!during.some((l) => /sub-item/.test(l)),
            'the fold entry is withdrawn — it is a SECOND route to onFold and '
            + 'would rewrite the fold the reader gets back on clear')
  // the rest of the menu is untouched: this suppresses one entry, not the menu
  assert.ok(during.some((l) => /Copy slug/i.test(l)),
            'suppressing the fold entry must not disable the whole menu')
  await closeMenu()

  await type(el, '')
  const after = await openMenu()
  assert.ok(after.some((l) => /sub-item/.test(l)),
            'and it comes straight back when the query is cleared')
  assert.deepEqual(names(el).sort(), ['child-widget', 'parent-widget'],
                   'with the subtree fold exactly as it was left: untouched')
  await closeMenu()
})

rig('§18 the clear button exists only when there is something to clear, and '
    + 'returns focus to the box', async (k) => {
  mock([mkItem({ slug: 'alpha-one', title: 'Alpha one' }),
        mkItem({ slug: 'beta-two', title: 'Beta two' })])
  const el = await k.mount()
  assert.equal(clearBtn(el), null, 'no live-looking control with nothing to do')
  await type(el, 'alpha')
  const btn = clearBtn(el)!
  assert.ok(btn, 'the clear action appears with the query')
  assert.match(btn.getAttribute('aria-label') ?? '', /clear/i)
  await inAct(() => btn.click())
  await flush()
  assert.equal(box(el).value, '')
  assert.equal(rows(el).length, 2, 'the whole list is back')
  assert.equal(document.activeElement, box(el),
               'focus must not be stranded on a button that just vanished')
})

rig('§19 Escape in a non-empty box clears the query and LEAVES THE PANEL OPEN',
    async (k) => {
  mock([mkItem({ slug: 'alpha-one', title: 'Alpha one' }),
        mkItem({ slug: 'beta-two', title: 'Beta two' })])
  let closed = 0
  const el = await k.mount({ close: () => { closed += 1 } })
  await type(el, 'alpha')
  await inAct(() => box(el).focus())
  await press(box(el), 'Escape')
  assert.equal(closed, 0, 'the reader meant to clear the query, not lose the panel')
  assert.equal(box(el).value, '')
  assert.equal(rows(el).length, 2)
  // ...and with nothing left to clear, Escape is the panel's again
  await press(box(el), 'Escape')
  assert.equal(closed, 1)
})

rig('§20 Escape from OUTSIDE the box still closes the docket, query or not',
    async (k) => {
  mock([mkItem({ slug: 'alpha-one', title: 'Alpha one' })])
  let closed = 0
  const el = await k.mount({ close: () => { closed += 1 } })
  await type(el, 'alpha')
  await inAct(() => (box(el) as HTMLInputElement).blur())
  await press(el, 'Escape')
  assert.equal(closed, 1,
               'Escape with the cursor elsewhere is the panel\'s exit, as everywhere')
  assert.equal(box(el).value, 'alpha', 'and the query is left alone')
})

rig('§21 Enter opens the top result without leaving the box', async (k) => {
  mock([
    mkItem({ slug: 'alpha-one', title: 'Alpha one' }),
    mkItem({ slug: 'beta-widget', title: 'Beta widget' }),
    mkItem({ slug: 'gamma-widget', title: 'Gamma widget' }),
  ])
  const el = await k.mount()
  await type(el, 'widget')
  await inAct(() => box(el).focus())
  await press(box(el), 'Enter')
  const pane = el.querySelector('.mailer-read')?.textContent ?? ''
  assert.match(pane, /Beta widget/)
  assert.ok(!/Gamma widget/.test(pane))
  assert.equal(document.activeElement, box(el),
               'refining the query and reading the hit are one gesture')
})

// ===========================================================================
// WHAT A KEYSTROKE COSTS
// ===========================================================================

test('§22 typing issues NO request — the searched fields are already resident',
     async (t: TestContext) => {
  useFakeClock()
  forgetArrangement()
  let open: { unmount: () => Promise<void> } | null = null
  t.after(async () => { try { await open?.unmount() } finally { realClock() } })
  const many = Array.from({ length: 40 }, (_, i) =>
    mkItem({ slug: `ticket-${i}`, title: `Ticket ${i}`,
             objective: `Objective number ${i}.` }))
  const calls = mock(many)
  const view = await mountView(
    <DocketModal slug="org1" toast={() => {}} close={() => {}} jumpTo={null}
      tree={TREE} />, (host) => host)
  open = view
  await flush()
  const before = calls.length
  for (const q of ['t', 'ti', 'tic', 'tick', 'ticke', 'ticket', 'ticket 1']) {
    await type(view.el, q)
  }
  assert.equal(calls.length, before,
               'a keystroke is a filter over resident data, never a fetch')
  assert.ok(rows(view.el).length > 0 && rows(view.el).length < many.length,
            'and it did actually narrow the list')
})

test('§23 a large docket stays responsive: one pass per keystroke over '
     + 'already-built text', () => {
  // ⚠ THE DESCRIPTIONS ARE BIG ON PURPOSE. If the item text were rebuilt per
  // keystroke this loop would re-lowercase ~6 MB of prose thirty times over;
  // built once per item it is thirty passes of cheap substring tests. The
  // budget below is deliberately loose — the point is the ORDER OF MAGNITUDE,
  // not a stopwatch.
  const N = 3000
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40)
  const items = Array.from({ length: N }, (_, i) => mkItem({
    slug: `ticket-${i}`, title: `Ticket number ${i}`,
    objective: `${filler} unique-marker-${i}.`,
    done_so_far: [`Completed step ${i}`, filler],
    working_on_next: [`Next step ${i}`],
  }))
  const hay = makeHaystack()
  // the first pass pays for the text, exactly as the first render after a poll
  // does; every pass after it is the keystroke cost this test is about
  filterItems(items, queryTerms('warm'), hay)

  const queries = ['t', 'ti', 'tic', 'tick', 'ticke', 'ticket',
                   'ticket 1', 'ticket 12', 'ticket 123', 'unique-marker-2999']
  const started = process.hrtime.bigint()
  let last = items
  for (let rep = 0; rep < 3; rep++) {
    for (const q of queries) last = filterItems(items, queryTerms(q), hay)
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.deepEqual(last.map((i) => i.slug), ['ticket-2999'],
                   'the measured work has to be real work')
  assert.ok(ms < 1500,
            `${queries.length * 3} queries over ${N} items took ${ms.toFixed(1)}ms`)
})
