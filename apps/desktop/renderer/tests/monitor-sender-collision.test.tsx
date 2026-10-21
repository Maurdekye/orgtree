import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { MailList } from '../src/canvas/mail'
import { DeskDogsProvider } from '../src/canvas/watchdogroute'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import type { MailRow } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const name = 'coordinator'
const dog: Watchdog = { id: 'worker/watch', owner: 'worker', name, kind: 'project_listener',
  target: 'build', once: false, state: 'armed', at: '2026-10-21T00:00:00Z', fired: 1, interval_s: 30 }
const monitor: MailRow = { id: 'fire', from: 'worker/watch', kind: 'watchdog', body: 'Ready',
  at: '2026-10-21T00:00:00Z', ev: { v: 1, variant: 'monitor.watchdog_fired', engine_authored: true,
    actor: { kind: 'watchdog', id: dog.id },
    object: { kind: 'watchdog', org: 'synthetic', id: dog.id, owner: dog.owner, name },
    prefix: 'EVENT', lines: ['Ready'], once: false, count: 1 } }

async function mailbox(row = monitor, dogs = [dog], outgoing = false) {
  const agents: string[] = [], opened: string[] = []
  // The production default sender path: no sender/rowSender overrides.
  const v = await mountView(<DeskDogsProvider value={{ org: 'synthetic', dogs, open: id => opened.push(id) }}>
    <MailList org="synthetic" delivered={[row]} outgoing={outgoing} lookup={async () => null}
      hasAgent={id => id === name} tierOf={id => id === name ? 'sol' : undefined}
      onFocusAgent={id => agents.push(id)} />
    <div className="canonical"><WatchdogLink dog={dog} org="synthetic" /></div>
  </DeskDogsProvider>, el => el)
  return { v, agents, opened }
}

test('monitor name collision opens the watchdog, never the same-named agent', async () => {
  const { v, agents, opened } = await mailbox()
  try {
    const target = v.el.querySelector<HTMLElement>('.mailrow .mail-monitor-sender button')!
    assert.equal(!!target, true, 'live monitor sender is actionable')
    await inAct(() => target.click())
    assert.deepEqual(agents, [], 'friendly monitor name must not become an agent id')
    assert.deepEqual(opened, [dog.id], 'shared watchdog route receives the stable handle')
  } finally { await v.unmount() }
})

test('monitor sender uses canonical watchdog identity and tooltip without an agent model chip', async () => {
  const { v } = await mailbox()
  try {
    const sender = v.el.querySelector<HTMLElement>('.mailrow .mail-monitor-sender')!
    assert.equal(sender.querySelectorAll('.tier, [data-copy-agent-name]').length, 0)
    const link = sender.querySelector<HTMLElement>('.watchdog-link')!
    assert.equal(!!link, true)
    assert.equal(link.getAttribute('data-object-nav'), 'watchdog')
    assert.equal(link.getAttribute('data-object-id'), dog.id)
    assert.equal(link.getAttribute('data-object-org'), 'synthetic')
    assert.equal(link.title, v.el.querySelector<HTMLElement>('.canonical .watchdog-link')!.title)
    assert.match(sender.title, /worker\/watch/, 'recorded stable handle remains available')
  } finally { await v.unmount() }
})

test('monitor missing from the live registry retains recorded identity without resolving an agent', async () => {
  const { v, agents } = await mailbox(monitor, [])
  try {
    const sender = v.el.querySelector<HTMLElement>('.mailrow .mail-monitor-sender')!
    await inAct(() => (sender.querySelector<HTMLElement>('button') ?? sender).click())
    assert.deepEqual(agents, [])
    assert.equal(sender.querySelectorAll('.tier, [data-copy-agent-name]').length, 0)
    assert.match(sender.textContent ?? '', /coordinator/)
    assert.match(sender.title, /worker\/watch/)
    await inAct(() => v.el.querySelector<HTMLElement>('.mailrow')!.click())
    assert.equal(v.el.querySelectorAll('.mailer-read').length, 1, 'ordinary row selection still works')
  } finally { await v.unmount() }
})

test('ordinary agent sender still has its model chip and agent navigation', async () => {
  const row: MailRow = { id: 'ordinary', from: name, kind: 'message', body: 'Hello', at: monitor.at }
  const { v, agents, opened } = await mailbox(row)
  try {
    assert.equal(v.el.querySelectorAll('.mailrow .tier').length, 1)
    await inAct(() => v.el.querySelector<HTMLElement>('.mailrow .cc-name-jump')!.click())
    assert.deepEqual(agents, [name])
    assert.deepEqual(opened, [])
  } finally { await v.unmount() }
})

test('outgoing monitor mail keeps the recipient agent identity and route', async () => {
  const { v, agents, opened } = await mailbox({ ...monitor, to: name }, [dog], true)
  try {
    assert.equal(v.el.querySelectorAll('.mailrow .mail-monitor-sender').length, 0)
    await inAct(() => v.el.querySelector<HTMLElement>('.mailrow .cc-name-jump')!.click())
    assert.deepEqual(agents, [name])
    assert.deepEqual(opened, [])
  } finally { await v.unmount() }
})
