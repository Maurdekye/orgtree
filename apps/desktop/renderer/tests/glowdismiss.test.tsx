// glowdismiss.test.tsx — dismissing an attention flag stops the Work button's
// glow at once (user 2026-09-30: "the dismissal should stop the glow
// immediately, same as how answering a question makes the mail icon stop
// glowing immediately"). A dismissal is matched to its RAISE — the ticket and
// its `manual_attention.set_rev` — which the tree lists beside its count
// (`work_items_summary.raises`) and each flag notice carries (`rev`). What is
// pinned here:
//
//   • the glow and the dot drop in the render that follows the click, while
//     the server has not answered yet and the tree still says 1;
//   • a refused dismissal brings both back;
//   • once the tree reflects the dismissal, nothing is subtracted twice;
//   • a ticket still flagged by an open question keeps the glow (only the
//     manual flag went), though its dot row goes;
//   • the dot counts only the open organization's tickets;
//   • every dismiss control goes through the one store (no direct API call);
//   • every regression review-sol proved, kept here so none returns:
//     §7 a new flag on another ticket with an unchanged count (round 1),
//     §9 an empty list while the tree still counts the dismissed flag and
//     §10 the same ticket flagged again (round 2),
//     §12 dismissing that re-raised flag at once (round 3),
//     §13 a new raise that arrives while the old dismissal is in flight
//     (round 4),
//     §14 a stale notification read that delivers the dismissed raise only
//     after the click (round 5).
//
// Run:  node apps/desktop/renderer/tests/run.mjs glowdismiss
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DocketToolbarButton } from '../src/canvas/docket'
import { dismissAttention, resetDismissedAttention } from '../src/attndismiss'
import { publishPending, resetPending, summarizePending } from '../src/pending-attention'
import type { DesktopNotice } from '../src/notifications'

/** injected by tests/run.mjs — the bundle does not sit next to the sources */
declare const __SRC_DIR__: string

const ORG = 'orgtree'
/** a flag notice as desktop_notifications.py sends it: its id is opaque, and
 *  `rev` is the raise's set_rev */
const flagRow = (slug: string, rev = 1, org = ORG): DesktopNotice => ({
  id: `h-${org}-${slug}-${rev}`, org, kind: 'work-attention', item: slug, title: slug, body: 'look', rev })

/** a server we answer by hand: each dismissal waits until the test says */
function manualServer() {
  const pending: { ok: boolean; resolve: (v: unknown) => void }[] = []
  ;(globalThis as unknown as { fetch: unknown }).fetch = () => new Promise((resolve) => {
    pending.push({ ok: true, resolve })
  })
  const answer = async (ok: boolean) => {
    const p = pending.shift()!
    p.resolve(ok
      ? { ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ item: {} }) }
      : { ok: false, status: 409, headers: new Headers(),
          json: () => Promise.resolve({ detail: 'the flag changed' }),
          text: () => Promise.resolve('{"detail":"the flag changed"}') })
    await inAct(() => flush(6))
  }
  return { answer, count: () => pending.length }
}

type Raise = [string, number]
/** the tree's summary: `raises` lists the manual raises it counted */
const button = (attention: number, raises: Raise[] = []) =>
  <DocketToolbarButton org={ORG} summary={{ attention, active: 0, raises }} />
const glows = (el: HTMLElement) => !!el.querySelector('.docket-bell.glow')
const dotted = (el: HTMLElement) => !!el.querySelector('.docket-bell .attn-dot')
const badge = (el: HTMLElement) => el.querySelector('.docket-bell .eye-count')?.textContent ?? ''
const item = (slug: string, rev = 1, sources: ('manual' | 'question')[] = ['manual']) =>
  ({ slug, manual_attention: { set_rev: rev }, attention_sources: sources })
const publish = async (...rows: DesktopNotice[]) => {
  await inAct(async () => { publishPending(summarizePending(rows)) })
}
const tree = async (v: { render: (e: React.ReactElement) => Promise<unknown> }, n: number, raises: Raise[] = []) => {
  await v.render(button(n, raises))
  await inAct(() => flush(4))
}

const reset = () => { resetDismissedAttention(); resetPending() }

test('§1 the glow and the dot stop on the click, before the server answers', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1'))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    assert.equal(glows(v.el), true, 'one flagged ticket: the button glows')
    assert.equal(dotted(v.el), true)
    let settled = false
    await inAct(async () => { void dismissAttention(ORG, item('t1')).then(() => { settled = true }) })
    assert.equal(srv.count(), 1, 'the request is still in flight')
    assert.equal(settled, false)
    assert.equal(glows(v.el), false, 'the glow is gone on the click')
    assert.equal(dotted(v.el), false, 'and so is the dot')
    await srv.answer(true)
    assert.equal(glows(v.el), false, 'the server agreeing changes nothing on screen')
    await tree(v, 0)
    assert.equal(glows(v.el), false, 'the tree catches up: nothing below zero or twice')
  } finally { await v.unmount() }
})

