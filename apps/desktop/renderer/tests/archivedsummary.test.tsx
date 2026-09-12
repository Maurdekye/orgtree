// archivedsummary.test.tsx — §4.8, the CLIENT half: an archived seat arrives
// as a summary and its detail is fetched when someone opens it.
//
// The backend half is `tests/test_archived_summary.py`, which proves the split
// loses no field. This file exists because that is not the same question as
// "does the app still work", and a code review on 2026-09-12 found three ways
// it did not. Each section below is one of them.
//
//   §A  THE SOURCE MUST BE TEXT. The detail cache keyed on a separator written
//       as a literal NUL byte, so Git classified `archived.ts` as BINARY — it
//       committed as `Bin 0 -> 4816 bytes`, with no diff, no blame and no
//       review. A file nobody can read a diff of is a file nobody reviews.
//
//   §B  A CARD CANNOT AWAIT A FETCH. `NodeSquare` renders straight off its
//       tree entry, so a decision it makes there — which context-menu entries
//       exist, which classes it wears — has to be answerable from the summary
//       alone. `documents` and `lineage` had gone to the detail endpoint, and
//       a retired agent silently lost "Open presentations", "Show lineage",
//       its presentation button and its stacked-card look. Every backend test
//       passed: they all asked whether the FIELD was recoverable, and none
//       asked what was already reading it.
//
//   §C/D A CACHE NEEDS AN INVALIDATION. The key was slug/id/generation and it
//       was dropped only after THIS tab's own non-GET. Neither part moves when
//       another window — or an agent's retool — edits an archived seat: the
//       tree refreshes, the summary is identical, and an open panel goes on
//       showing the charter it cached. `detail_rev` is the token that moves.
//
// Every section carries a POSITIVE CONTROL — a case that must fail — because
// each of these tests would otherwise pass against the broken build it was
// written for.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs archivedsummary

import { advance, flush, FakeServer, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import {
  charterLine, forgetNodeDetail, hydrateTree, lineageCount, nodeDetail,
  readOnlyAgent,
} from '../src/archived'
import type { NodeDetail, Summarisable } from '../src/archived'
import { useNodeDetail } from '../src/nodedetail'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string   // injected by run.mjs (see agentstray.test.tsx)

const noop = () => {}

// ───────────────────────────────────────────── §A the source must stay text

/** every TypeScript source that actually ships, `src/` only. */
function shippedSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) shippedSources(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

test('§A1 no shipped renderer source contains a NUL byte', () => {
  const files = shippedSources(__SRC_DIR__)
  assert.ok(files.length > 20,
    `positive control: the scan must actually find sources — found ${files.length}`)
  const binary = files
    .filter((f) => readFileSync(f).includes(0))
    .map((f) => path.relative(__SRC_DIR__, f).replace(/\\/g, '/'))
  assert.deepEqual(binary, [],
    'Git decides a file is BINARY by looking for a NUL in it, and a binary '
    + 'source has no diff, no blame and no review. `archived.ts` shipped that '
    + 'way once, from a cache-key separator written as a literal NUL — write '
    + 'it as an escape, or pick a printable separator.')
})

test('§A2 positive control: that scan really does detect one', () => {
  // the check above is `Buffer.includes(0)`; if it could not see a planted
  // NUL it would pass on a tree full of them
  assert.equal(Buffer.from('const k = `a\0b`', 'utf8').includes(0), true)
  assert.equal(Buffer.from('const k = `a\\u0000b`', 'utf8').includes(0), false,
    'the ESCAPED form is what a source file is allowed to contain')
})

test('§A3 the cache key survives parts that contain its own punctuation', () => {
  // a joined-on-a-separator key breaks when a part contains the separator;
  // JSON.stringify escapes its own, so these must not collide
  const calls: string[] = []
  const fetcher = (_s: string, id: string) => {
    calls.push(id)
    return Promise.resolve({ charter: id } as NodeDetail)
  }
  const a = { id: 'a"x', generation: 0, detail: false, detail_rev: 'r' }
  const b = { id: 'a', generation: 0, detail: false, detail_rev: 'x"r' }
  forgetNodeDetail()
  nodeDetail('mine', a, fetcher)
  nodeDetail('mine', b, fetcher)
  assert.deepEqual(calls, ['a"x', 'a'],
    'two different seats collided into one cache entry')
})

// ───────────────────────────────────── §B what a card decides as it renders

const asTree = (v: unknown) => v as TreePayload

/** the runtime constants the engine ships once per payload */
const ARCHIVED_DEFAULTS = {
  busy: false, waiting: false, responding: false, phase: null, queued: 0,
  tasks: 0, bg_tasks: 0, last_error: null, activity: { phase: 'thinking' },
  on_fallback: false, proc_warm: false, proc_live: false,
}

function mkNode(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
    ...extra,
  }
}

