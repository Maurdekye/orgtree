// w31b77251 — a slug written in prose is a link to that item.
//
// TWO HALVES, AND BOTH ARE NEEDED. `splitSlugRefs` is pure, so what counts as
// a mention can be pinned exactly — and a pure suite proves nothing about
// whether any surface calls it, so the second half mounts the real DocketModal
// and clicks the real links.
//
// THE FAILURE THIS GUARDS AGAINST IS NOT "no link". It is A LINK TO THE WRONG
// ITEM. Slugs are kebab-case and routinely contain each other
// (`working-status-nudges` inside `working-status-nudges-every-twenty-minutes`),
// so an over-eager matcher sends the reader confidently to the wrong place.
// Every boundary case below is one of those.
//
// Run: cd frontend && node tests/run.mjs docketrefs

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import { buildMentionIndex, splitRefs } from '../src/canvas/workrefs'
import type { RefIndex } from '../src/canvas/workrefs'
import type { TreePayload, WorkItem } from '../src/types'

// ---------------------------------------------------------------- the matcher

const idx = (...slugs: string[]): RefIndex<string> =>
  new Map(slugs.map((s) => [s, s]))

/** what the reader ends up looking at: linked runs marked with «» */
const shape = (text: string, index: RefIndex<unknown>) =>
  splitRefs(text, index).map((p) => (p.ref ? `«${p.text}»` : p.text)).join('')

test('§1 a bare mention becomes a link, and the prose around it is untouched',
  () => {
    const i = idx('git-review-workspace')
    assert.equal(shape('see git-review-workspace for context', i),
      'see «git-review-workspace» for context')
    // the org writes slugs in backticks by convention — that is the COMMON
    // case, not an exclusion
    assert.equal(shape('see `git-review-workspace` now', i),
      'see `«git-review-workspace»` now')
    assert.equal(shape('(git-review-workspace)', i), '(«git-review-workspace»)')
    assert.equal(shape('ends the sentence: git-review-workspace.', i),
      'ends the sentence: «git-review-workspace».')
  })

test('§2 THE WRONG-ITEM CASE: a slug inside a longer slug is never linked alone',
  () => {
    // both are real items; the text names the LONG one
    const i = idx('working-status-nudges', 'working-status-nudges-every-twenty-minutes')
    assert.equal(
      shape('per working-status-nudges-every-twenty-minutes today', i),
      'per «working-status-nudges-every-twenty-minutes» today')
    // …and naming the short one still links the short one
    assert.equal(shape('per working-status-nudges today', i),
      'per «working-status-nudges» today')
    // a short slug sitting at the END of a longer unknown name is not a mention
    assert.equal(shape('see my-working-status-nudges here', i),
      'see my-working-status-nudges here')
    // ⚠ AND AT THE START OF ONE. This is the case longest-first does NOT
    // cover: the surrounding name is not itself an item, so there is no longer
    // alternative to prefer — only the trailing boundary stops the short name
    // from linking. Without this case the whole AFTER rule can be deleted and
    // every other check here stays green (found by mutate_docketrefs.mjs, not
    // by reading).
    assert.equal(shape('the working-status-nudges-branch is stale', i),
      'the working-status-nudges-branch is stale')
    assert.equal(shape('working-status-nudges/notes', i),
      'working-status-nudges/notes')
    assert.equal(shape('working-status-nudges:v2', i),
      'working-status-nudges:v2')
  })

test('§3 URLs, paths and dotted identifiers are not mentions', () => {
  const i = idx('clickable-docket-references', 'my-module')
  assert.equal(shape('https://x.dev/clickable-docket-references ok', i),
    'https://x.dev/clickable-docket-references ok')
  assert.equal(shape('src/clickable-docket-references/index.ts', i),
    'src/clickable-docket-references/index.ts')
  assert.equal(shape('my-module.json holds it', i), 'my-module.json holds it')
  assert.equal(shape('a.my-module thing', i), 'a.my-module thing')
  assert.equal(shape('branch:my-module', i), 'branch:my-module')
  // the positive control for this whole test: the same names DO link when they
  // stand alone, so "nothing linked" cannot be the reason it passes
  assert.equal(shape('my-module and clickable-docket-references', i),
    '«my-module» and «clickable-docket-references»')
})

test('§4 a name nobody in this org has is left as prose', () => {
  // ORG ISOLATION IS BY CONSTRUCTION: the index is built from the items this
  // org served, so a name from somewhere else is simply absent from it.
  assert.equal(shape('see some-other-orgs-item now', idx('mine-only')),
    'see some-other-orgs-item now')
  assert.equal(shape('nothing to link here', new Map()), 'nothing to link here')
})

test('§5 every character of the input survives the split', () => {
  const i = idx('a-b', 'a-b-c')
  const samples = [
    '', 'a-b', '  a-b  ', 'a-b a-b-c a-b', 'x a-b\n\n  a-b-c\ty',
    'a-b-c-d', '-a-b-', 'a-ba-b', 'a-b.a-b', '((a-b))',
  ]
  for (const s of samples) {
    assert.equal(splitRefs(s, i).map((p) => p.text).join(''), s,
      `round trip lost or changed text for ${JSON.stringify(s)}`)
  }
})

