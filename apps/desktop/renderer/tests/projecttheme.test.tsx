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
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectSquare } from '../src/canvas/projectcard'
import { NodeConfig } from '../src/canvas/modals'
import { TierChip, createTierChipEl } from '../src/canvas/identity'
import { hydrateTree } from '../src/archived'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string

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

/* ── FOLLOW-UP (@item:orgtree/project-themes-colour-the-whole-project-node-by-i;
   USER 2026-11-03 09:22:44Z mc4fd305e1c09 "1. project nodes should be
   color-coded to their icons, 2 shouls be able to uplosd a cuwtom icon") ── */

const css = () => readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
const rule = (sheet: string, selector: string) => {
  const at = sheet.indexOf(selector + ' {')
  assert.ok(at >= 0, selector + ' rule exists')
  return sheet.slice(at, sheet.indexOf('}', at))
}

test('§6 the theme colour colours the project node itself, as an agent card wears its provider accent', async (t) => {
  for (const lod of ['norm', 'mini'] as const) {
    const card = (await square(t, themed(), lod)).querySelector<HTMLElement>('.sq.project')!
    assert.ok(card, 'the card')
    assert.equal(card.style.getPropertyValue('--provider-accent').trim().toLowerCase(), ROSE,
      `${lod}: the card carries the theme colour on the agent card's own accent variable`)
  }
  const plain = (await square(t, project(), 'norm')).querySelector<HTMLElement>('.sq.project')!
  assert.equal(plain.style.getPropertyValue('--provider-accent'), '', 'an unthemed project looks as it did')
})

test('§7 the project card rules read the accent variable; busy and asking keep their state colour', () => {
  const sheet = css()
  assert.match(rule(sheet, '.sq.project'), /var\(--provider-accent\)/, 'the card wash follows the accent')
  assert.match(rule(sheet, '.sq.project.norm'), /var\(--provider-accent\)/, 'the norm border follows the accent')
  assert.match(rule(sheet, '.sq.project .project-mini'), /var\(--provider-accent\)/, 'the mini glyph follows the accent')
  for (const state of ['.sq.project.busy', '.sq.project.asking']) {
    const r = rule(sheet, state)
    assert.match(r, /var\(--accent\)/, state + ' keeps the semantic state colour')
    assert.doesNotMatch(r, /provider-accent/, state + ' is not re-tinted by the theme')
  }
})

const SHA = 'a'.repeat(64)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const uploaded = () => project({ theme_color: ROSE, theme_icon: 'rocket', theme_icon_custom: SHA })

/** the project-icon routes, over the harness server */
function serveIcons(t: TestContext) {
  serve(t)
  const inner = (globalThis as { fetch: typeof fetch }).fetch
  const calls: { method: string; url: string; body: unknown }[] = []
  ;(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('/project-icon')) return inner(input as RequestInfo, init)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, url, body })
    const json = method === 'GET'
      ? { picture: { revision: '1', sha256: SHA, width: 256, height: 256, bytes: 68, data: PNG_B64 } }
      : { node: 'website', theme_icon_custom: body?.data ? SHA : null }
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return calls
}

