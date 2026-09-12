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
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { DeskChat } from '../src/canvas/desk'
import { loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
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

interface Kit {
  s: FakeServer
  SL: string
  ND: string
  desk: () => Promise<{ now(): Convo; unmount(): Promise<void> }>
}

function pagingTest(name: string, body: (k: Kit) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    const SL = 'org'
    const ND = `n${++_n}`
    const s = new FakeServer()
    s.cursorPages = true
    installFetch(s)
    const open: { unmount(): Promise<void> }[] = []
    t.after(async () => {
      for (const d of open) { try { await d.unmount() } catch { /* gone */ } }
      resetConvos(); realClock()
    })
    await body({
      s, SL, ND,
      desk: async () => {
        const sink: Convo[] = []
        const v = await mountView(<View slug={SL} nid={ND} sink={sink} />, () => sink.length)
        const d = { now: () => sink[sink.length - 1]!, unmount: v.unmount }
        open.push(d)
        return d
      },
    })
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