test('§6 an item with no slug contributes nothing to the index', () => {
  const items = [
    { slug: 'has-a-name' },
    { slug: null },
    // an empty slug would compile into the alternation as an empty branch,
    // which matches at every position — the scanner would never terminate
    { slug: '' },
  ] as unknown as WorkItem[]
  const index = buildMentionIndex(items)
  assert.deepEqual([...index.keys()], ['has-a-name'])
  assert.equal(shape('w2 and w3 are unnamed', index), 'w2 and w3 are unnamed')
})

// --------------------------------------------------------- the real panel

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

/** `roots` matters for more than the model chips now: a node MAILBOX is only
 *  addressable if the node is in this tree, so a fixture that wants a live
 *  node-inbox reference has to put the node here. */
const mkTree = (roots: unknown[] = []): TreePayload => ({
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1, roots,
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

/** what the document endpoint does for one id. `'never'` is the IN-FLIGHT
 *  case — a promise that never settles — which is the only way to hold the
 *  reader in its loading state long enough to assert on it. */
type DocReply = { title: string; node: string; body: string; at: string }
  | { error: string } | 'never'

interface Served {
  items: WorkItem[]; archived: WorkItem[]; backlogged: WorkItem[]
  /** id → reply. An id that is not here 404s, which is what the real backend
   *  does for a document this org does not have. */
  docs?: Record<string, DocReply>
}

/** records every work-items URL, so "was the group even asked for" is a fact
 *  this suite can assert rather than assume — and every DOCUMENT url, so
 *  "it fetched the id the token named" is a fact too, rather than "a reader
 *  appeared". */
function mockServer(s: Served) {
  const urls: string[] = []
  const docUrls: string[] = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => {
      const path = String(url)
      const ok = (payload: unknown) => Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(payload),
      })
      if (path.includes('/documents/')) {
        docUrls.push(path)
        const id = path.split('/').pop() as string
        const reply = s.docs?.[id]
        if (reply === 'never') return new Promise(() => {})
        if (!reply || 'error' in reply) {
          return Promise.resolve({
            ok: false, status: 404, headers: new Headers(),
            statusText: 'Not Found',
            json: () => Promise.resolve({
              detail: reply ? reply.error : 'no such document' }),
          })
        }
        return ok({ id, ...reply })
      }
      if (path.includes('/work-items')) {
        urls.push(path)
        return ok({
          items: s.items,
          ...(path.includes('archived=1') ? { archived: s.archived } : {}),
          ...(path.includes('backlogged=1') ? { backlogged: s.backlogged } : {}),
          counts: {
            attention: 0, active: s.items.length,
            archived: s.archived.length, backlogged: s.backlogged.length,
          },
          now: '2026-09-05T10:00:00.000Z',
        })
      }
      return ok({})
    }) as unknown as typeof fetch
  return Object.assign(urls, { docUrls })
}

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<HTMLElement>) => Promise<void>) {
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

const modal = () => (
  <DocketModal slug="org1" toast={() => {}} close={() => {}} tree={mkTree()} />
)
const rows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow.docket-row')]
const names = (el: HTMLElement) =>
  rows(el).map((r) => r.querySelector('.l1 .mfrom')?.textContent ?? '')
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')
const refs = (el: HTMLElement) =>
  [...(pane(el)?.querySelectorAll('.docket-ref') ?? [])] as HTMLElement[]
const backlogBox = (el: HTMLElement) =>
  el.querySelector('.docket-showbacklog input') as HTMLInputElement
const archivedBox = (el: HTMLElement) =>
  el.querySelector('.docket-showarchived input') as HTMLInputElement

const TARGET = mkItem({
  slug: 'clickable-docket-references',
  title: 'Clickable docket references across text surfaces',
  docket_at: '2026-09-05T08:30:00.000Z',
})

async function openFirst(el: HTMLElement) {
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
}

uiTest('§7 a mention in the DESCRIPTION is a link, and the sentence still reads',
  async (mount) => {
    mockServer({
      items: [
        mkItem({ slug: 'explain-unavailable-actions',
          title: 'Explain unavailable actions',
          objective: 'blocked behind clickable-docket-references until the '
            + 'renderer exists.' }),
        TARGET,
      ],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await openFirst(el)

    const link = refs(el)
    assert.equal(link.length, 1, 'the description mention did not become a link')
    assert.equal(link[0]!.textContent, 'clickable-docket-references')
    // ⚠ THE PROSE MUST BE INTACT. A linkifier that drops or reorders the words
    // around the match has broken the thing it was decorating.
    assert.equal(
      pane(el)?.querySelector('.docket-desc-body')?.textContent,
      'blocked behind clickable-docket-references until the renderer exists.')
  })

uiTest('§8 mentions in PROGRESS entries and in an attention reason link too',
  async (mount) => {
    mockServer({
      items: [
        mkItem({ slug: 'explain-unavailable-actions', title: 'A',
          objective: 'no mention here',
          done_so_far: ['landed ahead of clickable-docket-references'],
          working_on_next: ['then clickable-docket-references'],
          manual_attention: { reason: 'waiting on clickable-docket-references',
            at: '2026-09-05T09:00:00.000Z',
            by: { node: 'agent1', generation: 1 }, set_rev: 1 },
          effective_attention: true, attention_sources: ['manual'] }),
        TARGET,
      ],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await openFirst(el)
    // three surfaces, one renderer — a fix applied to the description alone
    // would give one link here, not three
    assert.equal(refs(el).length, 3)
    assert.deepEqual(new Set(refs(el).map((r) => r.textContent)),
      new Set(['clickable-docket-references']))
  })

uiTest('§9 clicking a mention selects, reveals and marks the item it names',
  async (mount) => {
    mockServer({
      items: [
        mkItem({ slug: 'explain-unavailable-actions',
          title: 'Explain unavailable actions',
          objective: 'see clickable-docket-references' }),
        TARGET,
      ],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await openFirst(el)
    assert.match(pane(el)?.textContent ?? '', /Explain unavailable actions/)

    await inAct(() => refs(el)[0]!.click())
    await flush()
    // the DETAIL PANE is now the named item — the whole point
    assert.match(pane(el)?.textContent ?? '',
      /Clickable docket references across text surfaces/)
    // and the row it means is marked, because selection alone is easy to miss
    // when the reader's eye is still where the link was
    const marked = rows(el).filter((r) => r.classList.contains('docket-flash'))
    assert.equal(marked.length, 1)
    assert.equal(marked[0]!.querySelector('.l1 .mfrom')?.textContent,
      'clickable-docket-references')
  })

uiTest('§10 a link to a HIDDEN BACKLOG item turns its group on and shows the row',
  async (mount) => {
    const hidden = mkItem({ slug: 'nested-docket-items',
      title: 'Expandable docket items', status: 'backlogged' })
    const urls = mockServer({
      items: [mkItem({ slug: 'explain-unavailable-actions', title: 'A',
        objective: 'design lives in nested-docket-items' })],
      archived: [], backlogged: [hidden],
    })
    const el = await mount(modal())
    await flush()

    // PRECONDITION, ASSERTED: the row really is hidden to start with, so the
    // reveal below is doing something. Without this the test would pass on a
    // panel that showed the backlog all along.
    assert.equal(backlogBox(el).checked, false)
    assert.deepEqual(names(el), ['explain-unavailable-actions'])
    // …and the group WAS fetched anyway — that is what makes the mention
    // linkable at all while its row is filtered out
    assert.ok(urls.every((u) => u.includes('backlogged=1')),
      'the backlog must be fetched even while it is hidden, or a link to it '
      + 'could never be offered')

    await openFirst(el)
    assert.equal(refs(el).length, 1, 'a hidden item was not linkable')
    await inAct(() => refs(el)[0]!.click())
    await flush()

    assert.equal(backlogBox(el).checked, true, 'the hidden group stayed hidden')
    assert.ok(names(el).includes('nested-docket-items'),
      'the revealed row never appeared in the list')
    assert.match(pane(el)?.textContent ?? '', /Expandable docket items/)
  })

uiTest('§10b the same for an ARCHIVED item', async (mount) => {
  const gone = mkItem({ slug: 'old-finished-thing',
    title: 'Old finished thing', status: 'done', archived: true })
  mockServer({
    items: [mkItem({ slug: 'explain-unavailable-actions', title: 'A',
      objective: 'superseded old-finished-thing' })],
    archived: [gone], backlogged: [],
  })
  const el = await mount(modal())
  await flush()
  assert.equal(archivedBox(el).checked, false)
  await openFirst(el)
  await inAct(() => refs(el)[0]!.click())
  await flush()
  assert.equal(archivedBox(el).checked, true)
  assert.ok(names(el).includes('old-finished-thing'))
  assert.match(pane(el)?.textContent ?? '', /Old finished thing/)
})

uiTest('§11 a name this org does not have stays prose, and nothing is clickable',
  async (mount) => {
    mockServer({
      items: [mkItem({ slug: 'explain-unavailable-actions', title: 'A',
        objective: 'see some-other-orgs-item and w2ffffff' })],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await openFirst(el)
    assert.equal(refs(el).length, 0)
    assert.equal(pane(el)?.querySelector('.docket-desc-body')?.textContent,
      'see some-other-orgs-item and w2ffffff')
  })

// §12 IS GONE ON PURPOSE. It pinned "an item served with slug: null is never
// linked", and the server can no longer serve such an item at all — a document
// still holding the retired opaque key is refused whole (409) rather than
// served with some items unnamed. The defensive half of that check survives in
// §6, which still proves buildSlugIndex drops a null or empty name rather than
// compiling an empty branch into the matcher.

// ------------------------------------- w2d5fab0a, the two elements that need
// ------------------------------------- no parent relation to exist

// ⚠ §13 IS GONE, NOT REWRITTEN. It read the status dot in the row's name line
// ("the status dot follows the status, and ATTENTION outranks it"), and the
// user removed that dot on 2026-09-06 to give the width to long slug names.
// The PRECEDENCE it cared about — a flagged row reads as attention whatever its
// status says — is not lost: it is one expression, and docket.test.tsx checks
// it on both surviving readings (the row's `attention` class and the status
// word) at §4, §11, §11b and §26, the last of which is the same precedence over
// a status that would otherwise style the row. Repointing this check at those
// would have been another copy of that assertion, not new coverage.

uiTest('§14 the two progress lists are marked as different kinds of line',
  async (mount) => {
    // jsdom applies no stylesheet, so the BULLETS themselves are proven in the
    // browser probe (docket_layout_probe.py, controls `samebullet`/`onedot`).
    // What is checkable here is that the two lists are handed to the renderer
    // as different kinds at all — if they are not, no stylesheet can tell them
    // apart later.
    mockServer({
      items: [mkItem({ slug: 'has-progress', title: 'Has progress',
        done_so_far: ['finished this'], working_on_next: ['then this'] })],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await openFirst(el)
    const lists = [...(pane(el)?.querySelectorAll('.docket-list-items') ?? [])]
    assert.equal(lists.length, 2)
    assert.ok(lists[0]!.classList.contains('mark-done'))
    assert.ok(lists[1]!.classList.contains('mark-next'))
    assert.notEqual(lists[0]!.className, lists[1]!.className,
      'both progress lists are the same kind, so nothing can distinguish them')
  })

// ---------------------------------- w2d5fab0a elements 1 and 2: sub-items

import { ancestorsOf, nestRows } from '../src/canvas/docket'

const kid = (slug: string, parent: string | null, title = slug) =>
  mkItem({ slug, parent, title } as Partial<WorkItem>)

/** the tree as indented text — the only readable way to assert a shape */
const tree = (rows: { item: WorkItem; depth: number; kids: number }[]) =>
  rows.map((r) => `${'  '.repeat(r.depth)}${r.item.slug}${r.kids ? `(${r.kids})` : ''}`)

test('§15 children follow their parent, and the server order is untouched',
  () => {
    // the server hands them back in ITS order; nesting only re-parents
    const rows = nestRows([
      kid('docket-improvements', null),
      kid('grouping-and-filters', 'docket-improvements'),
      kid('canvas-navigation', null),
      kid('readable-item-names', 'docket-improvements'),
      kid('deep-one', 'grouping-and-filters'),
    ], new Set())
    assert.deepEqual(tree(rows), [
      'docket-improvements(2)',
      '  grouping-and-filters(1)',
      '    deep-one',
      '  readable-item-names',
      'canvas-navigation',
    ])
  })

test('§16 a parent in ANOTHER section is not a parent here', () => {
  // the backlog and the archive are separate appended groups. A child whose
  // parent is filtered out has nothing to nest under — it must render as a
  // root of this section, not vanish.
  const rows = nestRows([kid('orphan-here', 'lives-in-the-archive')], new Set())
  assert.deepEqual(tree(rows), ['orphan-here'])
})

test('§17 folding hides a subtree and nothing else', () => {
  const items = [
    kid('parent-a', null), kid('child-a', 'parent-a'),
    kid('parent-b', null), kid('child-b', 'parent-b'),
  ]
  assert.deepEqual(tree(nestRows(items, new Set(['parent-a']))), [
    'parent-a(1)', 'parent-b(1)', '  child-b',
  ])
  // ...and the folded parent still reports its children, or the arrow could
  // not say how many it is hiding
  assert.equal(nestRows(items, new Set(['parent-a']))[0]!.kids, 1)
})

test('§18 A CYCLE CANNOT HANG THE LIST, and loses no row', () => {
  // the backend refuses cycles on write, but a migrated or hand-edited
  // document can still hold one, and a renderer that walks a ring locks the
  // tab. Correctness of NESTING may suffer; the list may not.
  const items = [kid('a-ring', 'b-ring'), kid('b-ring', 'a-ring'),
    kid('innocent', null)]
  const rows = nestRows(items, new Set())
  assert.equal(rows.length, 3, 'a cycle swallowed a row')
  assert.deepEqual(new Set(rows.map((r) => r.item.slug)),
    new Set(['a-ring', 'b-ring', 'innocent']))
})

test('§19 an item is never its own parent, whatever the document says', () => {
  const rows = nestRows([kid('selfish', 'selfish')], new Set())
  assert.deepEqual(tree(rows), ['selfish'])
})

test('§20 ancestorsOf walks up, nearest first, and is bounded', () => {
  const items = [kid('top', null), kid('mid', 'top'), kid('low', 'mid')]
  assert.deepEqual(ancestorsOf(items, 'low'), ['mid', 'top'])
  assert.deepEqual(ancestorsOf(items, 'top'), [])
  // a ring must TERMINATE rather than spin, and it stops the moment the walk
  // would revisit where it started — so the answer is the ring minus the
  // starting item, not the whole ring. (My first expectation here was wrong;
  // the code was right.)
  const ring = [kid('x-ring', 'y-ring'), kid('y-ring', 'x-ring')]
  assert.deepEqual(ancestorsOf(ring, 'x-ring'), ['y-ring'])
})

uiTest('§21 selecting a child OPENS ITS ANCESTORS, or the row is not there',
  async (mount) => {
    // ⚠ THE CASE THAT LOOKS LIKE A BROKEN LINK. A collapsed parent means the
    // child's row does not exist on screen; selecting it would appear to do
    // nothing at all.
    mockServer({
      items: [
        mkItem({ slug: 'the-parent', title: 'The parent' } as Partial<WorkItem>),
        mkItem({ slug: 'the-child', parent: 'the-parent', title: 'The child',
          objective: 'x' } as Partial<WorkItem>),
        mkItem({ slug: 'mentions-it', title: 'Mentions it',
          objective: 'see the-child for detail' } as Partial<WorkItem>),
      ],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()

    // fold the parent away, and check the child really is gone from the list
    const fold = el.querySelector('.docket-fold') as HTMLElement
    assert.ok(fold, 'a parent row had no fold control')
    await inAct(() => fold.click())
    await flush()
    assert.ok(!names(el).includes('the-child'), 'folding did not hide the child')

    // now follow a mention of the child
    await inAct(() => (rows(el)[1] as HTMLElement).click())
    await flush()
    const link = refs(el)
    assert.equal(link.length, 1)
    await inAct(() => link[0]!.click())
    await flush()

    assert.ok(names(el).includes('the-child'),
      'the ancestor stayed folded, so the selected row was never on screen')
    assert.match(pane(el)?.textContent ?? '', /The child/)
  })

// ------------------------------------ the canonical token, on BOTH sides

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { findRefs, parseRef } from '../src/canvas/workrefs'

// ⚠ `__SRC_DIR__`, NOT `import.meta.url`: run.mjs bundles each suite into
// node_modules/.orgtree-tests, so a URL relative to the module resolves next
// to the BUNDLE and the fixture is not there. The runner defines this for
// exactly that reason.
declare const __SRC_DIR__: string

/** generated from `backend/orgtree/refs.py` by
 *  `backend/tools/gen_ref_fixture.py`, and asserted by the Python suite too */
const FIXTURE = JSON.parse(readFileSync(
  path.join(__SRC_DIR__, '..', 'tests', 'ref-tokens.json'), 'utf8')) as {
    parse: Record<string, Record<string, string> | null>
    prose: Record<string, [string, string][]>
  }

test('§22 THE TWO PARSERS AGREE, token for token', () => {
  // ⚠ TWO PARSERS ARE TWO CHANCES TO DISAGREE, and a disagreement is a link
  // that opens the wrong thing or nothing at all. The backend emits these and
  // the browser resolves them, so neither may drift alone — the fixture is
  // generated from the Python and both sides test against it.
  const cases = Object.entries(FIXTURE.parse)
  assert.ok(cases.length >= 20, 'the fixture is suspiciously small')
  for (const [token, want] of cases) {
    const got = parseRef(token)
    if (want === null) {
      assert.equal(got, null, `${JSON.stringify(token)} must not parse`)
      continue
    }
    assert.deepEqual({ ...got }, { ...want },
      `${JSON.stringify(token)} parsed differently from the backend`)
  }
  // the malformed half is the half that matters, so prove it is really there
  assert.ok(cases.filter(([, w]) => w === null).length >= 8,
    'the fixture has almost no malformed cases, so "never guessed" is untested')
})

test('§23 …and they find the same tokens in the same prose', () => {
  for (const [text, want] of Object.entries(FIXTURE.prose)) {
    assert.deepEqual(findRefs(text), want.map((w) => [w[0], w[1]]),
      `the two matchers disagree about ${JSON.stringify(text)}`)
  }
})

test('§24 a token from ANOTHER org is parsed, and is not this org', () => {
  // parsing is not resolving. The org segment exists so a token copied out of
  // another org resolves to nothing here rather than to a local namesake.
  const a = parseRef('@item:alpha/shared-name')
  const b = parseRef('@item:beta/shared-name')
  assert.equal(a?.id, b?.id)
  assert.notEqual(a?.org, b?.org)
})


// ------------------------------- §25-§27: the canonical token IN THE PANEL
//
// The unit suite (reflinks) decides what an outcome IS. These three prove the
// docket actually renders one, that clicking it lands on the named item, and
// that the panel does not overstate what it knows: a document reference is
// real but not openable HERE, and saying "no document named d1 in this org"
// would be a claim about the data caused by a limit of the panel.

uiTest('§25 a canonical @item token in the description is a working link',
  async (mount) => {
    mockServer({
      items: [
        mkItem({ slug: 'the-source-item', title: 'Source',
          objective: 'blocked behind @item:org1/the-target-item until Friday' }),
        mkItem({ slug: 'the-target-item', title: 'Target' }),
      ],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    // open the item whose prose carries the token
    const src = rows(el).find((r) =>
      r.querySelector('.l1 .mfrom')?.textContent === 'the-source-item')
    await inAct(() => (src as HTMLElement).click())
    await flush()

    const chip = el.querySelector('.docket-desc button.ref-chip')
    assert.ok(chip, 'the token rendered as a clickable reference')
    // §9 of the corrections: a trustworthy label instead of the raw token
    assert.equal(chip!.textContent, 'the-target-item')

    await inAct(() => (chip as HTMLElement).click())
    await flush()
    const shown = el.querySelector('.docket-pane-sub .docket-slug-text')
    assert.equal(shown?.textContent, 'the-target-item',
      'clicking the reference selected the item it names')
  })

uiTest('§26 CONTROL — a token naming an item this org does not have is marked '
  + 'unavailable, not quietly turned back into prose', async (mount) => {
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'see @item:org1/never-existed for the rest' })],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const chip = el.querySelector('.docket-desc .ref-chip.ref-absent')
    assert.ok(chip, 'the dead reference is rendered as unavailable')
    assert.equal(el.querySelectorAll('.docket-desc button.ref-chip').length, 0,
      'and it is not a button — a dead link must not look live')
    // it shows what was WRITTEN, so whoever fixes it can see the token
    assert.match(chip!.textContent!, /@item:org1\/never-existed/)
  })

uiTest('§27 CONTROL — a mail reference with nowhere to open it is "not from '
  + 'here", which is NOT the same claim as "does not exist"', async (mount) => {
    // ⚠ THIS USED TO BE THE @doc CASE. Documents now open here (§28), so the
    // check moved to the kind that still has no opener rather than being
    // deleted: the DISTINCTION is the thing worth guarding, not the example.
    // Mounted WITHOUT `onOpenMail`, so nothing here could open a mailbox, and
    // judging the token against the item index would report a real message as
    // missing.
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'as agreed in @mail:org1/user/m1 and the item is '
          + '@item:org1/never-existed' })],
      archived: [], backlogged: [],
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const mail = el.querySelector('.docket-desc .ref-chip.ref-mail')
    const item = el.querySelector('.docket-desc .ref-chip.ref-item')
    assert.ok(mail && item, 'both references rendered')
    // ⚠ THE TWO MUST NOT AGREE. Same panel, same prose, two different truths:
    // the item is genuinely absent, the message is merely not openable here.
    assert.ok(mail!.classList.contains('ref-elsewhere'),
      'a mail reference is reported as not openable from this panel')
    assert.ok(item!.classList.contains('ref-absent'),
      'an item this org does not have is reported absent')
    assert.doesNotMatch(mail!.getAttribute('title') ?? '', /no mail named/)
  })

// ------------------------------- §28-§32: the openers the panel now owns
//
// `elsewhere` was always an interim answer, not the destination (Astra
// 2026-09-05): a reference the reader cannot follow is half a feature. Two
// kinds got openers, and they got them in DIFFERENT WAYS, which is the part
// worth reading. The document reader is rendered by this panel, so `doc` is
// handled unconditionally. Mail is not — the three mailboxes are three other
// panels — so `mail` is handled only when a caller hands down the route, and
// the chip follows the callback rather than a hard-coded list.

uiTest('§28 a @doc token opens the reader, on the id the token named',
  async (mount) => {
    const served = mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'the contract is @doc:org1/d1' })],
      archived: [], backlogged: [],
      docs: { d1: { title: 'The contract', node: 'agent1',
        body: 'body of the contract', at: '2026-09-05T09:00:00.000Z' } },
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const chip = el.querySelector('.docket-desc button.ref-chip.ref-doc')
    assert.ok(chip, 'the document token is a live control, not an inert chip')
    assert.equal(el.querySelector('.doc-reader'), null,
      'and nothing is open before it is clicked')

    await inAct(() => (chip as HTMLElement).click())
    await flush()
    const reader = el.querySelector('.doc-reader')
    assert.ok(reader, 'clicking the reference opened the document reader')
    assert.match(reader!.textContent ?? '', /The contract/)
    assert.match(reader!.querySelector('.doc-reader-body')?.textContent ?? '',
      /body of the contract/)
    // ⚠ THE EXACT GET, NOT "a reader appeared". One request, for THAT id —
    // the whole reason this panel may open documents without holding a list
    // of them is that the fetch itself is the lookup.
    assert.deepEqual(served.docUrls.map((u) => u.split('/').pop()), ['d1'])
  })

uiTest('§29 CONTROL — a document this org does not have is reported BY THE '
  + 'READER, and the docket still never calls it absent', async (mount) => {
    const served = mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'the contract is @doc:org1/gone' })],
      archived: [], backlogged: [],
      docs: {},   // every id 404s
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const chip = el.querySelector('.docket-desc button.ref-chip.ref-doc')
    // the chip is live BEFORE the fetch, and that is correct: this panel holds
    // no document list, so the only honest way to find out is to ask
    assert.ok(chip, 'the reference is offered')
    await inAct(() => (chip as HTMLElement).click())
    await flush()
    assert.ok(el.querySelector('.doc-reader'), 'the reader opened')
    assert.match(el.querySelector('.doc-reader .ask-warn')?.textContent ?? '',
      /could not load the document/,
      'the failure is stated where the user asked the question')
    assert.deepEqual(served.docUrls.map((u) => u.split('/').pop()), ['gone'])
    // ⚠ AND THE CHIP DID NOT CHANGE ITS STORY. A panel that flipped the
    // reference to "unavailable" after a failed read would be claiming the
    // authority it deliberately does not have — the document is missing to
    // THIS fetch, which the reader says, in the reader.
    assert.equal(el.querySelector('.docket-desc .ref-chip.ref-absent'), null)
  })

uiTest('§30 CONTROL — while the fetch is in flight the reader says nothing '
  + 'about whether the document exists', async (mount) => {
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'the contract is @doc:org1/slow' })],
      archived: [], backlogged: [],
      docs: { slow: 'never' },
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (el.querySelector(
      '.docket-desc button.ref-chip.ref-doc') as HTMLElement).click())
    await flush()
    // ⚠ THE POSITIVE HALF FIRST, or this passes for the boring reason: the
    // reader must be MOUNTED. "No error message" is free if nothing is open.
    assert.ok(el.querySelector('.doc-reader'), 'the reader is open')
    assert.equal(el.querySelector('.doc-reader .ask-warn'), null,
      'a pending read is not a missing document')
    assert.equal(el.querySelector('.doc-reader .doc-reader-body'), null,
      'and no body is claimed either')
  })

