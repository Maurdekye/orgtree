// mailwire.test.tsx — the two mail surfaces the backend waves of 2026-08-05
// shipped without a frontend test: WHERE a wire failure becomes visible, and
// WHICH WAY a mail spark travels.
//
// Why these two together: both are the *last* link in a chain that is already
// covered on the server. `net.py` now records a per-message failure
// (`_bump_try`), stamps a skip reason on entries a backed-off hub never even
// visited (`_stamp_skip`), and summarises both per hub (`status_block`) — and
// the whole point of that work was that the SENDER should be able to see it.
// Whether they can is decided here, in the DOM. Likewise the mail spark: the
// server publishes `{type:'mail', from, to}` and the direction it travels on
// screen is decided entirely by `launchSpark`.
//
//   §9  the failure surface — the ⚠ glyph, the per-hub stuck line, and the
//       question that matters: can a stuck message be FOUND without knowing
//       which message to open?
//   §10 mail sparks — a spark leaves the sender, not the recipient
//
// Hermetic: pure component mounts, no fetch, no store, no canvas layout state
// beyond what the component itself computes.
//
// Run:  cd frontend && node tests/run.mjs mailwire

import { flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { NetHub, OrgInboxEntry, TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

// jsdom implements no layout, so `Element.scrollIntoView` does not exist —
// and `jumpTo` calls it from a ref callback, where a throw kills the commit
// rather than the assertion. Shimmed here rather than in `harness.ts`: it is
// this suite's dependency, and the harness is shared by five others.
// (via `window`: the harness installs HTMLElement/Node on globalThis but not
// Element, and jsdom's own constructor is the one the DOM nodes inherit from)
;(globalThis as unknown as
  { window: { Element: { prototype: Record<string, unknown> } } })
  .window.Element.prototype.scrollIntoView ??= () => {}

const noop = () => {}
const txt = (el: HTMLElement) => el.textContent ?? ''
const q = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)]
/** the tooltip is where every one of these surfaces puts its reason */
const tips = (el: HTMLElement, sel: string) =>
  q(el, sel).map((n) => n.getAttribute('title') ?? '')

/** a test with the clock mocked and a teardown that survives a failed
 *  assertion (the render.test.tsx idiom — an unmount skipped by a throw
 *  poisons every test after it) */
function uiTest(name: string,
  body: (k: { mount: (el: React.ReactElement)
    => Promise<{ el: HTMLElement }> }) => Promise<void>,
  opts: { todo?: string } = {}): void {
  test(name, opts.todo ? { todo: opts.todo } : {}, async (t: TestContext) => {
    useFakeClock()
    const open: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of open) { try { await m.unmount() } catch { /* gone */ } }
      realClock()
    })
    await body({
      mount: async (el) => {
        const v = await mountView(el, (host) => host)
        open.push(v)
        return { el: v.el }
      },
    })
  })
}

// ------------------------------------------------------------------ fixtures
// Shapes copied from what net.py actually writes, not from what the types
// permit: `_bump_try` sets tries+last_err, `_stamp_skip` sets last_err ALONE
// (no attempt was made, so `tries` stays untouched — deliberately).
function outRow(over: Partial<OrgInboxEntry> = {}): OrgInboxEntry {
  return {
    id: 'e-out', dir: 'out', peer: '@net:faraway.other-machine.abcdef',
    body: 'can you hear me', at: '2026-08-05T10:00:00Z', by: 'ceo',
    net_id: 'n-out', state: 'queued', state_at: '2026-08-05T10:00:00Z', ...over,
  }
}
const inRow: OrgInboxEntry = {
  id: 'e-in', dir: 'in', peer: '@net:faraway.other-machine.abcdef',
  body: 'an inbound one, so the folders are not empty',
  at: '2026-08-05T09:00:00Z',
}

function box(entries: OrgInboxEntry[]): TreePayload['org_inbox'] {
  return { entries, unread: 0, holders: ['ceo'], visible: true }
}

function hub(over: Partial<NetHub> = {}): NetHub {
  return {
    id: 'local', address: 'http://localhost:7370', enabled: true,
    name: 'local hub', connected: false, queued: 1, roster: [], ...over,
  }
}

