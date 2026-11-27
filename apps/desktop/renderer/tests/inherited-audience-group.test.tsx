import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HeldAudienceChips } from '../src/canvas/desk'
import { audienceGrantTooltip, type CanvasNode } from '../src/canvas/shared'

// USER 2026-11-27 md04a9104c63a: "project indirect audiences shouldnt be listed as header badges,
// they cloud up all the space. just list the project audience as one badge and list the agents
// that it has an indirect audience through via the hover tooltip".
const agent = (id: string, state = 'live') => ({ id, kind: 'agent', state }) as unknown as CanvasNode
const map = new Map<string, CanvasNode>(['api-eng', 'diverge-eng', 'xr-eng', 'boss', 'other']
  .map(id => [id, agent(id)]))
map.set('integration-queue', { id: 'integration-queue', kind: 'project', state: 'live' } as unknown as CanvasNode)
map.set('gone', agent('gone', 'retired'))

const mount = (held: string[], explicit: string[], inherited: [string, string][]) => mountView(
  <HeldAudienceChips slug="demo" toast={() => {}} map={map} node={{
    id: 'integrator-4', audiences_held: held, audiences_explicit: explicit,
    audiences_inherited: inherited.map(([grantor, project]) => ({ grantor, project })),
  }} />, el => el)
const badges = (el: Element) => [...el.querySelectorAll<HTMLElement>('.badge')]
const label = (b: HTMLElement) => (b.textContent ?? '').trim()

test('N agents inherited from one project render as ONE project badge listing them all in its tooltip', async t => {
  const view = await mount(['api-eng', 'diverge-eng', 'xr-eng'], [],
    [['api-eng', 'integration-queue'], ['diverge-eng', 'integration-queue'], ['xr-eng', 'integration-queue']])
  t.after(() => view.unmount())
  const all = badges(view.el)
  assert.equal(all.length, 1, `one badge, got: ${all.map(label).join(' | ')}`)
  const b = all[0]
  assert.match(label(b), /integration-queue/)
  assert.match(label(b), /3/)
  assert.equal(b.title, ['Inherited from project integration-queue',
    'Can message these agents directly, even though they are outside your normal chain:',
    'api-eng', 'diverge-eng', 'xr-eng'].join('\n'))
  assert.equal(b.getAttribute('aria-label'), b.title, 'keyboard focus exposes the same text')
  assert.equal(b.tabIndex, 0)
  assert.ok(!b.querySelector('.chip-x'), 'inherited access has no personal revoke')
})

test('direct (explicit) audiences keep their individual badges beside the project badge', async t => {
  const view = await mount(['boss', 'api-eng', 'xr-eng'], ['boss'],
    [['api-eng', 'integration-queue'], ['xr-eng', 'integration-queue']])
  t.after(() => view.unmount())
  const all = badges(view.el)
  assert.equal(all.length, 2, all.map(label).join(' | '))
  const direct = all.find(b => label(b) === 'boss')
  assert.ok(direct, 'the direct audience keeps its own badge')
  assert.equal(direct.title, audienceGrantTooltip('boss', 'agent'))
  assert.equal(direct.querySelector('button')?.title, 'Revoke')
  assert.ok(all.some(b => /integration-queue/.test(label(b)) && /api-eng\nxr-eng$/.test(b.title)))
})

test('two source projects give two badges, each listing only its own agents', async t => {
  const view = await mount(['api-eng', 'diverge-eng', 'xr-eng'], [],
    [['api-eng', 'integration-queue'], ['diverge-eng', 'pool'], ['xr-eng', 'pool']])
  t.after(() => view.unmount())
  const all = badges(view.el)
  assert.equal(all.length, 2, all.map(label).join(' | '))
  const iq = all.find(b => /integration-queue/.test(label(b)))!, pool = all.find(b => /pool/.test(label(b)))!
  assert.match(iq.title, /\napi-eng$/)
  assert.doesNotMatch(iq.title, /diverge-eng|xr-eng/)
  assert.match(pool.title, /\ndiverge-eng\nxr-eng$/)
})

test('an agent also held explicitly keeps its own badge and is still listed under the project', async t => {
  const view = await mount(['api-eng', 'xr-eng'], ['api-eng'],
    [['api-eng', 'integration-queue'], ['xr-eng', 'integration-queue']])
  t.after(() => view.unmount())
  const all = badges(view.el)
  assert.equal(all.length, 2, all.map(label).join(' | '))
  const own = all.find(b => label(b) === 'api-eng')!
  assert.equal(own.title, ['Inherited from project integration-queue', audienceGrantTooltip('api-eng', 'agent'),
    'Also held explicitly'].join('\n'))
  assert.match(all.find(b => b !== own)!.title, /\napi-eng\nxr-eng$/)
})

test('a retired agent reached through the project is named retired in the tooltip, not as its own badge', async t => {
  const view = await mount(['api-eng', 'gone'], [], [['api-eng', 'integration-queue'], ['gone', 'integration-queue']])
  t.after(() => view.unmount())
  const all = badges(view.el)
  assert.equal(all.length, 1, all.map(label).join(' | '))
  assert.match(all[0].title, /\napi-eng\ngone \(retired\)$/)
})

test('the inherited user audience keeps its own badge (it is not an agent)', async t => {
  const view = await mount(['@user', 'api-eng'], [], [['@user', 'integration-queue'], ['api-eng', 'integration-queue']])
  t.after(() => view.unmount())
  const all = badges(view.el)
  assert.equal(all.length, 2, all.map(label).join(' | '))
  assert.equal(all.find(b => label(b) === 'user')?.title,
    `Inherited from project integration-queue\n${audienceGrantTooltip('@user')}`)
})