uiTest('§31 Escape closes the reader and LEAVES THE DOCKET OPEN', async (mount) => {
    let closed = 0
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'the contract is @doc:org1/d1' })],
      archived: [], backlogged: [],
      docs: { d1: { title: 'The contract', node: 'agent1', body: 'b',
        at: '2026-09-05T09:00:00.000Z' } },
    })
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => { closed += 1 }}
        tree={mkTree()} />)
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (el.querySelector(
      '.docket-desc button.ref-chip.ref-doc') as HTMLElement).click())
    await flush()
    assert.ok(el.querySelector('.doc-reader'), 'the reader is open')

    await inAct(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await flush()
    assert.equal(el.querySelector('.doc-reader'), null, 'the reader closed')
    assert.equal(closed, 0,
      'and the panel the user was reading from is still there')

    // ⚠ THE CONTROL: the docket's own Escape is still armed. Without this the
    // assertion above passes just as well for a handler that was torn off and
    // never restored.
    await inAct(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await flush()
    assert.equal(closed, 1, 'a second Escape closes the docket')
  })

uiTest('§31b clicking the READER\'S backdrop closes the reader and leaves the '
  + 'docket open', async (mount) => {
    // ⚠ THE SAME FAILURE AS §31, THROUGH THE OTHER EXIT. The docket's own
    // backdrop closes it on click, so a reader rendered INSIDE that backdrop
    // hands every dismissal straight up to it: one click, two panels gone.
    let closed = 0
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'the contract is @doc:org1/d1' })],
      archived: [], backlogged: [],
      docs: { d1: { title: 'The contract', node: 'agent1', body: 'b',
        at: '2026-09-05T09:00:00.000Z' } },
    })
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => { closed += 1 }}
        tree={mkTree()} />)
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (el.querySelector(
      '.docket-desc button.ref-chip.ref-doc') as HTMLElement).click())
    await flush()
    const back = el.querySelector('.doc-reader')?.parentElement
    assert.ok(back?.classList.contains('overlay'), 'the reader has a backdrop')

    await inAct(() => (back as HTMLElement).click())
    await flush()
    assert.equal(el.querySelector('.doc-reader'), null, 'the reader closed')
    assert.equal(closed, 0, 'and the docket did not close with it')

    // CONTROL — the docket's own backdrop still closes the docket, so the
    // assertion above is not passing because backdrop dismissal broke.
    await inAct(() => (el.querySelector('.overlay') as HTMLElement).click())
    await flush()
    assert.equal(closed, 1, 'the docket backdrop still closes the docket')
  })

