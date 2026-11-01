// projecttheme.test.tsx — CUSTOM PROJECT THEMES AND ICONS
// (@item:orgtree/4-5-1-custom-project-themes-and-icons-backlogged;
// USER 2026-10-28 10:27:49Z m1c0bc6c121e9): the user gives a project a theme
// colour and an icon in its settings. The icon replaces the folder icon
// everywhere a project shows one (the mini node, the corner of the norm
// node and of the desk view, and next to its @project link), drawn in the
// chosen colour. Unset keeps the folder icon in the default colour. The
// engine half is tools/rig/proofs/project-nodes.mjs (the set_theme checks).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projecttheme

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeConfig } from '../src/canvas/modals'
import { TierChip, createTierChipEl } from '../src/canvas/identity'
import { hydrateTree } from '../src/archived'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const FOLDER_D = 'M20 6h-8l-2-2H4'
const ROCKET_D = 'M9.19 6.35'
const ROSE = '#e11d48'

function project(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, parent: 'boss',
    charter: 'The company website.', children: [], lineage: [], turns: [],
    audiences_held: [], mail_pending: 0, last_status: null, occupancy: 0,
    context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}
const themed = () => project({ theme_color: ROSE, theme_icon: 'rocket' })
const tree = { slug: 'org', roots: [] } as unknown as TreePayload

function serve(t: TestContext) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  const server = new FakeServer()
  installFetch(server)
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  return server
}

async function square(t: TestContext, node: CanvasNode, lod: 'mini' | 'norm') {
  serve(t)
  const view = await mountView(<ProjectSquare node={node} pos={{ x: 0, y: 0 }} lod={lod}
    dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
    toast={noop} zoom={lod === 'mini' ? 0.4 : 1.2} hire={{}} seats={{}}
    onHire={noop} onNewProject={noop} onInbox={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
  t.after(() => view.unmount())
  return view.el
}

const themedMark = (root: ParentNode, selector: string) => {
  const el = root.querySelector(selector)
  assert.ok(el, selector + ' is drawn')
  const html = (el as HTMLElement).outerHTML
  assert.ok(html.includes(ROCKET_D), 'the rocket icon, not the folder: ' + html.slice(0, 220))
  assert.match(html, /e11d48|225,\s*29,\s*72/, 'drawn in the theme colour')
}

test('§1 the mini node shows the chosen icon in the theme colour', async (t) => {
  themedMark(await square(t, themed(), 'mini'), '.project-mini')
})

test('§2 the norm node corner shows the chosen icon in the theme colour; an unthemed project keeps the folder', async (t) => {
  themedMark(await square(t, themed(), 'norm'), '.sq-head .project-mark')
  const plain = await square(t, project(), 'norm')
  const mark = plain.querySelector('.sq-head .project-mark')!
  assert.ok(mark.innerHTML.includes(FOLDER_D), 'unset falls back to the folder icon')
})

test('§3 the one project mark (desk head, links, DOM chips) follows the tree theme', async (t) => {
  // every tree goes through hydrateTree; that is what feeds the mark
  hydrateTree({ slug: 'org', roots: [themed()] } as unknown as TreePayload)
  serve(t)
  const view = await mountView(<TierChip tier="project" agentName="website" />, (el) => el)
  t.after(() => view.unmount())
  themedMark(view.el, '.project-mark')
  const dom = createTierChipEl(document, 'project', 'website')!
  assert.ok(dom.innerHTML.includes(ROCKET_D), 'the DOM chip (markdown @project links) wears the icon')
  assert.match(dom.outerHTML, /e11d48|225,\s*29,\s*72/, 'and the colour')
  const other = createTierChipEl(document, 'project', 'unthemed-elsewhere')!
  assert.ok(other.innerHTML.includes(FOLDER_D), 'a project with no theme keeps the folder in DOM chips')
})

async function config(t: TestContext, node: CanvasNode) {
  serve(t)
  const ops: OpRequest[] = []
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
    op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  return ops
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label)!
const save = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!
function setText(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

test('§4 project settings: a searchable icon picker and a colour picker; save sends set_theme', async (t) => {
  const ops = await config(t, project())
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search icons"]')!
  assert.ok(search, 'the icon search')
  assert.ok(button('Icon: Rocket'), 'built-in icons are offered')
  await inAct(() => setText(search, 'rock'))
  assert.ok(button('Icon: Rocket'), 'search keeps the match')
  assert.equal(button('Icon: Palette'), undefined, 'and filters the rest out')
  await inAct(() => button('Icon: Rocket').click())
  assert.equal(button('Icon: Rocket').getAttribute('aria-pressed'), 'true', 'the pick shows as chosen')
  assert.ok(document.querySelector('input[type="color"][aria-label="Custom theme colour"]'), 'a custom colour field')
  await inAct(() => button('Colour: Rose').click())
  await inAct(async () => { save().click(); await flush(4) })
  assert.deepEqual(ops.map((o) => ({ ...o })),
    [{ op: 'set_theme', node: 'website', theme_color: ROSE, theme_icon: 'rocket' }])
})

test('§5 clearing back to the folder and the default colour; an untouched save sends no set_theme', async (t) => {
  const ops = await config(t, themed())
  assert.equal(button('Icon: Rocket').getAttribute('aria-pressed'), 'true', 'the saved icon starts chosen')
  await inAct(async () => { save().click(); await flush(4) })
  assert.deepEqual(ops, [], 'nothing edited, nothing sent')
  await inAct(() => button('Icon: Folder (default)').click())
  await inAct(() => button('Colour: Default').click())
  await inAct(async () => { save().click(); await flush(4) })
  assert.deepEqual(ops.map((o) => ({ ...o })),
    [{ op: 'set_theme', node: 'website', theme_color: null, theme_icon: null }])
})
