import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogPanel } from '../src/canvas/modals'
import type { Watchdog } from '../src/types'

const noop = () => {}
const base: Watchdog = { id: 'worker/watch', owner: 'worker', name: 'watch', kind: 'file',
  target: 'build.log', state: 'armed', interval_s: 60, fired: 0, once: false, spent: false,
  at: '2026-10-18T07:00:00Z', events: [] }
async function panel(patch: Partial<Watchdog> & { notice?: boolean } = {}) {
  return mountView(<WatchdogPanel slug="synthetic" dog={{ ...base, ...patch }} toast={noop} close={noop} />, host => host)
}

test('slot claim tracks its place from the current line and names its spent grant', async t => {
  const first: Watchdog = { ...base, id: 'first/slot', kind: 'slot', target: 'builds', once: true, queued_at: '2026-10-18T07:00:00Z' }
  const second: Watchdog = { ...first, id: 'worker/slot', queued_at: '2026-10-18T07:01:00Z' }
  for (const [dog, dogs, expected] of [
    [second, [first, second], /Slot claim: 2nd in line for builds/],
    [second, [second], /Slot claim: 1st in line for builds/],
    [{ ...second, state: 'paused' }, [first, second], /paused.*resuming rejoins at the back/],
    [{ ...second, state: 'spent', spent: true, slot: 2, lease: 's_fixture' }, [first], /Granted slot 2 of builds \(lease s_fixture\), spent/],
  ] as Array<[Watchdog, Watchdog[], RegExp]>) {
    const view = await mountView(<WatchdogPanel slug="synthetic" dog={dog} dogs={dogs} toast={noop} close={noop} />, host => host)
    try {
      assert.equal(view.el.querySelector('.wd-type')?.textContent, 'Slot claim')
      assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', expected)
      assert.doesNotMatch(view.el.textContent ?? '', /checked every|matching event|command \(/)
    } finally { await view.unmount() }
  }
})

const kinds: Array<[Watchdog['kind'], string, RegExp, RegExp]> = [
  ['file', 'build.log', /File listener/, /new.*lines.*build\.log/],
  ['command', 'echo READY', /Periodic command listener/, /Runs.*echo READY.*every 60s.*worker.*READY/],
  ['process', 'port:8080', /Process listener/, /observed.*up.*down/i],
  ['stream', 'tail -f build.log', /Stream listener/, /long-lived.*tail -f build\.log/],
  ['activity', 'builder', /Activity listener/, /builder.*turns and tool calls/],
  ['event', 'turn.*', /Orgtree event listener.*turn\.\*/, /turn\.\*.*worker/],
  ['fair_queue', 'test-project', /Mail queue listener/, /Delivers.*test-project.*worker.*one message at a time.*shared fairly/],
]
for (const [kind, target, type, description] of kinds) test(`${kind} card names its type and explains its actual trigger`, async t => {
  const view = await panel({ kind, target, ...(kind === 'command' ? { pattern: 'READY' } : {}) })
  t.after(() => view.unmount())
  assert.match(view.el.querySelector('.wd-type')?.textContent ?? '', type)
  assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', description)
  const labels = Array.from(view.el.querySelectorAll('.field-label'), el => el.textContent)
  if (!['command', 'stream'].includes(kind)) assert.ok(!labels.some(label => label?.includes('command')))
  if (kind === 'fair_queue') {
    assert.ok(labels.includes('project'))
    assert.doesNotMatch(view.el.textContent ?? '', /checked every|matching event|next check|command \(/)
  }
  if (['stream', 'activity', 'event'].includes(kind)) {
    assert.doesNotMatch(view.el.textContent ?? '', /checked every|next check/)
    assert.match(view.el.querySelector('.wd-cadence')?.textContent ?? '', /minimum.*60s|at most.*60s/i)
  }
})

test('silence explains absence of matching events and keeps the underlying type', async t => {
  for (const kind of ['file', 'activity', 'process'] as const) {
    const view = await panel({ kind, target: kind === 'process' ? 'pid:42' : 'builder',
      fire_mode: 'silence', quiet_period_s: 600, pattern: '^tool_call' })
    try {
      assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', /600s without.*matching|600s without an observed/i)
      assert.match(view.el.textContent ?? '', /resets after each match and fire/)
      if (kind === 'process') assert.doesNotMatch(view.el.querySelector('.wd-description')?.textContent ?? '', /tool_call/)
    } finally { await view.unmount() }
  }
})

test('passive notices and legacy wake delivery are distinct', async t => {
  for (const notice of [true, false, undefined]) {
    const view = await panel({ kind: 'command', target: 'echo READY', pattern: 'READY', notice })
    try {
      assert.match(view.el.querySelector('.wd-delivery')?.textContent ?? '', notice
        ? /mail.*next turn.*does not wake worker/i : /mail.*wakes worker/i)
    } finally { await view.unmount() }
  }
})

test('count event explains crossing scope and excludes the listener', async t => {
  const view = await panel({ kind: 'event', target: 'agents.active', threshold: 'below 1', event_scope: 'org' })
  t.after(() => view.unmount())
  assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', /crosses below 1.*organization.*excluding worker/)
  assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', /staying.*does not/i)
})

test('one-shot stream names its exit exception instead of promising every alert removes it', async t => {
  const view = await panel({ kind: 'stream', target: 'tail -f build.log', once: true })
  t.after(() => view.unmount())
  assert.match(view.el.querySelector('.wd-once-note')?.textContent ?? '', /matching.*once|first matching/i)
  assert.match(view.el.textContent ?? '', /exit diagnostic.*does not.*one-shot/i)
})

test('full target and regex stay visible and existing management controls remain', async t => {
  const target = 'echo ' + 'long-command-'.repeat(50)
  const view = await panel({ kind: 'command', target, pattern: '^READY$' })
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.wd-cmd')?.textContent, target)
  assert.ok(view.el.querySelector('.wd-cmd')?.classList.contains('wd-expand'))
  assert.match(view.el.textContent ?? '', /\^READY\$/)
  const buttons = Array.from(view.el.querySelectorAll('button'), el => el.textContent?.toLowerCase())
  assert.ok(buttons.includes('pause'))
  assert.ok(buttons.includes('remove'))
})