uiTest('§32 a mail reference is opened by the caller that owns a mailbox, and '
  + 'only when one is wired up', async (mount) => {
    const opened: unknown[] = []
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'as agreed in @mail:org1/node/agent1/m7' })],
      archived: [], backlogged: [],
    })
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree([{ id: 'agent1', tier: 'sonnet', state: 'live',
          generation: 1, parent: null, children: [] }])}
        onOpenMail={(r) => opened.push(r)} />)
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const chip = el.querySelector('.docket-desc button.ref-chip.ref-mail')
    assert.ok(chip, 'with a route wired up the reference is a live control')
    await inAct(() => (chip as HTMLElement).click())
    await flush()
    // the PARSED reference, not the token: the caller has to know which box
    assert.deepEqual(opened, [
      { kind: 'mail', org: 'org1', box: 'node', node: 'agent1', id: 'm7' }])
  })

uiTest('§34 a reference INSIDE the opened document works, and the reader gets '
  + 'out of the way first', async (mount) => {
    // ⚠ A DOCUMENT IS PROSE SOMEBODY WROTE, so it names items and agents
    // too. The item it names lives BEHIND this reader, so following the
    // reference without closing the reader would look like the click did
    // nothing at all.
    mockServer({
      items: [
        mkItem({ slug: 'the-source-item',
          objective: 'the contract is @doc:org1/d1' }),
        mkItem({ slug: 'the-target-item', title: 'Target' }),
      ],
      archived: [], backlogged: [],
      docs: { d1: { title: 'The contract', node: 'agent1',
        body: 'superseded by @item:org1/the-target-item last week',
        at: '2026-09-05T09:00:00.000Z' } },
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (el.querySelector(
      '.docket-desc button.ref-chip.ref-doc') as HTMLElement).click())
    await flush()
    const inner = el.querySelector('.doc-reader-body [data-ref-token]')
    assert.ok(inner, 'the reference in the document body was decided')
    assert.equal(inner!.tagName, 'BUTTON', 'and it is a control')

    await inAct(() => (inner as HTMLElement).click())
    await flush()
    assert.equal(el.querySelector('.doc-reader'), null,
      'the reader closed rather than covering what it opened')
    assert.equal(
      el.querySelector('.docket-pane-sub .docket-slug-text')?.textContent,
      'the-target-item', 'and the item it named is selected')
  })

uiTest('§34b CONTROL — a document referencing a DOCUMENT swaps the reader '
  + 'instead of closing it', async (mount) => {
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'the contract is @doc:org1/d1' })],
      archived: [], backlogged: [],
      docs: {
        d1: { title: 'The contract', node: 'agent1',
          body: 'the numbers are in @doc:org1/d2',
          at: '2026-09-05T09:00:00.000Z' },
        d2: { title: 'The appendix', node: 'agent1', body: 'appendix body',
          at: '2026-09-05T09:00:00.000Z' },
      },
    })
    const el = await mount(modal())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (el.querySelector(
      '.docket-desc button.ref-chip.ref-doc') as HTMLElement).click())
    await flush()
    await inAct(() => (el.querySelector(
      '.doc-reader-body [data-ref-token]') as HTMLElement).click())
    await flush()
    assert.ok(el.querySelector('.doc-reader'), 'the reader is still open')
    assert.match(el.querySelector('.doc-reader-body')?.textContent ?? '',
      /appendix body/, 'showing the document that was referenced')
  })