test('§2 a refused dismissal brings the glow and the dot back', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1'))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    let error = ''
    await inAct(async () => {
      void dismissAttention(ORG, item('t1')).catch((e: Error) => { error = e.message })
    })
    assert.equal(glows(v.el), false)
    await srv.answer(false)
    assert.ok(error, 'the caller hears the refusal (it shows the error)')
    assert.equal(glows(v.el), true, 'refused: the glow is back')
    assert.equal(dotted(v.el), true, 'and the dot')
  } finally { await v.unmount() }
})

test('§3 two flags, one dismissed: the count drops by one and is not subtracted twice later', async () => {
  reset()
  const srv = manualServer()
  const v = await mountView(button(2, [['t1', 1], ['t2', 1]]), (el) => el)
  try {
    assert.equal(badge(v.el), '2')
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    assert.equal(badge(v.el), '1', 'one left, at once')
    assert.equal(glows(v.el), true, 'still glowing for the other ticket')
    await srv.answer(true)
    await tree(v, 1, [['t2', 1]])              // the tree reflects the dismissal
    assert.equal(badge(v.el), '1', 'the tree\'s own 1 is not reduced again')
    await inAct(async () => { void dismissAttention(ORG, item('t2')) })
    assert.equal(glows(v.el), false)
    await srv.answer(true)
    await tree(v, 0)
    assert.equal(glows(v.el), false)
  } finally { await v.unmount() }
})

test('§4 a ticket still flagged by an open question keeps the glow; its dot row goes', async () => {
  reset()
  manualServer()
  await publish(flagRow('t1'))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1', 1, ['manual', 'question'])) })
    assert.equal(glows(v.el), true, 'the question still needs the user')
    assert.equal(dotted(v.el), false, 'the manual flag\'s own notice row is gone')
  } finally { await v.unmount() }
})

test('§5 the dot counts only the open organization\'s tickets', async () => {
  reset()
  await publish(flagRow('elsewhere', 1, 'other-org'))
  const v = await mountView(button(0), (el) => el)
  try {
    assert.equal(dotted(v.el), false, 'a ticket in another organization does not dot this window')
    await publish(flagRow('elsewhere', 1, 'other-org'), flagRow('here'))
    assert.equal(dotted(v.el), true)
    assert.match(v.el.querySelector('.docket-bell')!.getAttribute('title') ?? '', /1 ticket\(s\) still waiting/)
  } finally { await v.unmount() }
})

test('§7 a new flag on another ticket glows at once, though the count is unchanged (review-sol r1)', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('old-ticket'))
  const v = await mountView(button(1, [['old-ticket', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('old-ticket')) })
    assert.equal(glows(v.el), false)
    await srv.answer(true)
    await publish(flagRow('new-ticket'))
    await tree(v, 1, [['new-ticket', 1]])
    assert.equal(dotted(v.el), true, 'the new ticket dots the button')
    assert.equal(glows(v.el), true, 'and glows — the old dismissal is not subtracted from it')
    assert.equal(badge(v.el), '1')
  } finally { await v.unmount() }
})

test('§8 a notification list read before the server applied the dismissal does not end it early', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1'), flagRow('t2'))
  const v = await mountView(button(2, [['t1', 1], ['t2', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await publish(flagRow('t1'), flagRow('t2'), flagRow('t3', 1, 'x'))
    assert.equal(badge(v.el), '1', 'still subtracted while in flight')
    assert.match(v.el.querySelector('.docket-bell')!.getAttribute('title') ?? '', /1 ticket\(s\) still waiting/)
    await srv.answer(true)
    assert.equal(badge(v.el), '1')
    await publish(flagRow('t2'))
    await tree(v, 1, [['t2', 1]])
    assert.equal(badge(v.el), '1', 'the tree reflects it: 1 left, not 0')
  } finally { await v.unmount() }
})

test('§9 the last flag dismissed: an empty list does not bring the glow back while the tree lags (review-sol r2)', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1'))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await srv.answer(true)
    await publish()
    await tree(v, 1, [['t1', 1]])             // the tree still counts the old raise
    assert.equal(glows(v.el), false, 'the stale 1 is still the dismissed raise')
    assert.equal(dotted(v.el), false)
    await tree(v, 0)
    assert.equal(glows(v.el), false, 'the tree catches up: still off')
    await publish(flagRow('t2'))
    await tree(v, 1, [['t2', 1]])
    assert.equal(glows(v.el), true, 'and a new flag after that glows normally')
  } finally { await v.unmount() }
})

