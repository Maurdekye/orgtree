import { advance, inAct, mountView, realClock, useFakeClock, JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import { DeskDogsProvider, DogChip, WatchdogRow } from '../src/canvas/deskdogs'
import { ToolRefs } from '../src/canvas/toolrefs'
import { HistoryDog } from '../src/canvas/historydog'
import { registerAgentNativeTooltipDocument } from '../src/canvas/agentnav'
import type { Watchdog } from '../src/types'

const dog: Watchdog = { id: 'worker/clock', owner: 'worker', name: 'clock', kind: 'command',
  target: 'echo synthetic', state: 'armed', interval_s: 60, once: false, fired: 0,
  at: '2026-10-21T00:00:00Z' }
const pointer = (el: Element, type: string, relatedTarget: EventTarget | null = null) =>
  inAct(() => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, relatedTarget })))

test('all watchdog identities freeze native title across ticks and refresh after leaving', async t => {
  useFakeClock()
  const w = { ...dog, next_check_at: new Date(Date.now() + 60_000).toISOString() }
  const view = await mountView(<DeskDogsProvider value={{ org: 'demo', dogs: [w], open: () => {} }}>
    <WatchdogSatellite dog={w} dogs={[w]} org="demo" onOpen={() => {}} />
    <DogChip dog={w} onOpen={() => {}} />
    <ToolRefs refs={[{ kind: 'watchdog', id: 'clock' }]} owner="worker" org="demo" agent={id => id} />
    <HistoryDog dog={{ id: w.id, owner: w.owner, name: w.name, kind: w.kind, once: false }} />
    <WatchdogLink dog={w} atDestination />
    <WatchdogRow id={w.id}><span>row whitespace</span></WatchdogRow>
  </DeskDogsProvider>, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  const anchors = [...view.el.querySelectorAll<HTMLElement>('.wd-chip, .watchdog-link, [data-object-id]')]
  assert.ok(anchors.length >= 6)
  for (const anchor of anchors) await pointer(anchor, 'pointerover')
  const titles = anchors.map(el => el.title)
  titles.forEach(title => assert.match(title, /next check in 1:00/))
  await advance(1_000)
  for (const [i, anchor] of anchors.entries()) assert.equal(anchor.title, titles[i], anchor.className)
  // Descendants must not override the stable identity with their own ticking title.
  for (const anchor of anchors) for (const child of anchor.querySelectorAll('[title]')) {
    assert.equal(child.getAttribute('title'), anchor.title)
  }
  assert.equal(view.el.querySelector('.wd-next-check')!.textContent, '0:59')
  for (const anchor of anchors) {
    await pointer(anchor, 'pointerout')
    assert.match(anchor.title, /next check in 0:59/)
    await pointer(anchor, 'pointerover')
    assert.match(anchor.title, /next check in 0:59/)
  }
})

test('keyboard focus and pointer hover share one snapshot until both leave', async t => {
  useFakeClock()
  const w = { ...dog, next_check_at: new Date(Date.now() + 60_000).toISOString() }
  const view = await mountView(<WatchdogLink dog={w} onOpen={() => {}} countdown />, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  const anchor = view.el.querySelector<HTMLElement>('.watchdog-link')!
  await inAct(() => anchor.focus())
  const title = anchor.title
  await advance(1_000)
  assert.equal(anchor.title, title)
  await pointer(anchor, 'pointerover')
  await inAct(() => anchor.blur())
  await advance(1_000)
  assert.equal(anchor.title, title, 'pointer still holds the same snapshot')
  await pointer(anchor, 'pointerout')
  assert.match(anchor.title, /next check in 0:58/)
})

test('chip labels show only timer units while identity tooltip retains its wording', async t => {
  useFakeClock()
  const view = await mountView(<>{[60, 10_980, 97_200].map(seconds =>
    <DogChip key={seconds} dog={{ ...dog, id: `worker/${seconds}`,
      next_check_at: new Date(Date.now() + seconds * 1000).toISOString() }} onOpen={() => {}} />)}</>, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  assert.deepEqual([...view.el.querySelectorAll('.wd-next-check')].map(el => el.textContent),
    ['1:00', '3h 3m', '1d 3h'])
  for (const anchor of view.el.querySelectorAll<HTMLElement>('.watchdog-link')) assert.match(anchor.title, /next check in/)
})

test('delegated agent and project facts stay stable within an identity, including adopted documents', () => {
  const other = new JSDOM('<!doctype html><body></body>')
  for (const owner of [document, other.window.document]) {
    let facts = '0/2 held'
    const stop = registerAgentNativeTooltipDocument(owner, () => ({ title: facts }))
    const anchor = owner.createElement('span')
    anchor.setAttribute('data-agent-tooltip', 'project')
    anchor.innerHTML = '<b>project</b><i>facts</i>'
    owner.body.append(anchor)
    const event = (el: Element, type: string, relatedTarget: EventTarget | null = null) =>
      el.dispatchEvent(new owner.defaultView!.MouseEvent(type, { bubbles: true, relatedTarget }))
    try {
      event(anchor.firstElementChild!, 'pointerover')
      assert.equal(anchor.title, facts)
      facts = '1/2 held'
      event(anchor.firstElementChild!, 'pointerout', anchor.lastElementChild)
      event(anchor.lastElementChild!, 'pointerover', anchor.firstElementChild)
      assert.equal(anchor.title, '0/2 held', 'moving within a project must not rewrite title')
      event(anchor.lastElementChild!, 'pointerout')
      event(anchor.firstElementChild!, 'pointerover')
      assert.equal(anchor.title, facts)
    } finally { stop(); anchor.remove() }
  }
  other.window.close()
})
