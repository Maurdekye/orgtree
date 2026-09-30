// glowdismiss.test.tsx — dismissing an attention flag stops the Work button's
// glow at once (user 2026-09-30: "the dismissal should stop the glow
// immediately, same as how answering a question makes the mail icon stop
// glowing immediately"). What is pinned here:
//
//   • the glow and the dot drop in the render that follows the click, while
//     the server has not answered yet and the tree still says 1;
//   • a refused dismissal brings both back;
//   • once the tree reflects the dismissal, nothing is subtracted twice;
//   • a ticket still flagged by an open question keeps the glow (only the
//     manual flag went), though its dot row goes;
//   • the dot counts only the open organization's tickets;
//   • every dismiss control goes through the one store (no direct API call).
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
/** the backend's notice id names the flag instance: work:<slug>:<epoch> */
const flagRow = (slug: string, org = ORG, epoch = 1): DesktopNotice => ({
  id: `work:${slug}:${epoch}`, org, kind: 'work-attention', item: slug, title: slug, body: 'look' })

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

const button = (attention: number) =>
  <DocketToolbarButton org={ORG} summary={{ attention, active: 0 }} />
const glows = (el: HTMLElement) => !!el.querySelector('.docket-bell.glow')
const dotted = (el: HTMLElement) => !!el.querySelector('.docket-bell .attn-dot')
const badge = (el: HTMLElement) => el.querySelector('.docket-bell .eye-count')?.textContent ?? ''
const item = (slug: string, sources: ('manual' | 'question')[] = ['manual'], rev = 1) =>
  ({ slug, manual_attention: { set_rev: rev }, attention_sources: sources })

const reset = () => { resetDismissedAttention(); resetPending() }

test('§1 the glow and the dot stop on the click, before the server answers', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1')])) })
  const v = await mountView(button(1), (el) => el)
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
    // the tree catches up: 0 flagged — nothing is subtracted below zero or twice
    await v.render(button(0))
    assert.equal(glows(v.el), false)
  } finally { await v.unmount() }
})

test('§2 a refused dismissal brings the glow and the dot back', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1')])) })
  const v = await mountView(button(1), (el) => el)
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
  const v = await mountView(button(2), (el) => el)
  try {
    assert.equal(badge(v.el), '2')
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    assert.equal(badge(v.el), '1', 'one left, at once')
    assert.equal(glows(v.el), true, 'still glowing for the other ticket')
    await srv.answer(true)
    await v.render(button(1))                // the tree reflects the dismissal
    await inAct(() => flush(4))
    assert.equal(badge(v.el), '1', 'the tree\'s own 1 is not reduced again')
    assert.equal(glows(v.el), true)
    // a second dismissal in a row, then the tree catches up to 0
    await inAct(async () => { void dismissAttention(ORG, item('t2')) })
    assert.equal(glows(v.el), false)
    await srv.answer(true)
    await v.render(button(0))
    assert.equal(glows(v.el), false)
  } finally { await v.unmount() }
})

test('§4 a ticket still flagged by an open question keeps the glow; its dot row goes', async () => {
  reset()
  manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1')])) })
  const v = await mountView(button(1), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1', ['manual', 'question'])) })
    assert.equal(glows(v.el), true, 'the question still needs the user')
    assert.equal(dotted(v.el), false, 'the manual flag\'s own notice row is gone')
  } finally { await v.unmount() }
})

test('§5 the dot counts only the open organization\'s tickets', async () => {
  reset()
  await inAct(async () => { publishPending(summarizePending([flagRow('elsewhere', 'other-org')])) })
  const v = await mountView(button(0), (el) => el)
  try {
    assert.equal(dotted(v.el), false, 'a ticket in another organization does not dot this window')
    await inAct(async () => {
      publishPending(summarizePending([flagRow('elsewhere', 'other-org'), flagRow('here')]))
    })
    assert.equal(dotted(v.el), true)
    assert.match(v.el.querySelector('.docket-bell')!.getAttribute('title') ?? '', /1 ticket\(s\) still waiting/)
  } finally { await v.unmount() }
})

test('§7 a new flag arriving after the dismissal glows at once, though the count is unchanged (review-sol)', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('old-ticket')])) })
  const v = await mountView(button(1), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('old-ticket')) })
    assert.equal(glows(v.el), false)
    await srv.answer(true)
    // the next notification list names only a DIFFERENT ticket, and the tree
    // says 1: that 1 is the new flag, not the old one
    await inAct(async () => { publishPending(summarizePending([flagRow('new-ticket')])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(dotted(v.el), true, 'the new ticket dots the button')
    assert.equal(glows(v.el), true, 'and glows — the old dismissal is not subtracted from it')
    assert.equal(badge(v.el), '1')
  } finally { await v.unmount() }
})