test('§10 the same ticket flagged again glows and dots at once (review-sol r2)', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1', 1))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1', 1)) })
    await srv.answer(true)
    assert.equal(glows(v.el), false)
    await publish(flagRow('t1', 2))
    await tree(v, 1, [['t1', 2]])
    assert.equal(dotted(v.el), true, 'the new raise dots the button')
    assert.equal(glows(v.el), true, 'and glows — the old dismissal does not hide it')
    assert.equal(badge(v.el), '1')
  } finally { await v.unmount() }
})

test('§11 the tree reflects the dismissal first: a lagging list still naming the old raise does not dot', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1'), flagRow('t2'))
  const v = await mountView(button(2, [['t1', 1], ['t2', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await srv.answer(true)
    await tree(v, 1, [['t2', 1]])
    assert.equal(badge(v.el), '1')
    assert.match(v.el.querySelector('.docket-bell')!.getAttribute('title') ?? '', /1 ticket\(s\) still waiting/,
      'the list still names t1, but only t2 counts')
  } finally { await v.unmount() }
})

test('§12 the re-raised flag on the same ticket can itself be dismissed at once, and refused (review-sol r3)', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1', 1))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1', 1)) })
    await srv.answer(true)
    await publish(flagRow('t1', 2))
    await tree(v, 1, [['t1', 2]])
    assert.equal(glows(v.el), true, 'the new flag glows')
    await inAct(async () => { void dismissAttention(ORG, item('t1', 2)) })
    assert.equal(srv.count(), 1, 'the second request is in flight')
    assert.equal(glows(v.el), false, 'the glow is gone on the click')
    assert.equal(dotted(v.el), false, 'and so is the dot')
    await srv.answer(true)
    await publish()
    await tree(v, 0)
    assert.equal(glows(v.el), false)
    // a refusal of a third dismissal brings only the third raise back
    await publish(flagRow('t1', 3))
    await tree(v, 1, [['t1', 3]])
    let error = ''
    await inAct(async () => {
      void dismissAttention(ORG, item('t1', 3)).catch((e: Error) => { error = e.message })
    })
    assert.equal(glows(v.el), false)
    await srv.answer(false)
    assert.ok(error)
    assert.equal(glows(v.el), true, 'refused: the third raise glows again')
    assert.equal(dotted(v.el), true)
  } finally { await v.unmount() }
})

test('§13 a new raise arriving while the old dismissal is in flight glows at once (review-sol r4)', async () => {
  reset()
  const srv = manualServer()
  await publish(flagRow('t1', 1))
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1', 1)) })
    assert.equal(glows(v.el), false)
    // the server applied the dismissal and took a new raise before its answer
    // reached us; both polls show the new raise first
    await publish(flagRow('t1', 2))
    await tree(v, 1, [['t1', 2]])
    assert.equal(srv.count(), 1, 'the old dismissal is still in flight')
    assert.equal(glows(v.el), true, 'the new raise glows')
    assert.equal(dotted(v.el), true, 'and dots')
    await srv.answer(true)
    await tree(v, 1, [['t1', 2]])
    assert.equal(glows(v.el), true, 'still, once the old dismissal succeeds')
    assert.equal(badge(v.el), '1')
  } finally { await v.unmount() }
})

test('§14 a stale notification read delivering the dismissed raise after the click does not relight it (review-sol r5)', async () => {
  reset()
  const srv = manualServer()
  // the notification list has not shown the flag yet; the tree has
  const v = await mountView(button(1, [['t1', 1]]), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1', 1)) })
    assert.equal(glows(v.el), false, 'the click clears the glow')
    await srv.answer(true)
    // a read begun before the dismissal returns the old raise; the tree is stale
    await publish(flagRow('t1', 1))
    await tree(v, 1, [['t1', 1]])
    assert.equal(glows(v.el), false, 'the dismissed raise stays off')
    assert.equal(dotted(v.el), false, 'in the dot too')
    await publish()
    await tree(v, 0)
    assert.equal(glows(v.el), false)
  } finally { await v.unmount() }
})

test('§15 an engine that sends no raise identities: the count shows as served', async () => {
  reset()
  manualServer()
  const v = await mountView(<DocketToolbarButton org={ORG} summary={{ attention: 1, active: 0 }} />, (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    assert.equal(glows(v.el), true, 'nothing to match against: nothing is taken off')
  } finally { await v.unmount() }
})

test('§6 every dismiss control goes through dismissAttention, never the API directly', () => {
  const src = __SRC_DIR__
  const files: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(f)) files.push(p)
    }
  }
  walk(src)
  const callers = files.filter((f) => /dismissWorkItemAttention\(/.test(readFileSync(f, 'utf8'))
    && !/[\\/]api\.ts$/.test(f) && !/[\\/]attndismiss\.ts$/.test(f))
  assert.deepEqual(callers, [], 'a direct call would dismiss without dimming the glow')
})
