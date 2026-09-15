// The renderer half of the 2.1.5-beta.5 correction.
//
// ⚠ WHAT THE USER MEASURED ON beta.5. The unavailable models were correctly
// gone, but `Staff…` still said "Loading current staffing choices…" when it
// opened, and the models it did show were in a mixed order. Two separate
// causes: the row's answer was not ready yet (the warm-up began on HOVER, which
// is before the right-click but not by enough), and the menu replaced a
// placeholder asynchronously even when it had one.
//
// So this file measures the actual consumer — real `DocketRow`s inside the real
// `DocketModal`, driven by real context-menu events — rather than the entry
// builder in isolation. Every section carries a control, because "no request on
// open" passes trivially on a surface that never requests anything and "the
// order matched" passes trivially against a fixture written to match.
import { flush, inAct, mountView, advance, useFakeClock, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import { CODEX_TIERS, ANTIGRAVITY_TIERS, TIERS } from '../src/canvas/shared'
import { quickStaffEntry } from '../src/canvas/quickstaff'
import type { QuickStaffPreview } from '../src/canvas/quickstaff'
import {
  peekQuickStaff, queueStaffingWarm, requestCount, resetStaffingOptionsForTests,
  REUSE_MS,
} from '../src/canvas/staffingoptions'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'
import type { TreePayload, WorkItem } from '../src/types'

const W = window as unknown as Window & typeof globalThis
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const named = (name: string) => buttons().find(b => b.textContent?.replace(' ▸', '') === name)
const LOADING = 'Loading current staffing choices…'

/** THE ORDER THE BACKEND PUBLISHES, copied verbatim from the sequence
 *  `tests/test_staffing_menu_cost.py` pins (`CATALOG`). The two literals are
 *  the contract between the halves: the assertion below proves this sequence IS
 *  the model-switch list's own order, and the Python file proves the backend
 *  produces exactly this sequence from a scrambled organization. Change either
 *  side alone and one of the two files fails. */
const PUBLISHED = ['haiku', 'sonnet', 'opus', 'fable', 'luna', 'terra', 'sol',
                   'astra', 'flash', 'pro']

/** The model-switch dropdown's own order (modals.tsx): Claude, then Codex, then
 *  Antigravity, then the OpenRouter favorites, each family in the sequence its
 *  constant lists. The favorites are a runtime registry and are empty here. */
const MODEL_SWITCH = [...TIERS, ...CODEX_TIERS, ...ANTIGRAVITY_TIERS]

const model = (tier: string) => ({
  tier, seat: 1, efforts: ['low'], accounts: [], default_ok: true,
})
const previewOf = (tiers: string[]): QuickStaffPreview => ({
  mode: 'top_level', configured_mode: 'top_level',
  owner: { node: 'manager', born: 'one' }, fallback: false,
  disclosure: 'Staff immediately at top level. Choose a model.',
  models: tiers.map(model),
})

const BASE = { rev: 1, kind: 'code', title: 'Ticket',
  owner: { node: 'manager', generation: 0 }, created_by: { node: 'manager', generation: 0 },
  at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  done_so_far: [], working_on_next: [], objective: 'Do it', acceptance: [], evidence: [],
  questions: [], attention_sources: [], effective_attention: false, archived: false,
  history: [], participants: [] }
const backlog = (slug: string) =>
  ({ ...BASE, slug, status: 'backlogged' } as unknown as WorkItem)
const active = { ...BASE, slug: 'active', status: 'open' } as unknown as WorkItem

/** The real docket, over a fetch that can be held open partway through — so
 *  "the answer was already there" and "the answer is still in flight" are
 *  states the test can actually be in. */
async function docket(t: { after: (fn: () => void) => void },
                      slugs: string[], tiers = PUBLISHED) {
  useFakeClock(); t.after(realClock)
  resetStaffingOptionsForTests()
  const old = globalThis.fetch
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  window.localStorage.removeItem('orgtree.docket.group')
  const rows = slugs.map(backlog)
  const asked: string[] = []
  let holding = false
  const waiting: (() => void)[] = []
  globalThis.fetch = async (url, init) => {
    const path = String(url)
    if (path.endsWith('/quick-staff')) {
      asked.push(path)
      if (holding && init?.method !== 'POST') {
        await new Promise<void>(r => waiting.push(r))
      }
      return new Response(JSON.stringify(
        init?.method === 'POST' ? { message: 'Staffed.' } : previewOf(tiers)))
    }
    return new Response(JSON.stringify(path.includes('/work-items') ? {
      items: [active], backlogged: rows,
      counts: { active: 1, backlogged: rows.length, archived: 0, attention: 0 },
      now: '2026-09-01T00:00:00Z',
    } : { pending: [], delivered: [], sent: [] }))
  }
  const tree = { slug: 'org1', name: 'Org', epoch: 1, rev: 1, roots: [], asks: [],
    work_items_summary: { active: 1, attention: 0 } } as unknown as TreePayload
  const view = await mountView(
    <DocketModal slug="org1" tree={tree} close={() => {}} toast={() => {}} jumpTo={null} />,
    h => h)
  t.after(() => view.unmount())
  await flush(); await advance(200, 16); await flush()
  const toggle = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find(x => x.parentElement?.textContent?.includes('Show backlogged'))!
  if (!toggle.checked) await inAct(() => { toggle.click() })
  await flush(); await advance(400, 16); await flush(4)
  const row = (slug: string) => [...document.querySelectorAll('.docket-row')]
    .find(x => x.querySelector('.docket-rowname')?.textContent === slug)!
  const openOn = async (slug: string) => {
    await inAct(() => {
      row(slug).dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    await flush(2)
  }
  return { asked, openOn, row, pending: () => waiting.length,
           hold: () => { holding = true },
           release: () => { holding = false; waiting.splice(0).forEach(r => r()) } }
}

// ---------------------------------------------------------------------- §1
test('drawing the docket warms every staffable row before anything is opened', async t => {
  const d = await docket(t, ['one', 'two', 'three'])
  assert.deepEqual(d.asked.map(u => u.split('/work-items/')[1]),
                   ['one/quick-staff', 'two/quick-staff', 'three/quick-staff'])
  for (const slug of ['one', 'two', 'three']) {
    assert.ok(peekQuickStaff(`/api/orgs/org1/work-items/${slug}/quick-staff`),
              `${slug} must be ready before it is touched`)
  }
})

test('control: a row that cannot be staffed warms nothing', async t => {
  // CONTROL for §1: the three requests above are the staffable rows asking,
  // not the docket asking for everything it drew. `active` is drawn in the
  // same pass and is absent from the list.
  const d = await docket(t, ['one'])
  assert.deepEqual(d.asked.map(u => u.split('/work-items/')[1]), ['one/quick-staff'])
  assert.equal(peekQuickStaff('/api/orgs/org1/work-items/active/quick-staff'), undefined)
})

// ---------------------------------------------------------------------- §2
test('opening a warmed row draws its models without waiting for the network', async t => {
  const d = await docket(t, ['one'])
  // ⚠ THE ANSWER IS DELIBERATELY AGED PAST `REUSE_MS` FIRST, and that is what
  // makes this measure the right thing. A menu that READS what is held draws it
  // whatever its age. A menu that AWAITS a read finds the held answer too old to
  // reuse, starts a request, and — with every staffing request held open below —
  // sits on its placeholder, which is precisely the beta.5 symptom. Without the
  // ageing the two are indistinguishable: both would draw from the same fresh
  // entry without touching the network at all.
  await advance(REUSE_MS + 5_000, 1_000)
  d.hold()
  await d.openOn('one')
  const entry = named('Staff…')!
  assert.ok(entry, 'the staffing entry must be part of the menu that opened')
  assert.notEqual(entry.getAttribute('title'), LOADING)
  assert.equal(entry.getAttribute('aria-haspopup'), 'menu',
               'and it must already carry its models, not a placeholder')
  // the row's own hover/focus handlers still refresh behind the open menu —
  // reading what is held is not the same as never asking again
  assert.ok(d.pending() > 0, 'a refresh must be in flight behind it')
  d.release(); await flush(4)
})

test('control: with nothing held the same gesture waits, and says so', async t => {
  // CONTROL for §2: the menu above was complete because the answer was HELD.
  // Drop what is held and repeat the identical gesture against the identical
  // held-open network, and the beta.5 symptom comes straight back — which is
  // how we know §2 measures readiness rather than a menu that never needed
  // anything, and that the hold is real.
  const d = await docket(t, ['one'])
  resetStaffingOptionsForTests()
  d.hold()
  const before = d.asked.length
  await d.openOn('one')
  const entry = named('Staff…')!
  assert.equal(entry.getAttribute('title'), LOADING)
  assert.equal(entry.getAttribute('aria-disabled'), 'true')
  assert.equal(d.asked.length, before + 1, 'and it is the open that requested')
  d.release(); await flush(4)
  assert.notEqual(named('Staff…')!.getAttribute('title'), LOADING)
})

// ---------------------------------------------------------------------- §3
test('the warm-up runs one request at a time and never asks twice for a row', async t => {
  resetStaffingOptionsForTests()
  const old = globalThis.fetch
  t.after(() => { globalThis.fetch = old; resetStaffingOptionsForTests() })
  const open: (() => void)[] = []
  const asked: string[] = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    await new Promise<void>(r => open.push(r))
    return new Response(JSON.stringify(previewOf(['haiku'])))
  }
  const paths = ['a', 'b', 'c'].map(s => `/api/orgs/org1/work-items/${s}/quick-staff`)
  for (const p of paths) queueStaffingWarm(p)
  for (const p of paths) queueStaffingWarm(p)     // a re-render must add nothing
  await flush(2)
  assert.deepEqual(asked, [paths[0]], 'a docket must not fire its rows in parallel')
  for (let i = 0; i < 3 && open.length; i++) { open.shift()!(); await flush(4) }
  assert.deepEqual(asked, paths, 'and each queued row still runs, in order')
  assert.deepEqual(paths.map(requestCount), [1, 1, 1])
})

// ---------------------------------------------------------------------- §4
test('the published order IS the model-switch list order', async t => {
  // The backend decides the sequence (tests/test_staffing_menu_cost.py pins the
  // same literal); this is the other end of that contract — the sequence it
  // publishes is the one the model-switch dropdown shows, grouped by provider
  // and ordered by tier within each.
  assert.deepEqual(PUBLISHED, MODEL_SWITCH.filter(t => PUBLISHED.includes(t)))
  assert.deepEqual(PUBLISHED.filter(t => TIERS.includes(t)), TIERS)
  assert.deepEqual(PUBLISHED.filter(t => ANTIGRAVITY_TIERS.includes(t)), ANTIGRAVITY_TIERS)
  const d = await docket(t, ['one'])
  await d.openOn('one')
  await inAct(() => {
    named('Staff…')!.dispatchEvent(new W.KeyboardEvent('keydown',
      { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  await flush(2)
  const shown = buttons().map(b => b.textContent!.replace(' ▸', ''))
    .filter(label => PUBLISHED.includes(label))
  assert.deepEqual(shown, PUBLISHED)
})

test('control: the menu prints the order it is given and never re-sorts', async t => {
  // CONTROL for §4: hand the entry builder a scrambled payload and it comes out
  // scrambled. That is what makes the assertion above a statement about the
  // BACKEND's ordering rather than about a sort hidden in the renderer.
  const scrambled = ['pro', 'haiku', 'astra', 'sonnet']
  function Fixture({ entries }: { entries: MenuEntry[] }) {
    const menu = useContextMenu()
    return <div tabIndex={0} data-open onContextMenu={e => menu.open(e, entries)}>T{menu.node}</div>
  }
  const entry = quickStaffEntry('org1', 'scrambled', previewOf(scrambled), () => {})
  const v = await mountView(<Fixture entries={[entry]} />, h => h)
  t.after(() => v.unmount())
  await inAct(() => {
    document.querySelector('[data-open]')!
      .dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush(2)
  await inAct(() => {
    named('Staff…')!.dispatchEvent(new W.KeyboardEvent('keydown',
      { key: 'ArrowRight', bubbles: true, cancelable: true }))
  })
  await flush(2)
  const shown = buttons().map(b => b.textContent!.replace(' ▸', ''))
    .filter(label => scrambled.includes(label))
  assert.deepEqual(shown, scrambled)
  assert.notDeepEqual(shown, MODEL_SWITCH.filter(t => scrambled.includes(t)))
})
