import { FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { RetiredBadge } from '../src/canvas/retiredbadge'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import { UserNode } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'

declare const __SRC_DIR__: string
const noop = () => {}
const node = { id: 'owner', state: 'live', tier: 'haiku', children: [] } as unknown as CanvasNode

test('retired count is a plain accessible label with no focus or hover-button behavior', async t => {
  const view = await mountView(<RetiredBadge parent="owner" count={3} />, el => el)
  t.after(() => view.unmount())
  const badge = view.el.querySelector<HTMLElement>('.retired-badge')!
  assert.equal(badge.tagName, 'SPAN')
  assert.equal(badge.getAttribute('tabindex'), null)
  assert.equal(badge.getAttribute('role'), null)
  assert.equal(badge.getAttribute('title'), null)
  assert.equal(badge.getAttribute('aria-label'), '3 retired agents')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = css.slice(css.indexOf('.retired-badge {'), css.indexOf('}', css.indexOf('.retired-badge {')))
  assert.match(rule, /pointer-events:\s*none/)
  assert.match(rule, /cursor:\s*default/)
  assert.doesNotMatch(css, /\.retired-badge:(?:hover|focus)/)
})

test('retired count has no action and passes click, pointer-down and context-menu to its parent', async t => {
  let opened = 0, clicks = 0, downs = 0, menus = 0
  // The legacy prop is deliberately supplied through a spread as a negative control:
  // the old button invokes it, the new inert component has no such callback.
  const props = { parent: 'owner', count: 3, onOpen: () => { opened++ } }
  const view = await mountView(<div onClick={() => { clicks++ }} onPointerDown={() => { downs++ }}
    onContextMenu={() => { menus++ }}><RetiredBadge {...props} /></div>, el => el)
  t.after(() => view.unmount())
  const badge = view.el.querySelector<HTMLElement>('.retired-badge')!
  await inAct(() => badge.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  assert.equal(opened, 0)
  assert.equal(clicks, 1)
  await inAct(() => badge.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  await inAct(() => badge.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  assert.equal(downs, 1)
  assert.equal(menus, 1)
})

for (const [kind, builder] of [['agent', agentMenuEntries], ['project', projectMenuEntries]] as const) {
  test(`${kind} menu opens the retired list after Open, only with a positive count and handler`, () => {
    let opens = 0
    const h = { onInbox: noop, onSettings: noop, retiredCount: 3, onRetiredList: () => { opens++ } }
    const owner = { ...node, kind: kind === 'project' ? 'project' : undefined } as CanvasNode
    const entries = builder(owner, h)
    const labels = entries.map(e => typeof e === 'string' ? e : e.label)
    const ix = labels.indexOf('Open retired list (3)')
    assert.ok(ix > 0)
    assert.equal(labels[ix - 1], 'Open')
    const entry = entries[ix]
    assert.ok(entry && typeof entry !== 'string')
    entry.onSelect?.()
    assert.equal(opens, 1)
    for (const absent of [{ ...h, retiredCount: 0 }, { ...h, onRetiredList: undefined }]) {
      const labels = builder(owner, absent).map(e => typeof e === 'string' ? e : e.label)
      assert.equal(labels.some(s => String(s).startsWith('Open retired list')), false)
    }
  })
}

test('org root menu opens the retired list after New project and omits it for zero count', async () => {
  installFetch(new FakeServer())
  let opens = 0
  for (const count of [3, 0]) {
    const props = { pos: { x: 0, y: 0 }, isDrop: false, stats: { circ: 0, seats: 0, free: 0 },
      pip: null, seats: {}, pxc: 1, zoom: 1, onSpawn: noop, onMailLink: noop, onWorkLink: noop,
      focused: false, eyeW: 120, posX: () => 0, map: new Map(), op: async () => ({}),
      slug: 'fixture', toast: noop, onNewProject: noop, retiredCount: count, onRetired: () => { opens++ } }
    const view = await mountView(<UserNode {...props as Parameters<typeof UserNode>[0]} />, el => el)
    try {
      await inAct(() => view.el.querySelector('.sq.user')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu button')]
      const retired = buttons.find(b => b.textContent?.trim() === 'Open retired list (3)')
      assert.equal(Boolean(retired), count > 0)
      if (retired) {
        const ix = buttons.indexOf(retired)
        assert.match(buttons[ix - 1]!.textContent ?? '', /New project/)
        await inAct(() => retired.click())
      }
    } finally { await view.unmount() }
  }
  assert.equal(opens, 1)
})