test('§8 an uploaded icon shows in its own colours on the node, the mark and the DOM chip', async (t) => {
  const calls = serveIcons(t)
  hydrateTree({ slug: 'org', roots: [uploaded()] } as unknown as TreePayload)
  for (const lod of ['mini', 'norm'] as const) {
    const view = await mountView(<ProjectSquare node={uploaded()} pos={{ x: 0, y: 0 }} lod={lod}
      dragging={false} isDrop={false} op={() => Promise.resolve({} as OpResult)} slug="org"
      toast={noop} zoom={lod === 'mini' ? 0.4 : 1.2} hire={{}} seats={{}}
      onHire={noop} onNewProject={noop} onInbox={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />, (el) => el)
    t.after(() => view.unmount())
    await inAct(async () => { await flush(8) })
    const where = lod === 'mini' ? '.project-mini' : '.sq-head .project-mark'
    const img = view.el.querySelector<HTMLImageElement>(where + ' img.project-icon-img')
    assert.ok(img, `${lod}: the uploaded image replaces the glyph`)
    assert.equal(img.getAttribute('src'), 'data:image/png;base64,' + PNG_B64, 'a PNG data URL, never markup')
    assert.ok(!view.el.querySelector(where + ' svg'), 'no built-in glyph beside it')
    assert.equal(view.el.querySelector<HTMLElement>('.sq.project')!.style.getPropertyValue('--provider-accent').trim().toLowerCase(), ROSE,
      'the theme colour still colours the node')
  }
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.includes('/api/orgs/org/project-icon') && c.url.includes('node=website')),
    'the image is read by its own route, not carried on the tree')
  const chip = await mountView(<TierChip tier="project" agentName="website" />, (el) => el)
  t.after(() => chip.unmount())
  await inAct(async () => { await flush(4) })
  assert.ok(chip.el.querySelector('.project-mark img.project-icon-img'), 'the link chip wears the upload')
  const dom = createTierChipEl(document, 'project', 'website')!
  assert.ok(dom.querySelector('img.project-icon-img'), 'and so does the DOM chip of markdown @project links')
})

function pickFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

test('§9 settings: Upload icon… sends a PNG/JPEG/WebP to the project-icon route; oversized and wrong types are refused', async (t) => {
  const calls = serveIcons(t)
  const node = project()
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
    op={async () => ({} as OpResult)} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  assert.ok(button('Upload icon…'), 'an Upload icon… choice beside the built-in icons')
  const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="Upload icon file"]')!
  assert.ok(input, 'a file field')
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
    assert.ok(input.accept.includes(type), 'accepts ' + type)
  await inAct(async () => { pickFile(input, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })); await flush(6) })
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'an oversized file never leaves the renderer')
  assert.ok(document.body.textContent!.includes('2 MB'), 'with a clear message naming the limit')
  await inAct(async () => { pickFile(input, new File(['GIF89a'], 'anim.gif', { type: 'image/gif' })); await flush(6) })
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'a GIF is refused')
  assert.match(document.body.textContent!, /PNG, JPEG, WebP or SVG/, 'naming the accepted formats')
  const png = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))
  await inAct(async () => { pickFile(input, new File([png], 'logo.png', { type: 'image/png' })); await flush(4) })
  // FileReader answers on a timer in jsdom
  for (let i = 0; i < 50 && !calls.some((c) => c.method === 'POST'); i++)
    await inAct(async () => { await new Promise((r) => setTimeout(r, 10)); await flush(2) })
  const post = calls.find((c) => c.method === 'POST')
  assert.ok(post, 'a PNG is uploaded')
  assert.deepEqual(post!.body, { node: 'website', data: PNG_B64 }, 'the raw bytes, base64: the engine normalises them')
})

test('§10 settings: an uploaded icon shows as chosen and can be removed back to the built-in icon', async (t) => {
  const calls = serveIcons(t)
  hydrateTree({ slug: 'org', roots: [uploaded()] } as unknown as TreePayload)
  const ops: OpRequest[] = []
  const node = uploaded()
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
    op={async (b) => { ops.push(b); return {} as OpResult }} toast={noop} close={noop} />, (el) => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  const tile = button('Icon: Uploaded')
  assert.ok(tile, 'the upload is a tile in the grid')
  assert.equal(tile.getAttribute('aria-pressed'), 'true', 'and it is the chosen one')
  assert.equal(button('Icon: Rocket').getAttribute('aria-pressed'), 'false', 'the built-in under it is not drawn as chosen')
  await inAct(async () => { button('Remove uploaded icon').click(); await flush(8) })
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.body), [{ node: 'website', data: null }],
    'removing clears the upload through the same route')
  // choosing a built-in icon while an upload is set replaces it on save
  await inAct(() => button('Icon: Folder (default)').click())
  await inAct(async () => { save().click(); await flush(4) })
  assert.deepEqual(ops.map((o) => ({ ...o })), [{ op: 'set_theme', node: 'website', theme_icon: null }],
    'a built-in pick saves through set_theme, which also drops the upload')
})
