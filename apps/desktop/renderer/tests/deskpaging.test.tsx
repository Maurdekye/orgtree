// deskpaging.test.tsx — LOADING EARLIER MESSAGES, AS A LIFECYCLE
// (user observation 2026-09-12: "loading earlier messages itself appears to
// fail" — reported after the scroll-anchoring work in deskhistory.test.tsx,
// and genuinely separate: that suite is about where the view ENDS UP, this one
// is about whether the page ever arrives and what survives if it does not.)
//
// ⚠ WHAT I EXPECTED TO FIND AND DID NOT. Reading `loadOlder` in convo.ts, the
// failure path looks destructive: it clears `paged`, which is the flag that
// switches ON the branch in refreshConvo that re-prepends already-held
// history, and then forces a refresh — so a transient blip should replace the
// reader's window with the newest few rows. §1, §2 and §4 were written to
// catch exactly that and they PASS on the unmodified store: `mergeCommitted`
// re-supplies the committed rows independently of `paged`, so the history
// survives. They are kept as CONTRACTS, not as regressions, and this note is
// here so the next reader does not re-derive the same wrong conclusion from
// the same code. §5 is the same kind of contract for duplicate-free merging.
//
// THE DEFECT THAT IS REAL is that a failed page is unrecoverable and invisible
// (§3, §6). Nothing anywhere records that the request failed, and — this is
// the part that makes it a dead end rather than a blemish — automatic paging
// cannot ask again by itself. It has exactly two triggers: `onScroll`, which
// needs a scroll event and gets none once the reader is at the top of the
// loaded window, and `fillViewport`, which asks only while the rendered rows
// are shorter than two screens, which a paged-in history never is. So the
// reader sits at the top of a transcript that plainly says "earlier messages"
// above it, wheeling at a boundary that will never produce another one. The
// store now carries `olderError` and the desk turns that status line into a
// retry control.
//
// These are store-level tests on purpose: convo.ts IS the data flow every desk
// reads, and these defects live in the request lifecycle rather than in
// layout. §6 is the one that mounts a real desk, because "can the reader
// actually reach the retry" is a question about the DOM. The scroll-side
// behaviour this pairs with — anchors and loaded rows surviving — is
// deskhistory.test.tsx.
//
// Run:  node apps/desktop/renderer/tests/run.mjs deskpaging

import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import type { Transport } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { DeskChat } from '../src/canvas/desk'
import { collapseWindow, loadOlder, refreshConvo, renameConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'

let _n = 0

/** a DeskChat stripped to its store contract — the same view convo.test.tsx
 *  uses, so these exercise the code path a real desk runs */
function View({ slug, nid, sink }: { slug: string; nid: string; sink: Convo[] }) {
  const c = useConvo(slug, nid)
  useEffect(() => { if (!c.loaded) void refreshConvo(slug, nid) }, [slug, nid, c.loaded])
  sink.push(c)
  return null
}

interface Sink { now(): Convo; unmount(): Promise<void> }
interface Kit {
  s: FakeServer
  SL: string
  ND: string
  /** the fetch stub, for holding a page in flight */
  transport: Transport
  desk: () => Promise<Sink>
  /** a second subscriber, e.g. on the name an agent was renamed TO */
  deskFor: (nid: string) => Promise<Sink>
}

function pagingTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `n${++_n}`
    const s = new FakeServer()
    s.cursorPages = true
    const transport = installFetch(s)
    const open: { unmount(): Promise<void> }[] = []
    t.after(async () => {
      for (const d of open) { try { await d.unmount() } catch { /* gone */ } }
      resetConvos(); realClock()
    })
    const deskFor = async (nid: string): Promise<Sink> => {
      const sink: Convo[] = []
      const v = await mountView(<View slug={SL} nid={nid} sink={sink} />, () => sink.length)
      const d = { now: () => sink[sink.length - 1]!, unmount: v.unmount }
      open.push(d)
      return d
    }
    await body({ s, SL, ND, transport, deskFor, desk: () => deskFor(ND) })
  })
}

const seqs = (c: Convo) => c.chat!.messages.map(r => r.seq)

// ───────────────────────────────────────── §1 a failed page costs nothing