function modal(entries: OrgInboxEntry[], over: {
  hubs?: NetHub[]; jumpTo?: string | null
} = {}) {
  const net = { slug: 'mine.ncola.abc123', hubs: over.hubs ?? [] }
  return (
    <OrgInboxModal inbox={box(entries)} net={net}
      map={new Map<string, CanvasNode>()} slug="mine" toast={noop}
      close={noop} jumpTo={over.jumpTo ?? null} />
  )
}

/** click a control by its visible label (folders, tabs) */
async function click(el: HTMLElement, sel: string, label: string) {
  const b = q(el, sel).find((n) => txt(n as HTMLElement).trim().startsWith(label))
  assert.ok(b, `no ${sel} labelled "${label}" — the fixture is wrong, not the app`)
  await inAct(() => { (b as HTMLElement).click() })
}

// ═══════════════════════════════════════════════════════════════════════ §9
// THE FAILURE SURFACE
// ═══════════════════════════════════════════════════════════════════════ §9

uiTest('§9.1 an opened message that keeps failing on the wire says so, with '
  + 'the try count and the reason', async ({ mount }) => {
  // the shape `_bump_try` writes after three refused connections
  const { el } = await mount(modal(
    [inRow, outRow({ tries: 3, last_err: 'connection refused' })],
    { jumpTo: 'e-out' }))
  await flush()
  // two markers since the §9.2 fix: the LIST row (rowMark) and the reading
  // pane — the same mail is on screen twice, and both sightings must agree
  const stuck = q(el, '.net-state.stuck')
  assert.equal(stuck.length, 2, 'the ⚠ marker renders in the row and the reading pane')
  assert.ok(txt(stuck[0] as HTMLElement).includes('⚠'), 'and it is the ⚠ glyph')
  const tip = (stuck[0] as HTMLElement).getAttribute('title') ?? ''
  assert.ok(tip.includes('3 tries'), `the try count is in the tooltip: ${tip}`)
  assert.ok(tip.includes('connection refused'), `and so is the reason: ${tip}`)
  // ANTI-VACUITY: the ladder glyph must not ALSO be showing — a row cannot be
  // both "queued, failing" and "✓ at the hub"
  assert.equal(q(el, '.net-state:not(.stuck)').length, 0,
    'the failing row shows the failure INSTEAD of a delivery tick')
})

uiTest('§9.2 …and a failing message can be found without already knowing '
  + 'which one to open', async ({ mount }) => {
  // Three sent messages, one of them wedged. This is the situation the user
  // hit three times: mail says "queued for the mail hub" and never lands.
  const { el } = await mount(modal([
    inRow,
    outRow({ id: 'ok-1', net_id: 'n1', state: 'delivered', body: 'landed one' }),
    outRow({ id: 'bad', net_id: 'n2', tries: 7,
             last_err: 'hub unreachable — connection failing; retrying',
             body: 'the wedged one' }),
    outRow({ id: 'ok-2', net_id: 'n3', state: 'read', body: 'landed two' }),
  ]))
  await flush()
  await click(el, '.mail-folders button', 'sent')
  const rows = q(el, '.mailrow') as HTMLElement[]
  assert.equal(rows.length, 3, 'all three sent messages are listed')
  assert.equal(q(el, '.mailer-read .mailer-none').length, 1,
    'and nothing is selected — the reading pane invites a click (user spec)')
  // ← FIXED (promoted out of todo, 2026-08-05): MailList grew a `rowMark`
  // prop and the org inbox's sent folder passes `glyph` — the whole ▫/✓/✓✓/⚠
  // ladder now renders per-row in `.l1`, which is where a webmail user looks
  const stuckRows = rows.filter((r) => r.querySelector('.net-state.stuck'))
  assert.equal(stuckRows.length, 1, 'exactly one row wears the ⚠ in the LIST')
  assert.ok(txt(stuckRows[0]!).includes('the wedged one'),
    'and it is the wedged message — findable without opening anything')
  const laddered = rows.filter((r) => r.querySelector('.net-state:not(.stuck)'))
  assert.equal(laddered.length, 2,
    'the two landed rows carry their delivery ticks in the list too')
})