test('§8 a notification list read before the server applied the dismissal does not end it early', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1'), flagRow('t2')])) })
  const v = await mountView(button(2), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    // a list published while the request is in flight still names t1
    await inAct(async () => { publishPending(summarizePending([flagRow('t1'), flagRow('t2'), flagRow('t3', 'x')])) })
    assert.equal(badge(v.el), '1', 'still subtracted while in flight')
    await srv.answer(true)
    assert.equal(badge(v.el), '1', 'and after success, until a later list or the tree says it went')
    await inAct(async () => { publishPending(summarizePending([flagRow('t2')])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(badge(v.el), '1', 'the tree reflects it: 1 left, not 0')
  } finally { await v.unmount() }
})

test('§9 the last flag dismissed: an empty list does not bring the glow back while the tree lags (review-sol)', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1')])) })
  const v = await mountView(button(1), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await srv.answer(true)
    // the list is read first and names nothing; the tree still says 1
    await inAct(async () => { publishPending(summarizePending([])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(glows(v.el), false, 'the stale 1 is still the dismissed flag')
    assert.equal(dotted(v.el), false)
    await v.render(button(0))
    await inAct(() => flush(4))
    assert.equal(glows(v.el), false, 'the tree catches up: still off')
    // and a new flag after that glows normally
    await inAct(async () => { publishPending(summarizePending([flagRow('t2')])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(glows(v.el), true)
  } finally { await v.unmount() }
})

test('§10 the same ticket flagged again (new notice epoch) glows and dots at once (review-sol)', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1', ORG, 1)])) })
  const v = await mountView(button(1), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await srv.answer(true)
    assert.equal(glows(v.el), false)
    // raised again on the same ticket: the tree's count is 1 either way
    await inAct(async () => { publishPending(summarizePending([flagRow('t1', ORG, 2)])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(dotted(v.el), true, 'the new flag dots the button')
    assert.equal(glows(v.el), true, 'and glows — the old dismissal does not hide it')
    assert.equal(badge(v.el), '1')
  } finally { await v.unmount() }
})

test('§12 the new flag on the same ticket can itself be dismissed at once (review-sol)', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1', ORG, 1)])) })
  const v = await mountView(button(1), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await srv.answer(true)
    await inAct(async () => { publishPending(summarizePending([flagRow('t1', ORG, 2)])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(glows(v.el), true, 'the new flag glows')
    // dismissed again well within the old record's lifetime
    await inAct(async () => { void dismissAttention(ORG, item('t1', ['manual'], 2)) })
    assert.equal(srv.count(), 1, 'the second request is in flight')
    assert.equal(glows(v.el), false, 'the glow is gone on the click')
    assert.equal(dotted(v.el), false, 'and so is the dot')
    await srv.answer(true)
    await inAct(async () => { publishPending(summarizePending([])) })
    await v.render(button(0))
    await inAct(() => flush(4))
    assert.equal(glows(v.el), false)
    // a refusal of such a second dismissal brings only the new flag back
    await inAct(async () => { publishPending(summarizePending([flagRow('t1', ORG, 3)])) })
    await v.render(button(1))
    await inAct(() => flush(4))
    let error = ''
    await inAct(async () => {
      void dismissAttention(ORG, item('t1', ['manual'], 3)).catch((e: Error) => { error = e.message })
    })
    assert.equal(glows(v.el), false)
    await srv.answer(false)
    assert.ok(error)
    assert.equal(glows(v.el), true, 'refused: the third flag glows again')
    assert.equal(dotted(v.el), true)
  } finally { await v.unmount() }
})

test('§11 the tree reflects the dismissal first: a lagging list still naming the old flag does not dot', async () => {
  reset()
  const srv = manualServer()
  await inAct(async () => { publishPending(summarizePending([flagRow('t1'), flagRow('t2')])) })
  const v = await mountView(button(2), (el) => el)
  try {
    await inAct(async () => { void dismissAttention(ORG, item('t1')) })
    await srv.answer(true)
    await v.render(button(1))
    await inAct(() => flush(4))
    assert.equal(badge(v.el), '1')
    assert.match(v.el.querySelector('.docket-bell')!.getAttribute('title') ?? '', /1 ticket\(s\) still waiting/,
      'the list still names t1, but only t2 counts')
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
