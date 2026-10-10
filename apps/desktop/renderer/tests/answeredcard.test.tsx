import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventCard } from '../src/events/card'

const actor = { kind: 'user', id: '@user' }
const opts = [{ label: 'Red', description: 'warm' }, { label: 'Green' }, { label: 'Blue', description: 'cool' }]
const ask = (questions: unknown[], extra = {}) => ({ v: 1, variant: 'answer.ask', actor, engine_authored: true,
  object: { kind: 'ask', org: 'o', id: 'a1', node: 'n' }, questions, text: null, dismissed: false, single: questions.length <= 1, ...extra })
const render = async (t: { after: (f: () => void) => void }, ev: unknown) => {
  const view = await mountView(<EventCard org="o" profile="operator" row={{ ev }} />, h => h)
  t.after(() => view.unmount())
  return view.el
}
const chosen = (el: Element) => [...el.querySelectorAll('.answered-opt[data-chosen="true"] .answered-opt-label')].map(e => e.textContent)
const all = (el: Element) => [...el.querySelectorAll('.answered-opt .answered-opt-label')].map(e => e.textContent)

test('single choice: every option listed, the chosen one highlighted, no field dump', async t => {
  const el = await render(t, ask([{ label: 'Colour', question: 'Pick one?', selected: ['Green'], options: opts, multi: false }]))
  assert.deepEqual(all(el), ['Red', 'Green', 'Blue'])
  assert.deepEqual(chosen(el), ['Green'])
  assert.match(el.querySelector('.answered-card > summary')!.textContent!, /Answered · 1 question$/)
  assert.equal(el.querySelector('.event-body .event-record'), null)
  assert.match(el.textContent!, /warm/)
})
test('multi select ticks several; batched asks list each question', async t => {
  const el = await render(t, ask([
    { label: null, question: 'Which?', selected: ['Red', 'Blue'], options: opts, multi: true },
    { label: 'B', question: 'Second?', selected: ['Green'], options: opts, multi: false }]))
  assert.deepEqual(chosen(el), ['Red', 'Blue', 'Green'])
  assert.equal(el.querySelectorAll('.answered-q').length, 2)
  assert.equal(el.querySelectorAll('.answered-q[data-multi="true"] .answered-mark')[0]!.textContent, '☑')
})
test('free text answer shows the typed text; dismissed highlights nothing', async t => {
  let el = await render(t, ask([{ label: null, question: 'Why?', selected: [] }], { text: 'because' }))
  assert.equal(el.querySelector('.answered-typed')!.textContent, 'because')
  el = await render(t, ask([{ label: null, question: 'Pick?', selected: [], options: opts, multi: false }], { dismissed: true }))
  assert.deepEqual(chosen(el), [])
  assert.match(el.querySelector('.answered-card > summary')!.textContent!, /^Dismissed/)
})
test('old events without options still render the chosen answer; more than two questions start folded', async t => {
  let el = await render(t, ask([{ label: null, question: 'Old?', selected: ['Yes'] }]))
  assert.deepEqual(chosen(el), ['Yes'])
  el = await render(t, ask([1, 2, 3].map(i => ({ label: null, question: 'Q' + i, selected: ['x'] }))))
  assert.equal(el.querySelector('.answered-card')!.hasAttribute('open'), false)
})
test('resolved request: ask sections become the card, other sections stay', async t => {
  const el = await render(t, { v: 1, variant: 'answer.batch', actor, engine_authored: true,
    object: { kind: 'batch', org: 'o', id: 'b1', node: 'n' }, sections: [
      { kind: 'ask', ask_id: 'a', questions: [{ label: null, question: 'Q?', answer: 'Red · Blue', selected: ['Red', 'Blue'], options: opts, multi: true }] },
      { kind: 'credit', outcome: 'approved', old: 1, asked: 2, granted: 2, now: 3 }] })
  assert.deepEqual(chosen(el), ['Red', 'Blue'])
  assert.match(el.textContent!, /approved/i)
})
