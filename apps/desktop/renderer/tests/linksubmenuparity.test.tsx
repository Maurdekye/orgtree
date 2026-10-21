import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, inAct, mountView } from './harness'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { AgentLink } from '../src/canvas/identity'
import { ObjectMenuBoundary, useContextMenu } from '../src/canvas/contextmenu'
import type { MenuEntry } from '../src/canvas/contextmenu'
import { nodeMenuAction, senderMenuAction, ticketOwnerAction } from '../src/canvas/objectactions'
import { useDeskMentionScope } from '../src/canvas/agentmentions'

const root = () => document.querySelector<HTMLElement>('.ctxmenu:not(.ctxmenu-submenu)')!
const items = (el: Element) => [...el.children].flatMap(child =>
  child.getAttribute('role') === 'separator' ? ['sep'] : child.classList.contains('ctxmenu-branch')
    ? [child.querySelector('[role="menuitem"]')!.textContent!.trim()] : [])
async function right(el: Element) {
  await inAct(() => el.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2,
  })))
  await flush()
}

// USER 2026-10-21 06:48:13Z: Owner/Presenter/etc. are link surfaces too.
// Compare rendered separators as well as labels; merely reusing the registry
// did not keep either the copy prefix or composer-scoped Mention consistent.
for (const kind of ['agent', 'project'] as const) for (const composer of [false, true]) {
  test(`${kind} submenu links share direct menu items and icon-only tooltip (composer=${composer})`, async t => {
    const id = kind === 'project' ? 'website' : 'worker'
    const title = kind === 'project' ? 'Project · 2 slots · Company site' : 'ChatGPT Sol 6 · high'
    const called: string[] = []
    const actions: MenuEntry[] = [
      { label: 'Focus', onSelect: () => called.push('focus') },
      { label: 'Open', onSelect: () => called.push('open'), children: [{ label: 'Desk', onSelect: () => {} }] },
      { label: 'Settings', onSelect: () => {} },
    ]
    function Targets() {
      useProvideAgentNav(() => actions, () => ({ title }))
      const scope = useDeskMentionScope(composer ? who => () => called.push('mention:' + who) : null)
      const menu = useContextMenu()
      return <div {...scope}><ObjectMenuBoundary>
        <AgentLink id={id} tier={kind === 'project' ? 'project' : 'sol'} onFocus={() => {}} />
        {['Owner…', 'Presenter…', 'Project…', 'Sender…'].map(label => <button key={label} data-wrapper={label}
          onContextMenu={e => menu.open(e, () => {
            const entry = label === 'Sender…' ? senderMenuAction(e.currentTarget, id, actions)
              : label === 'Owner…' ? ticketOwnerAction(e.currentTarget, id, actions)
                : nodeMenuAction(label, e.currentTarget, id, actions)
            return entry ? [entry] : []
          })}>{label}</button>)}
      </ObjectMenuBoundary>{menu.node}</div>
    }
    const v = await mountView(<AgentNavProvider><Targets /></AgentNavProvider>, el => el)
    t.after(() => v.unmount())
    const direct = v.el.querySelector<HTMLElement>('[data-agent-nav]')!
    await right(direct)
    const expected = items(root())
    assert.equal(expected.includes('Mention'), composer)
    assert.equal(expected.filter(value => value === 'Copy mention').length, 1)
    await inAct(() => direct.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    assert.equal(direct.title, title, 'visible names omit the identity prefix')
    for (const link of v.el.querySelectorAll<HTMLElement>('[data-wrapper]')) {
      await right(link)
      const parent = root().querySelector<HTMLElement>('[role="menuitem"]')!
      await inAct(() => parent.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
      assert.equal(parent.title, `${id}\n${title}`, 'submenu labels do not immediately display the target name')
      await inAct(() => parent.closest('.ctxmenu-branch')!.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })))
      await flush()
      const sub = root().querySelector<HTMLElement>('.ctxmenu-submenu')!
      assert.ok(sub, 'real child menu opened')
      assert.deepEqual(items(sub), expected, `${link.textContent} is the direct ${kind} menu, including separators`)
      assert.deepEqual(called, [], 'hover and right click execute no action')
    }
    const parent = root().querySelector<HTMLButtonElement>('[role="menuitem"]')!
    await inAct(() => parent.click())
    assert.deepEqual(called, ['focus'], 'parent keeps the canonical Focus action')
  })
}
