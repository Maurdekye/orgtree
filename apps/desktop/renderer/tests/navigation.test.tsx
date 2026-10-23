import { inAct, mountView, JSDOM } from './harness'
import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installAppShortcuts, matchOrgNavigation, matchAppShortcut } from '../src/shell/appshortcuts'
import { AgentFocusHistory, agentFocusHistory, orgNavigationTarget } from '../src/canvas/keyboardnavigation'
import { DeskTabs } from '../src/canvas/deskshell'
import { USER, type CanvasNode } from '../src/canvas/shared'
import { SurfaceDocumentOwner } from '../src/popout'

const key = (target: EventTarget, name: string, options: KeyboardEventInit = {}) => {
  const event = new window.KeyboardEvent('keydown', { key: name, altKey: true,
    bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

test('physical visible tree navigation includes projects, skips hidden/draft/lineage and wraps', () => {
  const node = (id: string, parent: string, extra = {}) => ({ id, parent, state: 'live', children: [], ...extra }) as CanvasNode
  const a = node('a', USER), project = node('project', USER, { kind: 'project' })
  const b = node('b', USER), c = node('c', USER), hidden = node('hidden', USER)
  const draft = node('draft', USER, { state: 'draft' }), bearer = node('bearer', USER, { isBearerOf: 'a' })
  const p1 = node('p1', 'project'), p2 = node('p2', 'project')
  const nodes = [node(USER, '', { children: [a, project, b, c, hidden, draft, bearer] }),
    a, { ...project, children: [p2, p1] }, b, c, hidden, draft, bearer, p1, p2]
  const map = new Map(nodes.map(node => [node.id, node]))
  const positions = new Map(nodes.map((node, index) => [node.id, { x: index * 20, y: 0 }]))
  const nav = (direction: Parameters<typeof orgNavigationTarget>[0], id: string | null, circular = false) =>
    orgNavigationTarget(direction, id, map, positions, new Set(['hidden']), circular)
  assert.equal(nav('previous', 'a'), 'c')
  assert.equal(nav('next', 'c'), 'a')
  assert.equal(nav('next', 'a'), 'project')
  assert.equal(nav('up', 'p1'), 'project')
  assert.equal(nav('up', 'project'), USER)
  assert.equal(nav('down', 'project'), 'p1', 'left member wins the even tie in canvas order')
  assert.equal(nav('down', 'project', true), 'p2', 'ring order follows displayed sibling order')
  assert.equal(nav('down', USER), 'project')
  assert.equal(nav('down', 'a'), null)
  assert.equal(nav('up', USER), null)
  assert.equal(nav('next', null), null)
})

test('agent history pops repeatedly, preserves overview/project visits, skips removed ids and isolates orgs', () => {
  const history = new AgentFocusHistory()
  for (const id of ['a', 'a', 'missing', 'b', 'c']) history.record(id)
  assert.equal(history.back('project', () => true), 'c')
  assert.equal(history.back('c', id => id !== 'missing'), 'b')
  history.record('b') // normal focus publication after going back must not push c again
  assert.equal(history.back('b', id => id !== 'missing'), 'a')
  assert.equal(history.back('a', () => true), null)
  history.record('d')
  assert.equal(history.back('d', () => true), 'a', 'reaching the start does not erase it')
  agentFocusHistory('nav-test-org-a').record('a')
  assert.equal(agentFocusHistory('nav-test-org-b').back(null, () => true), null)
  const bounded = new AgentFocusHistory()
  for (let i = 0; i < 300; i++) bounded.record(String(i))
  let at: string | null = '299', count = 0
  while ((at = bounded.back(at, () => true)) !== null) count++
  assert.equal(count, 255)
})

test('exact modifiers, physical S and removed F bindings; editors, IME, overlays and gestures keep keys', () => {
  const commands: string[] = []
  const stop = installAppShortcuts(window, () => ({
    fitOrg: () => commands.push('fit'), parentNode: () => commands.push('up'),
    switchboard: () => commands.push('switchboard'),
  }))
  const host = document.createElement('div'); document.body.append(host)
  try {
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: 'F6', shiftKey: true })), undefined)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: 'F8', shiftKey: true })), undefined)
    assert.equal(matchAppShortcut(new window.KeyboardEvent('keydown', { key: 'F7', shiftKey: true })), 'lastDesk')
    assert.equal(matchOrgNavigation(new window.KeyboardEvent('keydown', { key: 'ד', code: 'KeyS', shiftKey: true, altKey: true })), 'switchboard')
    assert.equal(matchOrgNavigation(new window.KeyboardEvent('keydown', { key: 'S', code: 'KeyX', shiftKey: true, altKey: true })), undefined)
    for (const attributes of ['input', 'textarea', 'select', 'div contenteditable="true"',
      'div role="textbox"', 'div role="combobox"', 'div role="listbox"', 'div role="slider"', 'div role="spinbutton"',
      'div class="monaco-editor"']) {
      host.innerHTML = `<${attributes}></${attributes.split(' ')[0]}>`
      assert.equal(key(host.firstElementChild!, 'ArrowUp', { shiftKey: true }).defaultPrevented, false, attributes)
    }
    host.innerHTML = ''
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { isComposing: true }, { repeat: true }])
      key(host, 'ArrowUp', { shiftKey: true, ...options })
    const consumed = (event: Event) => event.preventDefault()
    host.addEventListener('keydown', consumed)
    key(host, 'ArrowUp', { shiftKey: true }); host.removeEventListener('keydown', consumed)
    host.innerHTML = '<div role="menu"></div>'
    key(host, 'ArrowUp', { shiftKey: true }); host.innerHTML = ''
    const pointer = (type: string) => {
      const event = new window.Event(type, { bubbles: true })
      Object.assign(event, { pointerId: 7, buttons: type === 'pointerdown' ? 1 : 0 })
      host.dispatchEvent(event)
    }
    pointer('pointerdown'); key(host, 'ArrowUp', { shiftKey: true }); pointer('pointerup')
    assert.deepEqual(commands, [])
    assert.equal(key(host, 'ArrowUp', { shiftKey: true }).defaultPrevented, true)
    key(host, 'ד', { code: 'KeyS', shiftKey: true })
    assert.deepEqual(commands, ['up', 'switchboard'])
  } finally { stop(); host.remove() }
})

