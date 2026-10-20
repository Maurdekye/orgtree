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

test('usage watchdog displays exact filters, edge semantics and existing controls', async t => {
  const view = await panel({ kind: 'usage', target: 'usage', accounts: ['claude-5'], windows: ['weekly'], usage_events: ['above', 'stale'], threshold_percent: 98, notice: true })
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.wd-type')?.textContent, 'Usage event listener')
  assert.match(view.el.textContent ?? '', /claude-5.*weekly/s)
  assert.match(view.el.textContent ?? '', /98%/)
  assert.match(view.el.textContent ?? '', /unknown readings never count as zero/)
  assert.match(view.el.textContent ?? '', /No provider requests/)
  const controls = Array.from(view.el.querySelectorAll('button')).map(button => button.textContent?.trim())
  assert.ok(controls.includes('pause'))
  assert.ok(controls.includes('remove'))
  assert.doesNotMatch(view.el.textContent ?? '', /checked every|next check/i)
})

test('slot claim tracks its place from the current line and names its spent grant', async t => {
  const first: Watchdog = { ...base, id: 'first/slot', kind: 'slot', target: 'builds', once: true, queued_at: '2026-10-18T07:00:00Z' }
  const second: Watchdog = { ...first, id: 'worker/slot', queued_at: '2026-10-18T07:01:00Z' }
  for (const [dog, dogs, expected] of [
    [second, [first, second], /Concurrency slot claim: 2nd in line for builds/],
    [second, [second], /Concurrency slot claim: 1st in line for builds/],
    [{ ...second, state: 'paused' }, [first, second], /paused.*resuming rejoins at the back/],
    [{ ...second, state: 'spent', spent: true, slot: 2, lease: 's_fixture' }, [first], /Granted a concurrency slot of builds \(lease s_fixture\).*grant notification sent/],
  ] as Array<[Watchdog, Watchdog[], RegExp]>) {
    const view = await mountView(<WatchdogPanel slug="synthetic" dog={dog} dogs={dogs} toast={noop} close={noop} />, host => host)
    try {
      assert.equal(view.el.querySelector('.wd-type')?.textContent, 'Concurrency slot claim', 'spelled out (user 2026-10-18 12:16Z)')
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

// MQTT watchdogs (user 2026-10-19 17:40:50Z; docs/rust-engine/mqtt-watchdogs.md)
test('mqtt card names its broker, topic filter and how it authenticates, never the credentials', async t => {
  const view = await panel({ kind: 'mqtt', target: 'mqtts://broker.local:8883', pattern: 'home/+/temperature',
    payload_pattern: '"state":"open"', retained: false, credentials: 'inline credentials (stored encrypted)',
    connection: { state: 'down', since: '2026-10-18T07:00:00Z', error: 'the broker closed the connection', retry_at: '2026-10-18T07:05:00Z' },
    last_output: 'home/kitchen/temperature: 21.5' })
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.wd-type')?.textContent, 'MQTT topic listener')
  assert.match(view.el.querySelector('.wd-description')?.textContent ?? '', /home\/\+\/temperature.*mqtts:\/\/broker\.local:8883/)
  const text = view.el.textContent ?? ''
  assert.match(text, /untrusted/i)
  assert.match(text, /inline credentials \(stored encrypted\)/)
  // how long, not "since 41h ago" (coordinator 2026-10-19 23:57Z)
  assert.match(view.el.querySelector('.wd-connection')?.textContent ?? '', /^down for \d+[smh]: the broker closed the connection/)
  assert.match(text, /"state":"open"/)
  assert.match(text, /home\/kitchen\/temperature: 21\.5/)
  const labels = Array.from(view.el.querySelectorAll('.field-label'), el => el.textContent)
  for (const label of ['broker', 'topic filter', 'credentials', 'payload filter', 'connection', 'last message']) {
    assert.ok(labels.includes(label), `${label} in ${labels}`)
  }
  assert.doesNotMatch(text, /checked every|next check/)
  const healthy = await panel({ kind: 'mqtt', target: 'mqtt://localhost:1883', pattern: 'ci/#', credentials: 'none',
    connection: { state: 'connected', since: '2026-10-18T07:00:00Z' } })
  try {
    assert.match(healthy.el.querySelector('.wd-connection')?.textContent ?? '', /^connected for \d+[smh]$/)
    assert.ok(!healthy.el.querySelector('.wd-connection-bad'), 'a connected broker is not flagged')
    assert.match(healthy.el.querySelector('.wd-description')?.textContent ?? '', /retained messages.*ignored/i)
  } finally { await healthy.unmount() }
})

// WebSocket watchdogs (user 2026-10-19 21:00Z/21:01:59Z; docs/rust-engine/websocket-watchdogs.md)
test('websocket card names its server, hellos, heartbeat and connection, never the credentials', async t => {
  const view = await panel({ kind: 'websocket', target: 'wss://ha.local/api/websocket', pattern: '"event_type":"state_changed"',
    credentials: 'file: C:/agents/worker/ha.json', hello: [{ id: 1, type: 'subscribe_events' }], protocols: ['graphql-transport-ws'],
    heartbeat: { message: '{"op":1,"d":null}', every_s: 40 }, sent: 2, last_sent_at: '2026-10-18T07:10:00Z',
    connection: { state: 'refused', since: '2026-10-18T07:00:00Z', error: 'the server refused the login (HTTP 401 Unauthorized)', retry_at: '2026-10-18T08:00:00Z' },
    last_output: '{"type":"event"}' })
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.wd-type')?.textContent, 'WebSocket listener')
  const description = view.el.querySelector('.wd-description')?.textContent ?? ''
  assert.match(description, /Connects to wss:\/\/ha\.local\/api\/websocket, sends 1 hello message after every connect/)
  assert.match(description, /state_changed.*heartbeat goes out every 40s.*send.*untrusted/s)
  const text = view.el.textContent ?? ''
  assert.match(text, /file: C:\/agents\/worker\/ha\.json/)
  assert.match(text, /\{"id":1,"type":"subscribe_events"\}/, 'a JSON hello shows as the text frame it sends')
  assert.match(text, /graphql-transport-ws/)
  assert.match(text, /every 40s: \{"op":1,"d":null\}/)
  assert.match(text, /2 messages sent/)
  assert.match(view.el.querySelector('.wd-connection')?.textContent ?? '', /^refused by the server for \d+[smh]: the server refused the login \(HTTP 401/)
  assert.ok(view.el.querySelector('.wd-connection-bad'), 'a refused connection is flagged')
  const labels = Array.from(view.el.querySelectorAll('.field-label'), el => el.textContent)
  for (const label of ['server', 'credentials', 'hello (sent after every connect)', 'subprotocols', 'heartbeat', 'connection', 'last message', 'fires on messages matching']) {
    assert.ok(labels.includes(label), `${label} in ${labels}`)
  }
  assert.doesNotMatch(text, /checked every|next check/)
  const plain = await panel({ kind: 'websocket', target: 'ws://127.0.0.1:9222/devtools/page/1', credentials: 'none',
    connection: { state: 'connected', since: '2026-10-18T07:00:00Z' } })
  try {
    assert.match(plain.el.querySelector('.wd-description')?.textContent ?? '', /every message the server sends/)
    assert.ok(!plain.el.querySelector('.wd-connection-bad'), 'a connected server is not flagged')
    assert.match(plain.el.querySelector('.wd-connection')?.textContent ?? '', /^connected for \d+[smh]$/)
    assert.match(plain.el.textContent ?? '', /nothing sent yet/)
  } finally { await plain.unmount() }
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
