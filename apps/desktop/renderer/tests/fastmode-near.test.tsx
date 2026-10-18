import { mountView, installFetch, FakeServer, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentTooltipInfo } from '../src/canvas/OrgCanvas'
import { NearCard, agent, seedFastMode } from './fastmode-near-fixture'
import { syncProviderRegistries } from '../src/canvas/shared'

const badge = (el: HTMLElement) => el.querySelector<HTMLElement>('.sq-badges .badge.fast-mode')
test.beforeEach(() => { seedFastMode(); installFetch(new FakeServer()) })

test('near zoom idle fast-on seat shows one passive icon badge with exact fast tooltip', async () => {
  const view = await mountView(<NearCard node={agent()} />, el => el)
  try {
    const mark = badge(view.el)
    assert.equal(!!mark, true, 'idle uses the saved enabled setting')
    assert.equal(view.el.querySelectorAll('.sq-badges .badge.fast-mode').length, 1)
    assert.equal(mark!.tagName, 'SPAN')
    assert.equal(mark!.title, 'fast')
    assert.equal(mark!.getAttribute('aria-label'), 'fast')
    assert.equal(mark!.querySelector('svg') !== null, true, 'lightning is an icon, not text')
    assert.equal(mark!.textContent, '')
    assert.equal(mark!.querySelector('button') === null, true)
  } finally { await view.unmount() }
})

test('busy fast-on turn keeps its bolt when fast-off is queued; current speed wins over saved scope', async () => {
  const view = await mountView(<NearCard node={agent(false, { busy: true, fast_mode_current: true })} />, el => el)
  try {
    assert.equal(!!badge(view.el), true)
    assert.equal(view.el.querySelector('[data-next-turn="fast"]') === null, true, 'queued indicator stays on the desk')
  } finally { await view.unmount() }
})

test('off, queued-on/current-off and busy unknown/null evidence never claim active fast', async () => {
  for (const n of [agent(false), agent(true, { busy: true, fast_mode_current: false }),
    agent(true, { busy: true }), agent(true, { busy: true, fast_mode_current: null })]) {
    const view = await mountView(<NearCard node={n} />, el => el)
    try { assert.equal(badge(view.el) === null, true) }
    finally { await view.unmount() }
  }
})

test('unsupported providers and pinned model versions hide stored or running fast values', async () => {
  const n = agent(); n.scope!.model_version = '6'
  for (const candidate of [agent(true, { tier: 'haiku' }), agent(true, { tier: 'wonder', busy: true, fast_mode_current: true }), n]) {
    const view = await mountView(<NearCard node={candidate} />, el => el)
    try { assert.equal(badge(view.el) === null, true) }
    finally { await view.unmount() }
  }
})

test('far zoom and map locators omit near fast badges', async () => {
  for (const props of [{ lod: 'mini' as const }, { mapMode: true }]) {
    const view = await mountView(<NearCard node={agent()} {...props} />, el => el)
    try { assert.equal(badge(view.el) === null, true) }
    finally { await view.unmount() }
  }
})

test('near fast badge follows turn completion, preference changes and lost provider support', async () => {
  const view = await mountView(<NearCard node={agent(false, { busy: true, fast_mode_current: true })} />, el => el)
  try {
    assert.equal(!!badge(view.el), true)
    await view.render(<NearCard node={agent(false, { busy: false, fast_mode_current: null })} />)
    assert.equal(badge(view.el) === null, true, 'completion adopts the saved off setting')
    await view.render(<NearCard node={agent(true)} />)
    assert.equal(!!badge(view.el), true)
    await inAct(() => syncProviderRegistries({ providers: [] }))
    assert.equal(badge(view.el) === null, true, 'support loss cannot leave a stale badge')
  } finally { await view.unmount() }
})


test('agent rich-hover tooltip ends with fast instead of fast mode', () => {
  const title = agentTooltipInfo(agent())?.title ?? ''
  assert.match(title, /(?:^| \u00b7 )fast$/)
  assert.doesNotMatch(title, /fast mode/)
  assert.doesNotMatch(agentTooltipInfo(agent(false))?.title ?? '', /(?:^| \u00b7 )fast$/)
})