test('desk tabs use displayed order, wrap, preserve questions/editors and select only their own desk', async () => {
  const changed: string[] = []
  function Desk({ id, conditional = false }: { id: string; conditional?: boolean }) {
    const [shown, show] = useState('chat')
    const [extra, setExtra] = useState(conditional)
    const tabs = ['chat', 'inbox', ...(extra ? ['slots', 'files'] : [])]
    return <div className={id === 'agent' ? 'desk-over' : 'desk-bare'} data-desk={id}>
      <DeskTabs tabs={tabs.map(id => ({ id, label: id }))} shown={shown}
        onShow={id => { changed.push(id); show(id) }} />
      <button data-toggle onClick={() => setExtra(!extra)}>conditional</button>
      <input /><div className="askcard" tabIndex={0}>question</div><div data-content tabIndex={0} />
    </div>
  }
  const view = await mountView(<><Desk id="agent" /><Desk id="project" conditional /></>, el => el)
  try {
    const agent = view.el.querySelector<HTMLElement>('[data-desk="agent"]')!
    const project = view.el.querySelector<HTMLElement>('[data-desk="project"]')!
    await inAct(() => { assert.equal(key(agent, 'ArrowLeft').defaultPrevented, true) })
    assert.equal(agent.querySelector('.cc-tabs .on')?.getAttribute('data-tab'), 'inbox')
    await inAct(() => key(project, 'ArrowLeft'))
    assert.equal(project.querySelector('.cc-tabs .on')?.getAttribute('data-tab'), 'files')
    await inAct(() => key(project, 'ArrowRight'))
    assert.equal(project.querySelector('.cc-tabs .on')?.getAttribute('data-tab'), 'chat')
    const before = changed.length
    for (const selector of ['input', '.askcard'])
      assert.equal(key(project.querySelector(selector)!, 'ArrowRight').defaultPrevented, false)
    key(project, 'ArrowRight', { shiftKey: true })
    assert.equal(changed.length, before)
    await inAct(() => project.querySelector<HTMLButtonElement>('[data-toggle]')!.click())
    await inAct(() => key(project, 'ArrowLeft'))
    assert.equal(project.querySelector('.cc-tabs .on')?.getAttribute('data-tab'), 'inbox', 'removed tabs leave the cycle')
    await inAct(() => project.querySelector<HTMLElement>('[data-content]')!.focus())
    await inAct(() => key(document.body, 'ArrowRight'))
    assert.equal(project.querySelector('.cc-tabs .on')?.getAttribute('data-tab'), 'chat')
    assert.equal(agent.querySelector('.cc-tabs .on')?.getAttribute('data-tab'), 'inbox')
  } finally { await view.unmount() }
})

test('tab cycling belongs to the detached desk document and cleans up on unmount', async () => {
  const child = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'http://localhost/' })
  const owner = child.window.document
  const changes: string[] = []
  const view = await mountView(<SurfaceDocumentOwner owner={owner}>
    {createPortal(<div className="desk-bare"><DeskTabs shown="summary"
      tabs={['summary', 'inbox', 'slots'].map(id => ({ id, label: id }))}
      onShow={id => changes.push(id)} /><input /></div>, owner.getElementById('host')!)}
  </SurfaceDocumentOwner>, el => el)
  try {
    await inAct(() => { assert.equal(key(owner.body, 'ArrowLeft').defaultPrevented, true) })
    assert.deepEqual(changes, ['slots'])
    key(document.body, 'ArrowRight')
    assert.deepEqual(changes, ['slots'], 'another document does not own this desk')
    owner.querySelector('input')!.focus()
    assert.equal(key(owner.body, 'ArrowRight').defaultPrevented, false)
    assert.deepEqual(changes, ['slots'])
  } finally { await view.unmount(); child.window.close() }
})