uiTest('§33 a jump that lands on nothing SAYS SO, and a jump that lands does '
  + 'not', async (mount) => {
    // ⚠ THE SILENCE THIS ENDS: an unknown jump was discarded, leaving the
    // panel showing "select an item to view it" — the very same thing it
    // shows when nobody clicked anything. From a mail body, a reference to an
    // item this viewer cannot see was indistinguishable from a misclick.
    mockServer({
      items: [mkItem({ slug: 'the-real-item' })], archived: [], backlogged: [],
    })
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} jumpTo="never-existed" />)
    await flush()
    const note = el.querySelector('.mailer-read .docket-nojump')
    assert.ok(note, 'the panel stated that the jump landed on nothing')
    assert.match(note!.textContent ?? '', /never-existed/,
      'and it names the id that was clicked')
    assert.equal(el.querySelector('.mailer-read .docket-pane-sub'), null)

    // ⚠ AND IT IS ANSWERED BY THE NEXT DELIBERATE SELECTION. Left standing it
    // would reappear whenever the reader deselected a row.
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())   // deselect
    await flush()
    assert.equal(el.querySelector('.docket-nojump'), null,
      'the notice did not come back on deselect')
  })

uiTest('§33b CONTROL — a jump that DOES land shows the item and no notice',
  async (mount) => {
    mockServer({
      items: [mkItem({ slug: 'the-real-item' })], archived: [], backlogged: [],
    })
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} jumpTo="the-real-item" />)
    await flush()
    assert.equal(el.querySelector('.docket-nojump'), null)
    assert.equal(
      el.querySelector('.docket-pane-sub .docket-slug-text')?.textContent,
      'the-real-item', 'the jump selected its item')
  })

