// attentionmode.test.tsx — which view an organization is in, and the Attention
// view's own layout, PER ORGANIZATION.
//
// Canvas and Attention are the two main views of an organization, and the
// choice belongs to the organization rather than to the app. That is the same
// scoping mistake `useScopedOpen` in canvas/modalpin.tsx was written to undo —
// one boolean for a surface that exists in several places produced three
// separate user-visible faults on 2026-09-12 — so this suite pins the scoping
// itself, not merely that a value round-trips.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attentionmode

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTENTION_LAYOUT_KEY, attentionLayout, clampSplit, DEFAULT_LAYOUT, forgetAttentionMode,
  ORG_VIEW_KEY, orgView, setAttentionLayout, setOrgView, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN,
} from '../src/attention/mode'

const reset = () => {
  localStorage.clear()
  forgetAttentionMode()
}

test('§1 the view is remembered per organization', () => {
  reset()
  assert.equal(orgView('a'), 'canvas', 'an organization nobody has chosen for opens on the canvas')
  setOrgView('a', 'attention')
  assert.equal(orgView('a'), 'attention')
  assert.equal(orgView('b'), 'canvas',
    'and another organization is untouched — one boolean is not one surface')
  setOrgView('b', 'attention')
  setOrgView('a', 'canvas')
  assert.equal(orgView('a'), 'canvas')
  assert.equal(orgView('b'), 'attention', 'leaving one view does not leave the other')
})

test('§1.1 the default is stored as absence, so it survives a cleared key', () => {
  reset()
  setOrgView('a', 'attention')
  setOrgView('a', 'canvas')
  assert.equal(localStorage.getItem(ORG_VIEW_KEY), null,
    'nothing is written for an organization sitting at the default')
  assert.equal(orgView('a'), 'canvas')
})

test('§1.2 no organization open is the canvas, and writes nothing', () => {
  reset()
  assert.equal(orgView(null), 'canvas')
  setOrgView(null, 'attention')
  assert.equal(localStorage.getItem(ORG_VIEW_KEY), null)
  assert.equal(orgView(null), 'canvas')
})

test('§1.3 a hand-edited or foreign value reads as the default, never as a throw', () => {
  reset()
  localStorage.setItem(ORG_VIEW_KEY, '{"a":"sideways","b":"attention"}')
  forgetAttentionMode()
  assert.equal(orgView('a'), 'canvas', 'an unknown view name is not a view')
  assert.equal(orgView('b'), 'attention', 'and it does not poison its neighbours')

  localStorage.setItem(ORG_VIEW_KEY, 'not json at all')
  forgetAttentionMode()
  assert.equal(orgView('b'), 'canvas')
})

test('§2 the layout is remembered per organization and survives a reload', () => {
  reset()
  assert.deepEqual(attentionLayout('a'), DEFAULT_LAYOUT)
  setAttentionLayout('a', { split: 0.55, agent: 'scout', listOpen: true })
  assert.deepEqual(attentionLayout('a'), { split: 0.55, agent: 'scout', listOpen: true })
  assert.deepEqual(attentionLayout('b'), DEFAULT_LAYOUT)

  // the cached copy is not the stored one: drop it and read from storage
  forgetAttentionMode()
  assert.deepEqual(attentionLayout('a'), { split: 0.55, agent: 'scout', listOpen: true },
    'the split, the selected agent and the list state all come back')
})

test('§2.1 a patch changes one field and leaves the rest standing', () => {
  reset()
  setAttentionLayout('a', { split: 0.55, agent: 'scout', listOpen: true })
  setAttentionLayout('a', { agent: 'other' })
  assert.deepEqual(attentionLayout('a'), { split: 0.55, agent: 'other', listOpen: true })
})

test('§3 the split is bounded, so neither panel can be dragged out of existence', () => {
  reset()
  setAttentionLayout('a', { split: 0.99 })
  assert.equal(attentionLayout('a').split, SPLIT_MAX)
  setAttentionLayout('a', { split: -3 })
  assert.equal(attentionLayout('a').split, SPLIT_MIN)
  assert.equal(clampSplit(Number.NaN), SPLIT_DEFAULT, 'a non-number is the default, not zero')
  assert.equal(clampSplit(Infinity), SPLIT_DEFAULT)
  assert.equal(clampSplit(0.5), 0.5)
})

test('§3.1 a stored split outside the bounds is clamped on READ as well', () => {
  reset()
  localStorage.setItem(ATTENTION_LAYOUT_KEY, '{"a":{"split":9,"agent":"x","listOpen":true}}')
  forgetAttentionMode()
  assert.equal(attentionLayout('a').split, SPLIT_MAX,
    'a value written by an older build cannot strand a panel at zero width')
})

test('§3.2 a garbage layout row reads as the default', () => {
  reset()
  localStorage.setItem(ATTENTION_LAYOUT_KEY, '{"a":null,"b":{"agent":42,"listOpen":"yes"}}')
  forgetAttentionMode()
  assert.deepEqual(attentionLayout('a'), DEFAULT_LAYOUT)
  assert.deepEqual(attentionLayout('b'),
    { split: SPLIT_DEFAULT, agent: null, listOpen: false },
    'a non-string agent is no agent, and only a real `true` holds the list open')
})

test('§4 the two stores are independent: a view change keeps the layout', () => {
  reset()
  setAttentionLayout('a', { split: 0.6, agent: 'scout' })
  setOrgView('a', 'attention')
  setOrgView('a', 'canvas')
  setOrgView('a', 'attention')
  assert.deepEqual(attentionLayout('a'),
    { split: 0.6, agent: 'scout', listOpen: false },
    'returning to the Attention view restores the split and the selected agent')
})