pagingTest('§1 a failed older-page fetch does not replace the loaded '
  + 'window with a short tail', async ({ s, SL, ND, desk }) => {
  for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
  const d = await desk()
  await advance(100)
  // page some history in, for real
  await inAct(() => { loadOlder(SL, ND, 8) })
  await advance(100)
  await inAct(() => { loadOlder(SL, ND, 8) })
  await advance(100)
  const loaded = seqs(d.now())
  assert.ok(loaded.length >= 24, `fixture: paged in history, got ${loaded.length} rows`)

  // …now the network blips on the next page
  s.fail = 500
  await inAct(() => { loadOlder(SL, ND, 8) })
  await advance(200)
  s.fail = null
  await advance(200)

  const after = seqs(d.now())
  assert.ok(after.length >= loaded.length,
    `a failed page threw away loaded history: ${loaded.length} rows -> ${after.length}`)
  assert.deepEqual(after.slice(-loaded.length), loaded,
    'the rows the reader had are no longer the rows they have')
})

pagingTest('§2 …and paging still works afterwards', async ({ s, SL, ND, desk }) => {
  for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
  const d = await desk()
  await advance(100)
  await inAct(() => { loadOlder(SL, ND, 8) })
  await advance(100)
  const before = seqs(d.now()).length

  s.fail = 500
  await inAct(() => { loadOlder(SL, ND, 8) })
  await advance(200)
  s.fail = null
  await advance(200)

  // the retry: a reader who scrolls again must be able to get their page
  const accepted = await (async () => {
    let r = false
    await inAct(() => { r = loadOlder(SL, ND, 8) })
    return r
  })()
  await advance(200)
  assert.equal(accepted, true,
    'paging was refused after a failure — the request lifecycle is wedged')
  assert.ok(seqs(d.now()).length > before,
    'the retry was accepted but produced no older rows')
})

pagingTest('§3 a failed page is SURFACED as retryable, not silently forgotten',
  async ({ s, SL, ND, desk }) => {
    for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
    const d = await desk()
    await advance(100)
    assert.equal(d.now().olderError, false, 'nothing has failed yet')

    s.fail = 500
    await inAct(() => { loadOlder(SL, ND, 8) })
    await advance(200)
    s.fail = null

    assert.equal(d.now().loadingOlder, false, 'the attempt is over')
    assert.equal(d.now().olderError, true,
      'the reader asked for earlier messages, did not get them, and is told nothing')

    // …and it clears the moment one succeeds
    await inAct(() => { loadOlder(SL, ND, 8) })
    await advance(200)
    assert.equal(d.now().olderError, false, 'a successful page must clear the failure')
  })

// ────────────────────────────── §4 a concurrent refresh must not undo it

pagingTest('§4 a refresh landing while a page is in flight does not discard '
  + 'the prepend', async ({ s, SL, ND, desk }) => {
  for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
  const d = await desk()
  await advance(100)
  await inAct(() => { loadOlder(SL, ND, 8) })
  await advance(100)
  const loaded = seqs(d.now())
  assert.ok(loaded.length >= 16, 'fixture: history paged in')

  // a send/poll forces a refresh at the same moment as another page
  await inAct(() => {
    loadOlder(SL, ND, 8)
    void refreshConvo(SL, ND, { force: true })
  })
  await advance(300)
  const after = seqs(d.now())
  assert.ok(after.length >= loaded.length,
    `a concurrent refresh cost loaded history: ${loaded.length} -> ${after.length}`)
  assert.deepEqual([...after].sort((a, b) => (a ?? 0) - (b ?? 0)), after,
    'the merged window is out of order')
})

// ──────────────────────────────── §6 the retry the reader can actually reach