uiTest('§32b CONTROL — a node inbox for somebody this org does not have is '
  + 'unavailable, and the route is never called', async (mount) => {
    // ⚠ THE ROUTER WOULD HAVE NO-OPPED. It looks the node up on the canvas and
    // returns silently when it is not there, so a chip offered for a dissolved
    // or foreign agent is a control that looks live and does nothing. The
    // panel already holds the tree, so it answers BEFORE the click.
    const opened: unknown[] = []
    mockServer({
      items: [mkItem({ slug: 'the-source-item',
        objective: 'as agreed in @mail:org1/node/never-hired/m7 '
          + 'and in @mail:org1/user/m8' })],
      archived: [], backlogged: [],
    })
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree([{ id: 'agent1', tier: 'sonnet', state: 'live',
          generation: 1, parent: null, children: [] }])}
        onOpenMail={(r) => opened.push(r)} />)
    await flush()
    await inAct(() => (rows(el)[0] as HTMLElement).click())
    await flush()
    const chips = [...el.querySelectorAll('.docket-desc .ref-chip.ref-mail')]
    assert.equal(chips.length, 2, 'both mail references rendered')
    const [ghost, user] = chips as HTMLElement[]
    assert.ok(ghost!.classList.contains('ref-absent'),
      "a mailbox belonging to nobody is reported as not existing")
    assert.equal(ghost!.tagName, 'SPAN', 'and it is not clickable')
    assert.match(ghost!.getAttribute('title') ?? '', /does not exist in this org/)
    // ⚠ NOT "not opened from this panel" — that would send someone hunting for
    // the panel that could open it. There is no such panel; there is no box.
    assert.doesNotMatch(ghost!.getAttribute('title') ?? '', /from here/)
    // POSITIVE HALF — the user's box in the SAME prose is still live, so this
    // does not pass by mail references having stopped working altogether
    assert.equal(user!.tagName, 'BUTTON')
    await inAct(() => user!.click())
    await flush()
    assert.deepEqual(opened,
      [{ kind: 'mail', org: 'org1', box: 'user', id: 'm8' }])
  })
