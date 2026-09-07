/** REDTEAM probes for the four mutants that SURVIVED feature-astra's own
 *  requestdrafts suite at 54c88d0. Each one is written so it FAILS if the
 *  corresponding piece of the key or of the reconciliation is removed —
 *  that is the point, not extra coverage for its own sake.
 *
 *  §A two scope items in ONE request, differing only in path: their decisions
 *     must not swap or share (the request id is shared — the ledger gives one
 *     `sr…` id to the whole pending batch and up to 8 items under it)
 *  §B the same path re-requested at a different mode: an approval of `read`
 *     must NOT be inherited by `write`
 *  §C a credits tab ADDED to an existing batch starts at ITS OWN asked amount
 *     (make(j), not make(0) — a wrong default here is a wrong grant offer)
 *  §D two questions with identical text in one batch do not share one draft
 *     (the `!used.has(j)` guard the source comment claims)
 */
import { inAct, mountView, StrictMode } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AskCard } from '../src/canvas/asks'
import type { AskInfo, AskQuestion, AskTab } from '../src/types'

const q1: AskQuestion = { question: 'Explain timing', header: 'Timing' }
const q2: AskQuestion = { question: 'Any notes?', header: 'Notes' }
const card = (a: AskInfo, slug = 'mine') =>
  <StrictMode><AskCard ask={a} slug={slug} toast={() => {}} /></StrictMode>
const ask = (tabs: AskTab[], rev = 1): AskInfo => ({
  id: 'q-original', node: 'alpha', at: '2026-09-07T00:00:00Z', status: 'open',
  kind: 'batch', rev, revs: { ask: rev, scope: rev, credits: rev }, tabs })
const dir = (path: string, mode = 'read'): AskTab => ({ kind: 'scope', id: 's1',
  item: { kind: 'dir', path, mode }, label: `folder ${path} (${mode})`,
  reason: 'work' })
const tabs = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLButtonElement>('.ask-tabbtn'))
const picks = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.ask-row.on .ask-row-body b')).map((e) => e.textContent)
const rows = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.ask-row .ask-row-body b')).map((e) => e.textContent)
async function openTab(el: HTMLElement, i: number) {
  const b = tabs(el)[i]
  assert.ok(b, `tab ${i} exists`)
  await inAct(() => b.click())
}
async function pick(el: HTMLElement, label: string) {
  const b = Array.from(el.querySelectorAll<HTMLButtonElement>('.ask-row'))
    .find((x) => x.textContent?.trim().startsWith(label))
  assert.ok(b, `row ${label}`)
  await inAct(() => b.click())
}
const APPROVE = 'approve — live from its next turn'

test('§A two scope items differing only in path keep their own decisions', async (t) => {
  const view = await mountView(card(ask([{ kind: 'question', ...q1 },
    dir('/A'), dir('/B')])), (e) => e)
  t.after(() => view.unmount())
  assert.equal(tabs(view.el).length, 3)
  await openTab(view.el, 1); await pick(view.el, APPROVE)
  await openTab(view.el, 2); await pick(view.el, 'deny')
  // positive control: the two tabs really do read differently BEFORE any
  // reconciliation, so a later "they still differ" cannot pass vacuously
  await openTab(view.el, 1)
  assert.deepEqual(picks(view.el), [APPROVE], 'control: /A is approved')
  await openTab(view.el, 2)
  assert.deepEqual(picks(view.el), ['deny'], 'control: /B is denied')

  // a question is appended — every scope item is unchanged
  await view.render(card(ask([{ kind: 'question', ...q1 },
    { kind: 'question', ...q2 }, dir('/A'), dir('/B')], 2)))
  await openTab(view.el, 2)
  assert.deepEqual(picks(view.el), [APPROVE], '/A keeps its own approval')
  await openTab(view.el, 3)
  assert.deepEqual(picks(view.el), ['deny'], "/B must not inherit /A's approval")
})

test('§B an approval of a path at read mode is not inherited by write mode', async (t) => {
  const view = await mountView(card(ask([dir('/A', 'read')])), (e) => e)
  t.after(() => view.unmount())
  await pick(view.el, APPROVE)
  assert.deepEqual(picks(view.el), [APPROVE], 'control: read is approved')
  // the ledger keys a dir item by PATH, so a re-request at a wider mode
  // REPLACES this item in place: same request id, same path, new mode
  await view.render(card(ask([{ ...dir('/A', 'write'), label: 'folder /A (read)' }], 2)))
  assert.deepEqual(picks(view.el), [],
    'a wider permission must not inherit the approval given to the narrower one')
})

test('§C a credits tab added to an open batch offers ITS OWN asked amount', async (t) => {
  const view = await mountView(card(ask([{ kind: 'question', ...q1 }])), (e) => e)
  t.after(() => view.unmount())
  await view.render(card(ask([{ kind: 'question', ...q1 },
    { kind: 'credits', id: 'c9', old: 1, new: 4, reason: 'Capacity' }], 2)))
  await openTab(view.el, 1)
  assert.ok(rows(view.el).includes('grant 4'),
    `the added credits tab must open at the asked 4, got rows ${JSON.stringify(rows(view.el))}`)
})

test('§D two questions with an IDENTICAL definition do not share one draft', async (t) => {
  // identical in every keyed field — this is the case `!used.has(j)` exists
  // for, and the ledger does accept it (_norm_question_batch has no
  // uniqueness check; the amend path merges by question text)
  const dup: AskQuestion = { question: 'Same text', header: 'Dup',
    options: [{ label: 'Yes' }, { label: 'No' }] }
  const view = await mountView(card(ask([{ kind: 'question', ...dup },
    { kind: 'question', ...dup }])), (e) => e)
  t.after(() => view.unmount())
  await openTab(view.el, 0); await pick(view.el, 'Yes')
  await openTab(view.el, 1)
  assert.deepEqual(picks(view.el), [], 'control: the second tab starts empty')
  await view.render(card(ask([{ kind: 'question', ...dup },
    { kind: 'question', ...dup }, { kind: 'question', ...q2 }], 2)))
  await openTab(view.el, 0)
  assert.deepEqual(picks(view.el), ['Yes'], 'the first keeps its answer')
  await openTab(view.el, 1)
  assert.deepEqual(picks(view.el), [], "the second did not inherit the first's answer")
})