test('§6 the desk OFFERS the retry, and pressing it asks again', async (t: TestContext) => {
  // The store half is §3; this is the half the reader can touch. It matters
  // because automatic paging cannot recover here on its own: `onScroll` needs
  // a scroll event and there are none left at the top of the window, and
  // `fillViewport` only asks while the rendered rows are shorter than two
  // screens. Without a control, "earlier messages" sits above a transcript
  // that will never load another one.
  useFakeClock()
  localStorage.clear(); resetConvos()
  const s = new FakeServer()
  s.cursorPages = true
  for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
  installFetch(s)
  const node = { id: 'writer', generation: 2, state: 'live' as const, tier: 'haiku',
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
  const v = await mountView(
    <DeskChat node={node as never} map={new Map([[node.id, node as never]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  t.after(async () => { await v.unmount(); resetConvos(); realClock() })
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(8) })

  const retry = () => v.el.querySelector('button.loadolder-retry') as HTMLButtonElement | null
  assert.equal(retry(), null, 'nothing has failed, so nothing is offered')

  s.fail = 500
  await inAct(() => { loadOlder('org', 'writer', 8) })
  await advance(200)
  s.fail = null

  const button = retry()
  assert.ok(button, 'a failed page left the reader nothing to press')
  assert.match(button!.textContent ?? '', /retry/i)

  const before = s.requests.filter(r => r.before).length
  await inAct(async () => { button!.click(); await flush(8) })
  await advance(200)
  assert.ok(s.requests.filter(r => r.before).length > before,
    'pressing retry did not ask for the page again')
  assert.equal(retry(), null, 'the retry stayed on screen after it succeeded')
})

// ───────── §9 a failed page must not smuggle back the short-window frame

pagingTest('§9 a leave-history intent that settles through a FAILED page keeps '
  + 'the viewport floor a tall desk asked for', async ({ s, SL, ND, desk, transport }) => {
  // desk-review, second pass — and a regression I introduced myself in
  // c41f3e0. The catch cleared `pendingKeep` BEFORE the collapse consumed it,
  // so a tall Desk that sent (or jumped to the tail) while a page was in
  // flight fell back to CHAT_WINDOW — eight rows — which is exactly the
  // short-window frame this whole item exists to remove, reintroduced through
  // the failure path.
  //
  // ⚠ THE WINDOW HAS TO HAVE GROWN for this to be visible at all, which took
  // two wrong fixtures to work out. A desk that paged by CURSOR leaves `win`
  // at CHAT_WINDOW the whole time, and the catch clears `paged` before it
  // collapses — so `collapseWindow`'s own early-exit (`win <= floor &&
  // !paged`) fires and the floor never applies. A tall desk gets its window
  // from the VIEWPORT path (fillViewport -> loadOlder(n, viewport)), which is
  // what actually grows `win`, and that is what is modelled here.
  for (let i = 0; i < 200; i++) s.assistantMsg(`row ${i}`)
  const d = await desk()
  await advance(100)
  await inAct(() => { loadOlder(SL, ND, 40, true) })   // the viewport grows it
  await advance(200)
  assert.ok(d.now().win > 24, `fixture: the window grew, got win=${d.now().win}`)

  // `fail` is read when the request is MADE, not when it is released, so it
  // must be armed before the call or the held page settles successfully and
  // this exercises the wrong branch entirely (it did, first time round).
  s.fail = 500
  transport.holdAll = true
  await inAct(() => { loadOlder(SL, ND, 8) })          // a failing page, HELD
  // a TALL desk leaves history while it is out: 24 rows is what it draws
  await inAct(() => { collapseWindow(SL, ND, 24) })
  transport.holdAll = false
  await inAct(async () => { transport.release(); await flush(8) })
  await advance(300)
  s.fail = null
  await advance(300)

  // `win` is the POLL WINDOW — exactly what `keep` sets, and what the next
  // poll asks for. The rendered rows are not the witness: `mergeCommitted`
  // re-supplies committed rows on the next refresh, so a row-count assertion
  // passes against the broken code (it did, first time round).
  assert.ok(d.now().win >= 24,
    `the failed page cut the poll window to ${d.now().win} — below the 24 rows `
    + 'a tall desk draws, which is the short-window frame again')
})

// ─────────────── §7 a rename mid-flight must not wedge the surviving entry

pagingTest('§7 a rename while a page is in flight leaves paging WORKING',
  async ({ s, SL, ND, desk, deskFor, transport }) => {
    // desk-review, second pass. `renameConvo` increments ownerVersion and
    // MOVES the same Entry, so the in-flight page's callback lands on a
    // surviving entry with a version it no longer matches. That branch used to
    // return having cleared only `pageInFlight` — but the request guard is
    // `if (e.s.loadingOlder || e.pageInFlight) return false`, so the other half
    // stayed stuck true: the renamed desk sat on "loading earlier messages…"
    // and refused every retry for the life of the entry.
    for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
    const d = await desk()
    await advance(100)
    transport.holdAll = true
    await inAct(() => { loadOlder(SL, ND, 8) })
    assert.equal(d.now().loadingOlder, true, 'fixture: a page is in flight')

    // …the agent is renamed while that page is still out
    await inAct(() => { renameConvo(SL, ND, 'renamed') })
    transport.holdAll = false
    await inAct(async () => { transport.release(); await flush(8) })
    await advance(200)

    const after = await deskFor('renamed')
    await advance(100)
    assert.equal(after.now().loadingOlder, false,
      'the renamed desk is stuck on "loading earlier messages…" forever')
    let accepted = false
    await inAct(() => { accepted = loadOlder(SL, 'renamed', 8) })
    await advance(200)
    assert.equal(accepted, true,
      'paging is refused on the renamed desk — the request gate is wedged')
  })

// ───────── §8 an epoch change must settle the leave-history intent, not leak it

pagingTest('§8 CONTRACT: a leave-history intent recorded during a flight is '
  + 'spent exactly once, whatever becomes of the page',
  async ({ s, SL, ND, desk, transport }) => {
  // ⚠ THIS TEST CANNOT FAIL ON THE CODE IT WAS WRITTEN AGAINST, and that is
  // the finding, not a defect in the test. desk-review and I both read the
  // order_epoch branch of loadOlder as leaking `pendingCollapse`: it returns,
  // so a recorded intent would stay set and fire on a later refresh settle,
  // collapsing the window under a reader mid-read. Tracing it says otherwise —
  // `if (e.pendingCollapse)` is checked ABOVE and returns first, so control
  // only reaches the epoch branch when the flag is already false. A probe in
  // the store confirmed that branch is never entered with an intent pending.
  //
  // So the leak is not reachable, the defensive clearing added alongside this
  // is dead code today, and what is actually worth pinning is the ORDERING
  // that makes it unreachable: an intent is consumed exactly once, and no
  // later refresh may act on a stale one. Reorder those two checks and this
  // goes red.
  s.orderEpoch = 1
  for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
  const d = await desk()
  await advance(100)
  for (let i = 0; i < 3; i++) { await inAct(() => { loadOlder(SL, ND, 8) }); await advance(100) }
  assert.ok(seqs(d.now()).length >= 32, 'fixture: history paged in')

  transport.holdAll = true
  await inAct(() => { loadOlder(SL, ND, 8) })          // a page is HELD
  await inAct(() => { collapseWindow(SL, ND, 8) })     // the reader leaves history
  s.orderEpoch = 2                                     // …and it is re-ordered
  await inAct(async () => { void refreshConvo(SL, ND, { force: true }); await flush(4) })
  await inAct(async () => { transport.releaseLast(); await flush(8) })
  await advance(100)
  transport.holdAll = false
  await inAct(async () => { transport.release(); await flush(8) })
  await advance(300)

  const settled = seqs(d.now()).length
  await inAct(() => { void refreshConvo(SL, ND, { force: true }) })
  await advance(300)
  assert.equal(seqs(d.now()).length, settled,
    'a later refresh acted on a leftover leave-history intent: '
    + `${settled} rows -> ${seqs(d.now()).length}`)
})

// ────────────────────────────────────────────── §5 merged, never doubled

pagingTest('§5 successive pages merge without duplicating rows',
  async ({ s, SL, ND, desk }) => {
    for (let i = 0; i < 80; i++) s.assistantMsg(`row ${i}`)
    const d = await desk()
    await advance(100)
    for (let i = 0; i < 5; i++) {
      await inAct(() => { loadOlder(SL, ND, 8) })
      await advance(100)
    }
    const all = seqs(d.now())
    assert.equal(new Set(all).size, all.length,
      `the window contains duplicate rows: ${all.length} rows, `
      + `${new Set(all).size} distinct`)
    assert.deepEqual([...all].sort((a, b) => (a ?? 0) - (b ?? 0)), all,
      'the merged window is out of order')
  })
