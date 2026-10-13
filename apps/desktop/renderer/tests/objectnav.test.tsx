import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CurrentOrg } from '../src/popout'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectNavProvider, objectNavProps } from '../src/canvas/objectnav'
import { ObjectMenuBoundary, useContextMenu } from '../src/canvas/contextmenu'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { WorkRefText } from '../src/canvas/workrefs'
import { DogChip, DeskDogsProvider } from '../src/canvas/deskdogs'
import { ticketActions, watchdogActions } from '../src/canvas/objectactions'
import { AgentNavProvider, agentNavProps, useProvideAgentNav } from '../src/canvas/agentnav'
import type { Watchdog, WorkItem } from '../src/types'

const item = { slug: 'task', title: 'A task title', status: 'open', archived: false, owner: { node: 'worker' } } as WorkItem
const dog = { id: 'worker/check', name: 'check', owner: 'worker', state: 'armed', kind: 'file', spent: false } as Watchdog
const world = { org: 'org', items: new Map([['task', item.title]]) }
const labels = (root: Document = document) => [...root.querySelectorAll('[role="menuitem"]')].map(el => el.textContent)
async function right(el: Element) {
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 })
  await inAct(() => { el.dispatchEvent(event) }); await flush()
  return event.defaultPrevented
}

test('React, Markdown and bare ticket links use the canonical menu without navigating; watchdog owner stays exact', async t => {
  const prior = globalThis.fetch
  const writes: string[] = [], opened: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push(String(url))
    return new Response(JSON.stringify({ item, state: 'paused' }), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const view = await mountView(<CurrentOrg.Provider value="org"><ObjectNavProvider>
    <ObjectNavHost org="org" dogs={[dog]} openDog={id => opened.push(id)} openTicket={id => opened.push(id)} focusAgent={id => opened.push(id)} toast={() => {}} />
    <DeskDogsProvider value={{ org: 'org', dogs: [dog], open: id => opened.push(id) }}>
    <ObjectMenuBoundary>
      <RefChip r={resolveRef({ kind: 'item', org: 'org', id: 'task' }, world)} onOpen={() => opened.push('react')} />
      <RefMdBody html={{ __html: '<p>@item:org/task</p>' }} world={world} onOpen={() => opened.push('markdown')} />
      <WorkRefText text="task" index={new Map([['task', { kind: 'item', slug: 'task', title: item.title }]])} onPick={() => opened.push('bare')} />
      <DogChip dog={dog} onOpen={id => opened.push(id)} />
    </ObjectMenuBoundary></DeskDogsProvider></ObjectNavProvider></CurrentOrg.Provider>, el => el.textContent)
  t.after(view.unmount)
  const expected = ['Copy ticket title', ...ticketActions({ item, open: () => {}, owner: { open: () => {} }, copySlug: () => {}, copyReference: () => {} })
    .filter(e => e !== 'sep').map(e => e === 'sep' ? '' : e.label)]
  const tickets = [...view.el.querySelectorAll('[data-object-nav="ticket"]')]
  assert.equal(tickets.length, 3)
  for (const link of tickets) {
    assert.ok(await right(link))
    assert.deepEqual(labels(), expected)
    assert.deepEqual(opened, []); assert.deepEqual(writes, [])
  }
  await right(view.el.querySelector('[data-object-nav="watchdog"]')!)
  assert.deepEqual(labels(), ['Open details', ...watchdogActions(dog, () => {}).filter(e => e !== 'sep').map(e => e === 'sep' ? '' : e.label), 'Copy watchdog name', 'Copy watchdog id'])
  assert.deepEqual(writes, [])
  await inAct(() => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === 'Open details')!.click() })
  assert.deepEqual(opened, ['worker/check'])
  await inAct(() => { (tickets[0] as HTMLElement).click() })
  assert.deepEqual(opened, ['worker/check', 'react'])
})

test('inner object wins over row actions; invalid/foreign ids and removed watchdogs gain no actions', async t => {
  let calls = 0
  const prior = globalThis.fetch
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ item }), { status: 200 }) }) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  function Row() {
    const menu = useContextMenu()
    return <div onContextMenu={e => menu.open(e, [{ label: 'Row only', onSelect: () => {} }])}>
      <button {...objectNavProps('ticket', 'task', 'org')}>valid</button>
      <button {...objectNavProps('ticket', '../other', 'org')}>invalid</button>
      <button {...objectNavProps('ticket', 'task', 'other')}>foreign</button>
      <button {...objectNavProps('watchdog', 'other/check', 'org')}>removed</button>
      <input defaultValue="editable" />{menu.node}
    </div>
  }
  const view = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[dog]} openDog={() => {}} openTicket={() => {}} toast={() => {}} /><Row /></ObjectNavProvider>, el => el.textContent)
  t.after(view.unmount)
  await right(view.el.querySelector('[data-object-id="task"][data-object-org="org"]')!)
  assert.ok(labels().includes('Open details')); assert.ok(!labels().includes('Row only'))
  const before = calls
  for (const selector of ['[data-object-id="../other"]', '[data-object-org="other"]', '[data-object-id="other/check"]']) {
    await right(view.el.querySelector(selector)!)
    assert.deepEqual(labels(), ['Row only'])
  }
  assert.equal(calls, before)
  assert.equal(await right(view.el.querySelector('input')!), false)
  assert.deepEqual(watchdogActions({ ...dog, spent: true }, () => {}), [])
})