uiTest('§9.3 a message that finally lands stops claiming it is failing',
  async ({ mount }) => {
    // `_stamp_row` pops last_err/tries when the state advances, but the UI
    // must not depend on that: the ⚠ is gated on `state === 'queued'`, so
    // even a row that arrives with a STALE reason attached reads correctly.
    const { el } = await mount(modal(
      [inRow, outRow({ state: 'delivered', tries: 4, last_err: 'connection refused' })],
      { jumpTo: 'e-out' }))
    await flush()
    assert.equal(q(el, '.net-state.stuck').length, 0,
      'a delivered row does not show ⚠ even carrying a stale failure note')
    // two sightings since the §9.2 fix (list row + reading pane), both ✓✓
    const g = q(el, '.net-state') as HTMLElement[]
    assert.equal(g.length, 2, 'it shows the ladder glyph instead, in both places')
    g.forEach((n) =>
      assert.ok(txt(n).includes('✓✓'), `delivered reads ✓✓, got ${txt(n)}`))
  })

uiTest('§9.4 a hub the drain never dialled is reported as unreached, not as '
  + 'a message that failed N times', async ({ mount }) => {
    // `_stamp_skip` (b43e83a) writes last_err with NO tries — the entry was
    // never attempted, and the count must stay honest. Pinned because the
    // obvious "fix" is to bump tries on a skip, which would turn a hub that
    // was never contacted into a message that failed forever.
    const { el } = await mount(modal(
      [inRow, outRow({ last_err: 'hub unreachable — connection failing; retrying' })],
      { jumpTo: 'e-out' }))
    await flush()
    const tip = tips(el, '.net-state.stuck')[0] ?? ''
    assert.ok(tip.includes('hub unreachable'),
      `the skip reason reaches the reader: ${tip}`)
    assert.ok(!/\b0 tries\b/.test(tip) && !/\b1 tries\b/.test(tip),
      `an unattempted send must not report an attempt count: ${tip}`)
    assert.ok(tip.includes('? tries'),
      `the unknown count renders as "?" — if this changed, re-read `
      + `net.py _stamp_skip before trusting the number: ${tip}`)
  })

uiTest('§9.5 the mailservers tab totals the failures per hub',
  async ({ mount }) => {
    const { el } = await mount(modal([inRow, outRow({ tries: 2, last_err: 'boom' })],
      { hubs: [hub({ queued: 3, stuck: 2, stuck_err: 'connection refused' })] }))
    await flush()
    await click(el, '.adv-tab', 'mailservers')
    const line = q(el, '.oi-stuck') as HTMLElement[]
    assert.equal(line.length, 1, 'the hub carries one stuck line')
    assert.ok(/2 failing/.test(txt(line[0]!)), `the count: ${txt(line[0]!)}`)
    assert.ok(txt(line[0]!).includes('connection refused'),
      `and the newest reason: ${txt(line[0]!)}`)
    assert.ok(txt(el).includes('3 queued outbound'), 'beside the queue depth')
  })

uiTest('§9.6 …and it does so for the hub that mail actually queues on',
  async ({ mount }) => {
    // The implicit LOCAL hub renders `hidden` until it has answered once
    // (net.py status_block: `hid == LOCAL_HUB_ID and not seen`). That is the
    // right call for the passive chrome — an org that never set up a hub
    // should not grow a mailserver UI. But `spool_append` still FALLS BACK to
    // this entry when no roster claims the recipient (FR-07: addressing must
    // never require a live roster), so it is precisely the hub a first-time
    // send queues on, and precisely the one whose failures have nowhere to
    // appear.
    const { el } = await mount(modal(
      [inRow, outRow({ tries: 9, last_err: 'hub unreachable — connection refused' })],
      { hubs: [hub({ hidden: true, queued: 1, stuck: 1,
                     stuck_err: 'hub unreachable — connection refused' })] }))
    await flush()
    assert.equal(q(el, '.adv-tab').length, 0,
      'no mailservers tab: every hub is hidden (this part is by design)')
    // so: is the wedged message findable from the folder that holds it?
    await click(el, '.mail-folders button', 'sent')
    // ← FIXED (promoted out of todo, 2026-08-05): closed by the §9.2 per-row
    // marker, exactly as argued — the hidden-hub rule itself is untouched
    // (hiding an unused hub's chrome is correct; the stuck message is now
    // visible where the MESSAGE is)
    assert.ok(txt(el).includes('⚠'),
      'a send wedged on the hidden implicit local hub is visible from the '
      + 'sent folder itself — the only failure surface this org has')
  })

