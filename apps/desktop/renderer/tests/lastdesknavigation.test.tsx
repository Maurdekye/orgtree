import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { NavigationDeskMemory } from '../src/canvas/keyboardnavigation'
import { USER, type CanvasNode } from '../src/canvas/shared'
import { setButtonAgent } from '../src/buttoncolours'
import type { CanvasShortcutRef } from '../src/shell/appshortcuts'
import { resetConvos } from '../src/convo'
import { lastDeskTree } from './lastdesk.fixture'

const noop = () => {}
const op = async () => ({})
const transform = (host: HTMLElement) => host.querySelector<HTMLElement>('.space')!.style.transform
const projectOpen = (host: HTMLElement) => !!host.querySelector('.sq.project .project-desk')
const agentOpen = (host: HTMLElement, id: string) => [...host.querySelectorAll('.sq.desk:not(.user)')]
  .some(el => (el.getAttribute('data-first-use-agent') ?? el.getAttribute('data-copy-agent-name')) === id)

async function fixture(t: TestContext, initial?: string) {
  useFakeClock(); installFetch(new FakeServer()); localStorage.clear()
  const shortcuts: CanvasShortcutRef = { current: null }
  const render = (focusAgent?: string, slug = 'last-desk') => <OrgCanvas
    tree={lastDeskTree(slug)} slug={slug} toast={noop} op={op} mailEvt={null}
    canvasShortcuts={shortcuts} focusAgent={focusAgent} />
  const view = await mountView(render(), el => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush(); await advance(2600)
  if (initial) { await view.render(render(initial)); await advance(1200) }
  const run = async (action: keyof NonNullable<CanvasShortcutRef['current']>) => {
    assert.ok(shortcuts.current)
    await inAct(() => shortcuts.current![action]())
    await advance(1200)
  }
  return { view, run, render, shortcuts }
}

test('last desk after fit drives all four arrows, including project desks', async t => {
  const { view, run } = await fixture(t, 'alpha')
  assert.ok(agentOpen(view.el, 'alpha'), 'positive control: alpha is focused')
  await run('fitOrg')
  assert.equal(view.el.querySelectorAll('.sq.desk:not(.user)').length, 0)
  await run('nextNode')
  assert.ok(projectOpen(view.el), 'after fit, Right navigates from alpha to project')
  await run('fitOrg'); await run('childNode')
  assert.ok(agentOpen(view.el, 'child'), 'project memory supplies Down origin')
  await run('fitOrg'); await run('parentNode')
  assert.ok(projectOpen(view.el), 'child memory supplies Up origin')
  await run('fitOrg'); await run('previousNode')
  assert.ok(agentOpen(view.el, 'alpha'), 'project memory supplies Left origin')
})

test('shared pinned or Attention project focus survives losing every desk focus', async t => {
  const { view, run } = await fixture(t)
  await run('fitOrg')
  await inAct(() => { setButtonAgent('last-desk', 'project'); setButtonAgent('last-desk', null) })
  await run('nextNode')
  assert.ok(agentOpen(view.el, 'bravo'), 'the shared desk focus publisher supplies the last project')
})

test('switchboard keeps its own origin and fit does not erase last project', async t => {
  const { view, run } = await fixture(t, 'alpha')
  await run('fitOrg'); await run('switchboard'); await run('childNode')
  assert.ok(projectOpen(view.el), 'Down starts at switchboard and selects centre root')
  await run('fitOrg'); await run('nextNode')
  assert.ok(agentOpen(view.el, 'bravo'), 'switchboard visit did not erase later project memory')
})

test('no earlier desk preserves the current overview behavior', async t => {
  const { view, run } = await fixture(t)
  await run('fitOrg')
  const before = transform(view.el)
  await run('nextNode')
  assert.equal(transform(view.el), before)
})

test('remembered origins reject removed, retired, hidden, unplaced and draft nodes; current origin wins', () => {
  const memory = new NavigationDeskMemory()
  const node = { id: 'a', tier: 'sol', state: 'live', children: [] } as unknown as CanvasNode
  const map = new Map([['a', node]]), positions = new Map([['a', { x: 0, y: 0 }]])
  const origin = (org = 'one', current: string | null = null, hidden = new Set<string>()) =>
    memory.origin(org, current, map, positions, hidden)
  memory.record('one', node)
  assert.equal(origin(), 'a'); assert.equal(origin('two'), null)
  assert.equal(origin('one', USER), USER)
  assert.equal(origin('one', null, new Set(['a'])), null)
  positions.clear(); assert.equal(origin(), null); positions.set('a', { x: 0, y: 0 })
  for (const state of ['archived', 'draft'] as const) {
    map.set('a', { ...node, state }); assert.equal(origin(), null)
  }
  map.delete('a'); assert.equal(origin(), null)
  map.set('a', node); assert.equal(origin('one', ''), 'a', 'fit sentinel also permits fallback')
  memory.record('one', { ...node, id: 'invalid', state: 'archived' })
  assert.equal(origin(), 'a', 'an invalid focus publication cannot replace the live visit')
})