test('late ticket lookup cannot replace a newer menu or a menu from a changed org', async t => {
  let release: (value: Response) => void = () => {}
  const prior = globalThis.fetch
  globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve })) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const fixture = (org: string) => <ObjectNavProvider><ObjectNavHost org={org} dogs={[dog]} openDog={() => {}} openTicket={() => {}} toast={() => {}} />
    <ObjectMenuBoundary><button {...objectNavProps('ticket', 'task', 'org')}>ticket</button><DogChip dog={dog} onOpen={() => {}} /></ObjectMenuBoundary></ObjectNavProvider>
  const view = await mountView(fixture('org'), el => el.textContent)
  t.after(view.unmount)
  await right(view.el.querySelector('[data-object-nav="ticket"]')!)
  assert.deepEqual(labels(), ['Loading current object…'])
  await right(view.el.querySelector('[data-object-nav="watchdog"]')!)
  await inAct(() => { release(new Response(JSON.stringify({ item }), { status: 200 })) }); await flush()
  assert.ok(labels().includes('Pause')); assert.ok(!labels().includes('Copy ticket title'))
  await right(view.el.querySelector('[data-object-nav="ticket"]')!)
  await view.render(fixture('other'))
  await inAct(() => { release(new Response(JSON.stringify({ item }), { status: 200 })) }); await flush()
  assert.equal(document.querySelector('[role="menu"]'), null)
})

test('rejected ticket lookup cannot replace a newer menu or survive an org change', async t => {
  let reject: (reason: Error) => void = () => {}
  const prior = globalThis.fetch
  globalThis.fetch = (() => new Promise<Response>((_, fail) => { reject = fail })) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const fixture = (org: string) => <ObjectNavProvider><ObjectNavHost org={org} dogs={[dog]} openDog={() => {}} openTicket={() => {}} toast={() => {}} />
    <ObjectMenuBoundary><button {...objectNavProps('ticket', 'task', 'org')}>ticket</button><DogChip dog={dog} onOpen={() => {}} /></ObjectMenuBoundary></ObjectNavProvider>
  const view = await mountView(fixture('org'), el => el.textContent)
  t.after(view.unmount)
  await right(view.el.querySelector('[data-object-nav="ticket"]')!)
  await right(view.el.querySelector('[data-object-nav="watchdog"]')!)
  await inAct(() => { reject(new Error('missing')) }); await flush()
  assert.ok(labels().includes('Pause')); assert.ok(!labels().includes('Object unavailable'))
  await right(view.el.querySelector('[data-object-nav="ticket"]')!)
  await view.render(fixture('other'))
  await inAct(() => { reject(new Error('missing')) }); await flush()
  assert.equal(document.querySelector('[role="menu"]'), null)
})

test('agent links keep their existing menu and editing, ordinary links and selected text keep native deferral', async t => {
  function Register() {
    useProvideAgentNav(() => [{ label: 'Agent action', onSelect: () => {} }])
    return null
  }
  const view = await mountView(<AgentNavProvider><ObjectNavProvider><Register />
    <ObjectNavHost org="org" dogs={[dog]} openDog={() => {}} openTicket={() => {}} toast={() => {}} />
    <ObjectMenuBoundary><button {...agentNavProps('worker')}>worker</button>
      <span {...objectNavProps('watchdog', dog.id, 'org')}>selectable watchdog
        <input defaultValue="editable" /><a href="https://example.invalid/">ordinary link</a>
      </span>
    </ObjectMenuBoundary></ObjectNavProvider></AgentNavProvider>, el => el.textContent)
  t.after(async () => { window.getSelection()?.removeAllRanges(); await view.unmount() })
  await right(view.el.querySelector('[data-agent-nav]')!)
  assert.deepEqual(labels(), ['Copy agent name', 'Agent action'])
  for (const selector of ['input', 'a']) assert.equal(await right(view.el.querySelector(selector)!), false)
  const target = view.el.querySelector('[data-object-nav]')!
  const range = document.createRange(); range.selectNodeContents(target)
  window.getSelection()?.addRange(range)
  assert.equal(await right(target), false)
})