const DOCS = [{ id: 'd1', title: 'Plan', at: '2026-09-07T10:00:00Z' }]

/** EXACTLY what `_summarise_archived` puts on the wire for a retired seat:
 *  the detail fields are GONE — not empty, gone — and the markers stand in. */
function mkSummary(id: string, extra: Record<string, unknown> = {}): unknown {
  const n = mkNode(id, { state: 'archived' }) as Record<string, unknown>
  for (const f of ['charter', 'team_charter', 'scope', 'lineage',
                   'last_denials', 'last_approvals']) delete n[f]
  return {
    ...n,
    detail: false,
    charter_line: 'the first line of the charter',
    documents: DOCS, documents_count: DOCS.length,
    lineage_count: 2, read_only: true, detail_rev: 'rev-1',
    ...extra,
  }
}

function tree(roots: unknown[]): TreePayload {
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots, cost_usd_total: 0,
    audit: { live_nodes: roots.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: null, net: null,
    // §4.8 — the real payload carries these, and `getTree` runs the tree
    // through `hydrateTree` before anything downstream sees it
    archived_defaults: ARCHIVED_DEFAULTS,
  })
}

type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

const W = () => window as unknown as Window & typeof globalThis
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => (b as HTMLButtonElement).textContent ?? '')

async function rightClick(el: Element): Promise<void> {
  const ev = new (W().MouseEvent)('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  const { act } = await import('react')
  await act(async () => { el.dispatchEvent(ev) })
  await flush(2)
}

async function mountCanvas(t: TestContext, roots: unknown[]) {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  const v = await mountView(
    <OrgCanvas tree={hydrateTree(tree(roots))} slug="mine"
      op={() => Promise.resolve({} as never)} toast={noop}
      mailEvt={null} onOpenAgentGallery={noop} />,
    (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  return v
}

const cardFor = (v: { el: HTMLElement }, id: string) =>
  [...v.el.querySelectorAll('.sq')]
    .find((c) => c.querySelector('.name')?.textContent === id
      || c.textContent?.includes(id)) as HTMLElement | undefined

function uiTest(name: string, body: (t: TestContext) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    try { await body(t) } finally { realClock() }
  })
}

uiTest('§B1 an archived card offers the same actions it did before it was summarised', async (t) => {
  const v = await mountCanvas(t, [mkNode('boss'), mkSummary('gone')])
  const card = cardFor(v, 'gone')
  assert.ok(card, 'positive control: the archived card rendered at all')
  await rightClick(card!)
  const have = labels()
  for (const l of ['Open presentations', 'Show lineage']) {
    assert.ok(have.includes(l),
      `"${l}" is gated on a field the summary omits, and the marker that `
      + `replaces it did not reach the card — have ${JSON.stringify(have)}`)
  }
})

uiTest('§B2 an archived card keeps its visual semantics too', async (t) => {
  const v = await mountCanvas(t, [mkNode('boss'), mkSummary('gone')])
  const card = cardFor(v, 'gone')!
  assert.ok(card.classList.contains('stack2'),
    `the lineage stack (2 prior generations) — classes ${card.className}`)
  assert.ok(card.classList.contains('ro-agent'),
    `the dashed read-only border — classes ${card.className}`)
})

uiTest('§B3 POSITIVE CONTROL: the summary as the broken build sent it loses exactly those four', async (t) => {
  // no markers, no documents — i.e. `documents`, `lineage` and `scope` all
  // routed to the detail endpoint, which is what shipped in 09aa253
  const broken = mkSummary('gone', {
    documents: undefined, documents_count: undefined,
    lineage_count: undefined, read_only: undefined,
  })
  const v = await mountCanvas(t, [mkNode('boss'), broken])
  const card = cardFor(v, 'gone')!
  await rightClick(card)
  const have = labels()
  assert.ok(!have.includes('Open presentations'),
    'if this entry survives WITHOUT the marker, §B1 proves nothing')
  assert.ok(!have.includes('Show lineage'),
    'if this entry survives WITHOUT the marker, §B1 proves nothing')
  assert.ok(!card.classList.contains('stack2'))
  assert.ok(!card.classList.contains('ro-agent'))
})

uiTest('§B4 the summarised card and the whole one agree, entry for entry', async (t) => {
  // the real assertion is not "the entries exist" but "the seat looks the
  // same summarised as it did whole" — so build both and compare
  const whole = mkNode('gone', {
    state: 'archived', documents: DOCS, documents_count: 1,
    lineage: [{ id: 'gone@1' }, { id: 'gone@0' }],
    scope: { permission_mode: 'default', add_dirs: [], tools: { edit: false }, org_visibility: 'team' },
  })
  const a = await mountCanvas(t, [mkNode('boss'), whole])
  const wholeCard = cardFor(a, 'gone')!
  await rightClick(wholeCard)
  const wholeEntries = labels()
  const wholeClasses = [...wholeCard.classList].sort()
  await a.unmount()

  const b = await mountCanvas(t, [mkNode('boss'), mkSummary('gone')])
  const summaryCard = cardFor(b, 'gone')!
  await rightClick(summaryCard)
  assert.deepEqual(labels(), wholeEntries,
    'the summarised seat offers a different menu than the whole one')
  assert.deepEqual([...summaryCard.classList].sort(), wholeClasses,
    'the summarised seat is drawn differently than the whole one')
})

test('§B5 the readers take whichever form they are handed', () => {
  const whole = {
    lineage: [{ id: 'x' }, { id: 'y' }], charter: 'first\nsecond',
    scope: { tools: { edit: false } },
  }
  const summary = {
    lineage_count: 2, charter_line: 'first', read_only: true,
  }
  assert.equal(lineageCount(whole), lineageCount(summary))
  assert.equal(charterLine(whole), charterLine(summary))
  assert.equal(readOnlyAgent(whole), readOnlyAgent(summary))
  // and they do not simply answer the same thing always
  assert.equal(lineageCount({ lineage: [] }), 0)
  assert.equal(readOnlyAgent({ scope: { tools: { edit: true } } }), false)
  assert.equal(readOnlyAgent({ read_only: false }), false)
  assert.equal(readOnlyAgent({}), false, 'an unknown seat is not read-only')
})

// ─────────────────────────────────── §C/D the detail fetch and its cache

/** answers the detail route from a body the test can change under it, the way
 *  another window editing the seat changes what the server would return */
function stubDetailFetch(body: () => NodeDetail) {
  const calls: string[] = []
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  ;(globalThis as { fetch?: typeof fetch }).fetch = ((input: unknown) => {
    const url = String(input)
    calls.push(url)
    return Promise.resolve(new Response(JSON.stringify(body()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
  }) as unknown as typeof fetch
  return {
    calls,
    detailCalls: () => calls.filter((u) => u.includes('/detail')),
    restore: () => { (globalThis as { fetch?: typeof fetch }).fetch = had },
  }
}

function Probe({ node }: { node: Summarisable }) {
  const { node: resolved, ready } = useNodeDetail('mine', node)
  const charter = (resolved as { charter?: string }).charter
  return <div className="probe">{ready ? String(charter) : 'waiting'}</div>
}

const summarySeat = (rev: string): Summarisable => ({
  id: 'gone', generation: 0, detail: false, detail_rev: rev,
})

test('§C the detail is fetched once when a seat is opened, not while cards render', async () => {
  forgetNodeDetail()
  let charter = 'the whole charter'
  const net = stubDetailFetch(() => ({ charter }))
  try {
    const seat = summarySeat('rev-1')
    assert.equal(net.detailCalls().length, 0,
      'nothing has opened the seat yet')
    const v = await mountView(<Probe node={seat} />, (h) => h.textContent)
    await flush(4)
    assert.equal(v.last(), 'the whole charter', 'the detail landed')
    assert.equal(net.detailCalls().length, 1, 'opening it fetched exactly once')

    // a SECOND consumer of the same revision rides the cached answer
    const v2 = await mountView(<Probe node={seat} />, (h) => h.textContent)
    await flush(4)
    assert.equal(v2.last(), 'the whole charter')
    assert.equal(net.detailCalls().length, 1, 'the cache was not consulted')
    charter = 'never reached'
    await v.unmount(); await v2.unmount()
  } finally { net.restore() }
})

test('§D1 a REMOTE edit reaches a panel that is already open', async () => {
  forgetNodeDetail()
  let charter = 'the charter as it was'
  const net = stubDetailFetch(() => ({ charter }))
  try {
    const v = await mountView(<Probe node={summarySeat('rev-1')} />, (h) => h.textContent)
    await flush(4)
    assert.equal(v.last(), 'the charter as it was')

    // ANOTHER WINDOW edits the seat. This tab made no request, so nothing
    // local was invalidated; all it sees is the next tree payload, in which
    // the id and the generation are unchanged and only `detail_rev` moved.
    charter = 'edited somewhere else'
    await v.render(<Probe node={summarySeat('rev-2')} />)
    await flush(4)

    assert.equal(v.last(), 'edited somewhere else',
      'the open panel kept showing the charter it had cached — this is the '
      + 'stale-detail bug the revision token exists to close')
    assert.equal(net.detailCalls().length, 2)
    await v.unmount()
  } finally { net.restore() }
})

test('§D2 POSITIVE CONTROL: an unchanged revision does not refetch', async () => {
  forgetNodeDetail()
  let charter = 'steady'
  const net = stubDetailFetch(() => ({ charter }))
  try {
    const v = await mountView(<Probe node={summarySeat('rev-1')} />, (h) => h.textContent)
    await flush(4)
    assert.equal(net.detailCalls().length, 1)
    // the tree refreshes every 6 s and nothing about this seat changed
    charter = 'must not be reached'
    await v.render(<Probe node={summarySeat('rev-1')} />)
    await flush(4)
    assert.equal(v.last(), 'steady', 'a refetch here would be pure waste')
    assert.equal(net.detailCalls().length, 1,
      'if this refetched, §D1 would pass even without the revision in the key')
    await v.unmount()
  } finally { net.restore() }
})

test('§D3 the cache holds one entry per seat, not one per revision', async () => {
  forgetNodeDetail()
  const answers: string[] = []
  const fetcher = (_s: string, id: string) => {
    answers.push(id)
    return Promise.resolve({ charter: `v${answers.length}` } as NodeDetail)
  }
  const seat = (rev: string) => ({ id: 'gone', generation: 0, detail: false, detail_rev: rev })
  await nodeDetail('mine', seat('rev-1'), fetcher)
  await nodeDetail('mine', seat('rev-2'), fetcher)
  assert.equal(answers.length, 2, 'a new revision is a new answer')
  // rev-1 is superseded, not merely shadowed: going back to it must not serve
  // the entry from before, because a superseded revision is known to be stale
  const back = await nodeDetail('mine', seat('rev-1'), fetcher)
  assert.equal(answers.length, 3, 'the superseded entry was still being held')
  assert.equal((back as { charter?: string }).charter, 'v3')
})

test('§D4 a generation change still invalidates, and a live seat never fetches', async () => {
  forgetNodeDetail()
  const seen: string[] = []
  const fetcher = (_s: string, id: string) => {
    seen.push(id)
    return Promise.resolve({ charter: 'fetched' } as NodeDetail)
  }
  await nodeDetail('mine', { id: 'a', generation: 0, detail: false, detail_rev: 'r' }, fetcher)
  await nodeDetail('mine', { id: 'a', generation: 1, detail: false, detail_rev: 'r' }, fetcher)
  assert.equal(seen.length, 2, 'a rehire mints a new generation — a new seat')
  // a node the tree carried WHOLE is already the answer
  const live = { id: 'b', generation: 0, charter: 'right here' }
  const got = await nodeDetail('mine', live, fetcher)
  assert.equal(seen.length, 2, 'a live seat must never hit the network')
  assert.equal((got as { charter?: string }).charter, 'right here')
})

test('§D5 a failed fetch is not cached, and does not poison the next seat', async () => {
  forgetNodeDetail()
  let fail = true
  const fetcher = (_s: string, id: string) => fail
    ? Promise.reject(new Error('410 gone'))
    : Promise.resolve({ charter: `ok ${id}` } as NodeDetail)
  const seat = { id: 'a', generation: 0, detail: false, detail_rev: 'r' }
  await assert.rejects(() => nodeDetail('mine', seat, fetcher), /410 gone/)
  fail = false
  assert.equal((await nodeDetail('mine', seat, fetcher) as { charter?: string }).charter,
    'ok a', 'the rejection was cached and outlived the condition')
})

test('§D6 this tab\'s own write still clears the cache immediately', async () => {
  // the LOCAL half: a write from this window beats the refresh that would
  // carry the new revision, so `forgetNodeDetail` stays as the fast path
  forgetNodeDetail()
  const seen: string[] = []
  const fetcher = (_s: string, id: string) => {
    seen.push(id)
    return Promise.resolve({ charter: 'x' } as NodeDetail)
  }
  const seat = { id: 'a', generation: 0, detail: false, detail_rev: 'r' }
  await nodeDetail('mine', seat, fetcher)
  await nodeDetail('mine', seat, fetcher)
  assert.equal(seen.length, 1, 'positive control: it was cached')
  forgetNodeDetail('mine', 'a')
  await nodeDetail('mine', seat, fetcher)
  assert.equal(seen.length, 2, 'the local invalidation did not reach it')
  // and it is scoped — a different org's entry is untouched
  await nodeDetail('other', seat, fetcher)
  forgetNodeDetail('mine')
  await nodeDetail('other', seat, fetcher)
  assert.equal(seen.length, 3, 'clearing one org dropped another org\'s entry')
})
