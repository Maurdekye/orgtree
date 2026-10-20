// The cheap-compact warning above the message box carries a "Turn off in
// settings" link (docket cheap-compact-warning-turn-off-in-settings-link-o,
// USER 2026-10-20 12:24Z: "and in the annotation, add a link to the settings
// menu to turn it off").
//
// The link appears wherever the warning says a cheap-compact WILL happen (the
// idle "sending will cheap-compact this session first" and the mid-turn
// "it will trigger a cheap-compact before delivery") and never on the variants
// that say automatic cheap compaction is off or unreported: there is nothing
// to turn off there. It opens the control that governs THIS agent (ruling
// 2026-10-20 12:28Z): the org's Policies switch, or, when the agent carries an
// explicit ON override of its own, that agent's gear (the org switch would
// not stop it).
//
//   §1 the warning: link on the two "will cheap-compact" variants only
//   §2 the desk: the link asks the shell (the window event 'orgtree:open-settings-at',
//      the way the turn-slot banner's "Open settings" asks for app settings) for the
//      org Policies row, or for the agent's gear when the agent has an explicit ON override
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs cachewarninglink

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheForecastWarning, DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { CacheForecast } from '../src/types'
import { resetConvos } from '../src/convo'

const LINK = '.cache-send-warning .cache-turn-off'

const forecast = (action: CacheForecast['precompact_action']): CacheForecast => ({
  generation: 'opaque-generation', state: 'known_incompatible',
  readiness: 'not_ready', readiness_cause: 'prefix_changed',
  reason: 'three identity components changed', source: 'provider receipts', lane: 'subscription',
  last_receipt_at: '2026-09-01T10:00:00Z', ttl_seconds: 3600,
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  changed_inputs: ['system prompt'], precompact_action: action,
  precompact_reason: action === 'will_compact' ? 'context is above the configured minimum' : 'automatic policy is off',
})

const idle = { midTurn: false, composerFocused: false, cheapCompactOcc: 0.5, contextRatio: 0.6 }
const mid = { midTurn: true, composerFocused: true, cheapCompactOcc: 0.5, contextRatio: 0.6 }

const links = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(LINK)]
const has = (el: ParentNode, sel: string) => el.querySelector(sel) !== null

test('§1 the link is on the two "will cheap-compact" warnings and on no other', async () => {
  const seen: string[] = []
  const on = (name: string) => () => { seen.push(name) }
  const view = await mountView(<>
    <div data-case="idle-compact">
      <CacheForecastWarning {...idle} cheapCompactOn forecast={forecast('will_compact')} onTurnOff={on('idle-compact')} /></div>
    <div data-case="midturn-on">
      <CacheForecastWarning {...mid} cheapCompactOn forecast={forecast('not_applicable')} onTurnOff={on('midturn-on')} /></div>
    <div data-case="idle-miss">
      <CacheForecastWarning {...idle} cheapCompactOn={false} forecast={forecast('miss_expected')} onTurnOff={on('idle-miss')} /></div>
    <div data-case="midturn-off">
      <CacheForecastWarning {...mid} cheapCompactOn={false} forecast={forecast('not_applicable')} onTurnOff={on('midturn-off')} /></div>
    <div data-case="midturn-unreported">
      <CacheForecastWarning {...mid} cheapCompactOn={undefined} forecast={forecast('not_applicable')} onTurnOff={on('midturn-unreported')} /></div>
    <div data-case="no-handler">
      <CacheForecastWarning {...idle} cheapCompactOn forecast={forecast('will_compact')} /></div>
  </>, (el) => el)
  try {
    const at = (c: string) => view.el.querySelector<HTMLElement>(`[data-case="${c}"]`)!
    for (const c of ['idle-compact', 'midturn-on']) {
      const link = at(c).querySelector<HTMLElement>(LINK)
      assert.ok(link, `${c}: the warning carries the link`)
      assert.equal(link!.textContent?.trim(), 'Turn off in settings', `${c}: its words`)
      assert.equal(link!.tagName, 'BUTTON', `${c}: a real button, reachable by keyboard`)
    }
    for (const c of ['idle-miss', 'midturn-off', 'midturn-unreported', 'no-handler']) {
      assert.equal(has(at(c), '.cache-send-warning'), true, `${c}: the warning itself is there`)
      assert.equal(has(at(c), LINK), false, `${c}: but no link`)
    }
    assert.equal(links(view.el).length, 2)
    for (const c of ['idle-compact', 'midturn-on']) {
      await inAct(async () => { at(c).querySelector<HTMLElement>(LINK)!.click(); await flush(2) })
    }
    assert.deepEqual(seen, ['idle-compact', 'midturn-on'], 'each link calls its own handler once')
  } finally { await view.unmount() }
})

// ---------------------------------------------------------------- the desk

const EVENT = 'orgtree:open-settings-at'
const base = {
  id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  cache_forecast: forecast('will_compact'), cheap_compact_on: true, cheap_compact_occ: 0.25,
} as unknown as CanvasNode

async function desk(node: CanvasNode) {
  localStorage.clear(); resetConvos()
  installFetch(new FakeServer())
  const asked: unknown[] = []
  const hear = (e: Event) => { asked.push((e as CustomEvent).detail) }
  window.addEventListener(EVENT, hear)
  const view = await mountView(
    <DeskChat node={node} map={new Map([[node.id, node]])} slug="org"
      op={async () => ({})} toast={() => {}} bare />, el => el)
  await inAct(async () => { await flush(3) })
  const press = async () => {
    const link = view.el.querySelector<HTMLElement>(LINK)
    assert.ok(link, 'the desk warning carries the link')
    await inAct(async () => { link!.click(); await flush(2) })
  }
  const done = async () => { window.removeEventListener(EVENT, hear); await view.unmount(); resetConvos() }
  return { view, asked, press, done }
}

test('§2 on the desk, the link asks for the org Policies switch for an agent that inherits', async () => {
  const { view, asked, press, done } = await desk(base)
  try {
    assert.match(view.el.querySelector('.cache-send-warning')?.textContent ?? '', /will cheap-compact/)
    await press()
    assert.deepEqual(asked, [{ scope: 'org', org: 'org', target: { tab: 'policies', field: 'cheap-compact' } }])
  } finally { await done() }
})

test('§2 an explicit OFF override cannot be the source of the warning; the org switch is still the one', async () => {
  const node = { ...base, configured_scope: { auto_cheap_compact: { enabled: false } } } as unknown as CanvasNode
  const { asked, press, done } = await desk(node)
  try {
    await press()
    assert.deepEqual(asked, [{ scope: 'org', org: 'org', target: { tab: 'policies', field: 'cheap-compact' } }])
  } finally { await done() }
})

test('§2 an agent with its own ON override gets its gear, because the org switch would not stop it', async () => {
  const node = { ...base, configured_scope: { auto_cheap_compact: { enabled: true, occ: 0.4 } } } as unknown as CanvasNode
  const { asked, press, done } = await desk(node)
  try {
    await press()
    assert.deepEqual(asked, [{ scope: 'agent', org: 'org', agentId: 'writer',
      target: { tab: 'model', field: 'cheap-compact' } }])
  } finally { await done() }
})
