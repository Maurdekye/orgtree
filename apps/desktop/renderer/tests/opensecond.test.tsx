import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MenuFixture, SwitchboardFixture } from './opensecond.fixture'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'

const labels = (menu: Element) => [...menu.querySelectorAll('[role="menuitem"]')]
  .filter(el => el.closest('[role="menu"]') === menu).map(el => el.textContent!.replace(/\s*▸$/, ''))
const openMenu = async (target: Element) => {
  await inAct(() => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  await flush(3)
  return document.querySelector('.ctxmenu')!
}
for (const kind of ['agent', 'project', 'mention', 'owner', 'sender', 'async', 'switchboard']) {
  test(`Open is second in ${kind} menu, preserving first and other action order`, async t => {
    const old = globalThis.fetch; installFetch(new FakeServer()); localStorage.clear()
    const v = await mountView(kind === 'switchboard' ? <SwitchboardFixture /> : <MenuFixture kind={kind} />, el => el)
    t.after(async () => { await v.unmount(); globalThis.fetch = old; localStorage.clear() })
    let menu = await openMenu(v.el.querySelector('[data-target], .user-node, .user') ?? v.el.firstElementChild!)
    if (kind === 'owner' || kind === 'sender') {
      const parent = menu.querySelector('button')!
      await inAct(() => parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
      menu = menu.querySelector('[role="menu"]')!
    }
    const got = labels(menu)
    assert.equal(got.indexOf('Open'), 1, JSON.stringify(got))
    assert.equal(got[0], kind === 'mention' ? 'Mention' : kind === 'async' || kind === 'switchboard' ? 'Focus' : 'Copy mention')
    assert.deepEqual(got.filter(label => label !== 'Open'), kind === 'switchboard'
      ? ['Focus', 'Hire an agent', 'New project…', 'Agents list', 'Compact all agents…', 'Halt all agents…', 'Retire all agents…']
      : [...(kind === 'mention' ? ['Mention', 'Copy mention'] : kind === 'async' ? [] : ['Copy mention']),
        'Focus', ...(kind === 'project' ? ['Hire under this project', 'New project…'] : ['Hire a subordinate', 'New project…']), 'Settings'])
    const parent = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent?.trim() === 'Open ▸')!
    await inAct(() => parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(parent.getAttribute('aria-expanded'), 'true', 'submenu behavior retained')
  })
}

test('only Open submenus move; separators and remaining actions retain relative order', async t => {
  const noop = () => {}
  const input: MenuEntry[] = [{ label: 'First', onSelect: noop }, 'sep', { label: 'Middle', onSelect: noop },
    { label: 'Open', onSelect: noop, children: [{ label: 'Desk', onSelect: noop }] },
    { label: 'Last', onSelect: noop }]
  function Fixture() { const m = useContextMenu(); return <><button onContextMenu={e => m.open(e, input)}>target</button>{m.node}</> }
  const v = await mountView(<Fixture />, el => el); t.after(() => v.unmount())
  const menu = await openMenu(v.el.querySelector('button')!)
  assert.deepEqual(labels(menu), ['First', 'Open', 'Middle', 'Last'])
  assert.deepEqual([...menu.children].map(el => el.getAttribute('role') === 'separator' ? 'sep' : el.textContent!.replace(/\s*▸$/, '')),
    ['First', 'Open', 'sep', 'Middle', 'Last'])
  assert.deepEqual(input.map(e => e === 'sep' ? e : e.label), ['First', 'sep', 'Middle', 'Open', 'Last'], 'caller array unchanged')
})

test('ordinary Open action keeps its place', async t => {
  function Fixture() { const m = useContextMenu(); return <><button onContextMenu={e => m.open(e,
    ['First', 'Middle', 'Open'].map(label => ({ label, onSelect: () => {} })))}>target</button>{m.node}</> }
  const v = await mountView(<Fixture />, el => el); t.after(() => v.unmount())
  assert.deepEqual(labels(await openMenu(v.el.querySelector('button')!)), ['First', 'Middle', 'Open'])
})