// ══════════════════════════════════════════════════════════════════════ §10
// MAIL SPARKS — which way the light travels
// ══════════════════════════════════════════════════════════════════════ §10
//
// The server publishes `{type:'mail', from, to}` and nothing more; the whole
// meaning of the animation is decided by `launchSpark` (OrgCanvas.tsx). Two
// facts are worth pinning because both are invisible in review and obvious on
// screen: a spark must LEAVE the sender, and an org-inbox spark must ride the
// mailbox↔node curve rather than the org tree.
//
// The direction lives in one flag — `rev: !isBox(from)` — read at render as
// `segPoint(seg, seg.rev ? 1 - t : t)`. Getting it backwards inverts every
// mail animation in the app and breaks nothing else, so nothing else would
// catch it.
//
// ANTI-VACUITY, structural: §10.1 and §10.2 assert OPPOSITE inequalities over
// the same two anchors, with nothing changed between them but `from`/`to`.
// A build that ignored the flag — or inverted it — fails one of the pair no
// matter which way it errs, so neither can be passing for a reason unrelated
// to direction. (Which is why they are written as a pair and must stay one.)

/** the fixtures below are shaped like the payload, not type-checked into it:
 *  OrgCanvas dereferences a handful of fields and a full TreePayload literal
 *  would be forty lines of noise that prove nothing */
const asTree = (v: unknown) => v as TreePayload

function tree(nodeIds: string[]): TreePayload {
  const mk = (id: string) => ({
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  })
  return asTree({
    slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
    default_top_grant: 50, compact_at: 0, default_tools: null,
    default_visibility: 'team', default_effort: '', credit_requests: [],
    tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
    roots: nodeIds.map(mk), cost_usd_total: 0,
    audit: { live_nodes: nodeIds.length, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
    spend_frozen: false, storage_blocked: false, auto_resume: false,
    fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
    cascade_hire: false, cascade_alloc: true, sandboxed: false,
    audience_requests: [], org_inbox: box([inRow]), net: null,
  })
}

/** the world-space (x, y) a positioned canvas element carries */
function at(el: Element | null | undefined): { x: number; y: number } {
  assert.ok(el, 'the element is not on the canvas')
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/
    .exec((el as HTMLElement).style.transform ?? '')
  assert.ok(m, `no translate() on ${(el as HTMLElement).className}`)
  return { x: Number(m![1]), y: Number(m![2]) }
}

/** where the newest live spark currently is */
function sparkAt(el: HTMLElement): { x: number; y: number } {
  const c = q(el, 'circle.spark')
  assert.ok(c.length, 'no spark was drawn at all')
  const last = c[c.length - 1]!
  return { x: Number(last.getAttribute('cx')), y: Number(last.getAttribute('cy')) }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

/** mount the canvas with the org inbox visible and hand back the two anchors
 *  a mail spark travels between, measured off the rendered elements */
async function canvas(mount: (el: React.ReactElement) => Promise<{ el: HTMLElement }>,
  ids: string[] = ['ceo'], mailEvt: { from: string; to: string; t: number } | null = null) {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { el } = await mount(
    <OrgCanvas tree={tree(ids)} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={mailEvt} />)
  await flush()
  const boxEl = el.querySelector('.sq.orginbox')
  const eyeEl = el.querySelector('.sq.user')
  const card = q(el, '.sq').find((n) => !n.classList.contains('orginbox')
    && !n.classList.contains('user') && txt(n as HTMLElement).includes(ids[0]!))
  assert.ok(card, `the agent card for "${ids[0]}" did not render`)
  const b = at(boxEl), c = at(card), e = at(eyeEl)
  return {
    el,
    eye: { x: e.x + 124 / 2, y: e.y + 124 / 2 },           // USER_W × USER_H
    // the curve's endpoints are the flank mid-heights (launchSpark); the
    // centre is close enough to tell the two ends apart and does not restate
    // the bulge maths the code under test computes
    mailbox: { x: b.x + 124 / 2, y: b.y + 64 / 2 },        // USER_W × INBOX_H
    agent: { x: c.x + 124 / 2, y: c.y + 124 / 2 },         // NODE_W × NODE_H
    fire: async (from: string, to: string) => {
      const fn = (globalThis as unknown as
        { window: { __spark?: (a: string, b: string) => void } }).window.__spark
      assert.ok(fn, 'OrgCanvas did not publish the spark hook')
      await inAct(() => { fn!(from, to) })
    },
  }
}

uiTest('§10.1 inbound org mail leaves the MAILBOX', async ({ mount }) => {
  const c = await canvas(mount)
  await c.fire('org_inbox', 'ceo')
  const p = sparkAt(c.el)
  assert.ok(dist(p, c.mailbox) < dist(p, c.agent),
    'a spark for mail ARRIVING from outside starts at the agent instead of '
    + `the mailbox (spark ${JSON.stringify(p)}, mailbox `
    + `${JSON.stringify(c.mailbox)}, agent ${JSON.stringify(c.agent)})`)
})

uiTest('§10.2 …and an agent’s reply leaves the AGENT', async ({ mount }) => {
  const c = await canvas(mount)
  await c.fire('ceo', 'org_inbox')
  const p = sparkAt(c.el)
  assert.ok(dist(p, c.agent) < dist(p, c.mailbox),
    'the outbound spark starts at the mailbox — the direction flag '
    + '(rev: !isBox(from)) is inverted, so every mail animation in the app '
    + `runs backwards (spark ${JSON.stringify(p)})`)
})

uiTest('§10.3 every spelling of the user launches the compose spark',
  async ({ mount }) => {
    // App.tsx forwards whatever the server names, and the ledger writes the
    // user side as `user` / `user_inbox` / `@user` on different paths;
    // `launchSpark`'s `norm` folds all three. If one stopped being folded the
    // spark would silently not launch — a failure mode whose symptom is
    // nothing happening, which no one reports as a bug.
    for (const who of ['user', 'user_inbox', '@user']) {
      const c = await canvas(mount)
      // eslint-disable-next-line no-await-in-loop
      await c.fire(who, 'org_inbox')
      assert.equal(q(c.el, 'circle.spark').length, 1,
        `"${who}" did not launch a spark — a user alias stopped being folded`)
      const p = sparkAt(c.el)
      assert.ok(dist(p, c.eye) < dist(p, c.mailbox),
        `"${who}" started at the mailbox — the compose spark travels `
        + `eye → mailbox, not the other way (spark ${JSON.stringify(p)}, `
        + `eye ${JSON.stringify(c.eye)}, mailbox ${JSON.stringify(c.mailbox)})`)
    }
  })

uiTest('§10.4 a spark for an agent that is not on the canvas is dropped, not '
  + 'drawn at the origin', async ({ mount }) => {
    // mail can name a node archived between the event and the render
    const c = await canvas(mount)
    await c.fire('org_inbox', 'someone-who-left')
    assert.equal(q(c.el, 'circle.spark').length, 0,
      'a spark was drawn for a node with no position — it would fly from (0,0)')
    await c.fire('org_inbox', 'ceo')
    assert.equal(q(c.el, 'circle.spark').length, 1,
      'and the next real spark still launches')
  })

uiTest('§10.5 agent-to-agent mail does not detour through the mailbox',
  async ({ mount }) => {
    const c = await canvas(mount, ['ceo', 'cfo'])
    await c.fire('ceo', 'cfo')
    const p = sparkAt(c.el)
    assert.ok(dist(p, c.mailbox) > dist(p, c.agent),
      'a peer-to-peer spark was routed through the org inbox '
      + `(spark ${JSON.stringify(p)})`)
  })

uiTest('§10.6 the WS event drives the spark on its own — the dev hook is not '
  + 'the code path', async ({ mount }) => {
    // §10.1-10.5 fire through `window.__spark`, which exists for demos. If the
    // `mailEvt` effect were deleted, every one of them would still pass while
    // the app animated nothing. This is that anti-vacuity check.
    const c = await canvas(mount, ['ceo'], { from: 'org_inbox', to: 'ceo', t: 1 })
    assert.equal(q(c.el, 'circle.spark').length, 1,
      'the mailEvt prop alone did not launch a spark — the WS path is dead '
      + 'even though the dev hook works')
    const p = sparkAt(c.el)
    assert.ok(dist(p, c.mailbox) < dist(p, c.agent),
      'and it travels the same direction the hook does')
  })

// ═══════════════════════════════════════════════════════════════════════ §11
// READ LATENCY — a read mark must not wait for the next poll
// ═══════════════════════════════════════════════════════════════════════ §11
//
// User bug 2026-08-07: "marking mail as read in my inbox takes several seconds
// to process." The server was never the cause — /inbox/read answers in ~5 ms,
// measured against the live backend. The delay was entirely in the client:
// these rows come from a payload that refreshes on a HEARTBEAT (the org inbox
// from the 6 s tree poll, the user inbox from a 5 s usePolled), and the read
// action refreshed either nothing or the wrong payload. So the row kept its
// unread mark for 0–6 s after the write had already landed.
//
// The test that proves the fix must therefore NEVER refresh the prop: if the
// row goes read while the server-supplied `unread` still says otherwise, the
// acknowledgement is local and immediate, which is the whole fix. Refreshing
// the prop would pass with or without it.

/** the org inbox marks read on click-OFF, like every MailList: select an
 *  unread row, then select another. Returns the rows after the handover. */
async function readFirstRow(el: HTMLElement) {
  const rows = () => q(el, '.mailrow') as HTMLElement[]
  assert.ok(rows().length >= 2, 'fixture needs two rows to click between')
  await inAct(() => { rows()[0]!.click() })
  await inAct(() => { rows()[1]!.click() })
  await flush()
  return rows()
}

uiTest('§11.1 an org-inbox row goes read on the POST, not on the next tree '
  + 'poll — the prop never changes here', async ({ mount }) => {
    installFetch(new (await import('./harness')).FakeServer())
    // unread: 2 over two entries ⇒ BOTH rows start unread, and the prop that
    // says so is never re-rendered for the life of this test
    const net = { slug: 'mine.ncola.abc123', hubs: [] }
    const entries = [
      { ...inRow, id: 'e-1', at: '2026-08-05T09:00:00Z' },
      { ...inRow, id: 'e-2', at: '2026-08-05T09:30:00Z' },
    ]
    const { el } = await mount(
      <OrgInboxModal
        inbox={{ entries, unread: 2, holders: ['ceo'], visible: true }}
        net={net} map={new Map<string, CanvasNode>()} slug="mine"
        toast={noop} close={noop} jumpTo={null} />)
    await flush()
    assert.equal(q(el, '.mailrow.unread').length, 2,
      'fixture: both rows should start unread')
    await readFirstRow(el)
    assert.equal(q(el, '.mailrow.unread').length, 0,
      'the rows still render unread after the read POST resolved — the mark '
      + 'is waiting for the 6 s tree poll, which is the reported bug')
  })

uiTest('§11.2 …and a write that FAILS arms nothing (D-089)',
  async ({ mount }) => {
    const h = await import('./harness')
    const srv = new h.FakeServer()
    srv.fail = 500                       // the read POST rejects
    installFetch(srv)
    const net = { slug: 'mine.ncola.abc123', hubs: [] }
    const entries = [
      { ...inRow, id: 'e-1', at: '2026-08-05T09:00:00Z' },
      { ...inRow, id: 'e-2', at: '2026-08-05T09:30:00Z' },
    ]
    const { el } = await mount(
      <OrgInboxModal
        inbox={{ entries, unread: 2, holders: ['ceo'], visible: true }}
        net={net} map={new Map<string, CanvasNode>()} slug="mine"
        toast={noop} close={noop} jumpTo={null} />)
    await flush()
    await readFirstRow(el)
    assert.equal(q(el, '.mailrow.unread').length, 2,
      'a REFUSED read still cleared the unread mark — the UI would show mail '
      + 'as read that the server never recorded')
  })

// ═══════════════════════════════════════════════════════════════════════ §12
// THE ORG-INBOX TILE — nothing may evict the last-mail line, and no badge
// ═══════════════════════════════════════════════════════════════════════ §12
//
// User bug 2026-08-07: "when there are unread mails in the org inbox, the
// tooltip showing the last outbound recipient gets pushed off the bottom and
// cut off."
//
// MEASURED IN A REAL BROWSER (Edge via tools/ui_probe's driver), because this
// is a layout fault and jsdom has no layout at all:
//   without a badge   .oi-head 13.5px · .oi-last 10.5px · not clipped
//   WITH a badge      .oi-head 25.5px · .oi-last  2.3px · CLIPPED
// The label "org inbox" was a bare text node — an anonymous flex item, and
// those wrap. The badge competing for width made it two lines, the tile's
// height is fixed (INBOX_H, the canvas layout depends on it), so .oi-last was
// flex-shrunk to a sliver and clipped its own overflow. Silently: nothing
// errors, the fact just disappears.
//
// ⚠ WHAT THIS TEST CAN AND CANNOT DO. jsdom reports every height as 0, so it
// cannot re-measure the fault — asserting heights here would pass forever, on
// broken CSS included. It pins the STRUCTURAL cause instead: the label lives
// in its own element rather than sitting loose in the flex row. That is the
// edit a future refactor would undo, and undoing it brings the wrap back.
// The pixel proof lives in the commit message and the CSS comment.
//
// ⚠ THE BADGE ITSELF IS GONE (user 2026-08-10): "the org inbox doesn't need an
// unread mail number tag, the user isn't meant to read them." Org-inbox mail
// is addressed to the ORGANIZATION and answered by its agents, so a count
// aimed at the user was an obligation the UI invented. That removes the
// specific competitor for width, and NOT the structural rule — the hub-status
// dot still shares the row, and a loose text node would wrap under it exactly
// as it did under the badge. §12.1 stands unchanged; §12.2 now pins the
// absence, so restoring a count trips a test rather than a user.

uiTest('§12.1 the org-inbox label is an element, not a loose text node — a '
  + 'bare one wraps under the unread badge and evicts the last-mail line',
async ({ mount }) => {
  const c = await canvas(mount)
  const head = c.el.querySelector('.oi-head')
  assert.ok(head, 'the org-inbox tile did not render a head')
  const title = head.querySelector('.oi-title')
  assert.ok(title, 'the label is not in its own element — as a bare text node '
    + 'it is an anonymous flex item, and those WRAP when the badge takes width')
  assert.equal((title.textContent ?? '').trim(), 'org inbox')
  // nothing else may sit loose in the row either, for the same reason
  const loose = [...head.childNodes].filter((n) =>
    n.nodeType === 3 && (n.textContent ?? '').trim() !== '')
  assert.equal(loose.length, 0,
    `${loose.length} bare text node(s) in .oi-head: `
    + JSON.stringify(loose.map((n) => n.textContent)))
})

uiTest('§12.2 …and unread org mail adds NO badge, while the last-mail line '
  + 'still renders', async ({ mount }) => {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const t = tree(['ceo'])
  // unread > 0 was the whole precondition of the 2026-08-07 clipping bug, and
  // is now the precondition of the badge's absence
  const withUnread = { ...t, org_inbox: { ...t.org_inbox!, unread: 4 } }
  const { el } = await mount(
    <OrgCanvas tree={withUnread as TreePayload} op={() => Promise.resolve({} as never)}
      slug="mine" toast={noop} mailEvt={null} />)
  await flush()
  const tile = el.querySelector('.sq.orginbox')
  assert.ok(tile, 'no org-inbox tile')
  assert.equal(tile.querySelector('.count'), null,
    'the org inbox is showing an unread count. That mail is addressed to the '
    + 'organization and answered by its agents — a badge asks the user to '
    + 'clear something that was never theirs (user 2026-08-10)')
  const last = tile.querySelector('.oi-last')
  assert.ok(last && (last.textContent ?? '').trim(),
    'the last-mail line vanished — it carries the only on-canvas record of '
    + 'who was last written to')
  assert.match(last!.textContent ?? '', /faraway/,
    'the last line does not name the peer it should')
})

// ═══════════════════════════════════════════════════════════════════════ §13
// THE CASCADE PREVIEW — who else a grant is about to raise
// ═══════════════════════════════════════════════════════════════════════ §13
//
// D-106 (user ruling 2026-08-07): a grant deeper than the chain can carry no
// longer refuses — every agent BETWEEN the granter and the grantee is raised
// to hold it. The user asked to be warned BEFORE saving, so the panel
// computes the affected set from the tree it already has.
//
// ⚠ That is the ledger's rule expressed a second time, in another language.
// If the two drift, the warning lies — so what these pin is the SHAPE of the
// agreement: same union rule, same monotone comparison, stops at the granter.
// The ledger stays the authority (its `cascaded` is what the toast reports);
// this is the courtesy that has to be honest.

import { cascadePreview } from '../src/canvas/modals'

/** a chain user → top → mid → leaf, each holding progressively less */
function chain(): Map<string, CanvasNode> {
  const mk = (id: string, parent: string | null, sc: Record<string, unknown>) =>
    [id, { id, state: 'live', tier: 'haiku', children: [], parent,
           scope: sc } as unknown as CanvasNode] as const
  return new Map([
    mk('top', null, { add_dirs: [{ path: 'E:/w', mode: 'ro' }],
      tools: { bash: true, web: false, edit: true, subagents: true, mcp: [] },
      org_visibility: 'team', permission_mode: 'acceptEdits' }),
    mk('mid', 'top', { add_dirs: [], tools: { bash: true, web: false,
      edit: false, subagents: false, mcp: [] },
      org_visibility: 'self', permission_mode: 'default' }),
    mk('leaf', 'mid', { add_dirs: [], tools: { bash: false, web: false,
      edit: false, subagents: false, mcp: [] },
      org_visibility: 'self', permission_mode: 'default' }),
  ])
}

test('§13.1 the preview names every ancestor a grant would raise, and what '
  + 'each one gains', () => {
  const got = cascadePreview(chain(), 'leaf', {
    dirs: [{ path: 'E:/w', mode: 'rw' }],
    tools: { bash: true, web: true, edit: true, subagents: true, mcp: ['alpha'] },
    vis: 'full', pm: 'bypassPermissions',
  })
  assert.deepEqual(got.map((g) => g.id), ['mid', 'top'],
    'the chain between the user and leaf was not walked in order')
  const mid = got[0]!.gains
  // mid holds NOTHING of this: a fresh dir, three tools, a server, both ranks
  assert.ok(mid.includes('E:/w rw'), mid.join(', '))
  assert.ok(mid.includes('web') && mid.includes('edit'), mid.join(', '))
  assert.ok(mid.includes('mcp:alpha'), mid.join(', '))
  assert.ok(mid.some((g) => g.startsWith('visibility self→full')), mid.join(', '))
  assert.ok(mid.some((g) => g.startsWith('mode default→bypassPermissions')), mid.join(', '))
  // top holds E:/w read-only — an UPGRADE, not a fresh grant, and it must say so
  const top = got[1]!.gains
  assert.ok(top.includes('E:/w ro→rw'), top.join(', '))
  assert.ok(!top.includes('bash'), `top already holds bash: ${top}`)
})

test('§13.2 …and lists nobody when the chain already carries the grant', () => {
  // everything asked for is at or below what mid and top already hold
  const got = cascadePreview(chain(), 'leaf', {
    dirs: [], tools: { bash: true, web: false, edit: false, subagents: false, mcp: [] },
    vis: 'self', pm: 'default',
  })
  assert.deepEqual(got, [],
    'the warning fires on a grant that raises nobody — it would cry wolf on '
    + 'every ordinary save and stop being read')
})

test('§13.3 a downgrade raises nobody — the cascade is one-directional', () => {
  // revoking travels DOWN (the ledger sweeps the subtree); it must never
  // strip a manager on its way up
  const got = cascadePreview(chain(), 'leaf', { vis: 'self', pm: 'default' })
  assert.deepEqual(got, [], JSON.stringify(got))
})
