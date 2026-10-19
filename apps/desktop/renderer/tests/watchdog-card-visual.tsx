import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { WatchdogPanel } from '../src/canvas/modals'
import type { Watchdog } from '../src/types'

const root = createRoot(document.getElementById('root')!)
const base: Watchdog = { id: 'worker/watch', owner: 'test-proj-worker-b', name: 'test-project-mail',
  kind: 'fair_queue', target: 'test-project', state: 'armed', interval_s: 60, fired: 2,
  once: false, spent: false, at: '2026-10-18T07:00:00Z', events: [] }
const cases: Record<string, Partial<Watchdog> & { notice?: boolean }> = {
  usage: { name: 'weekly-budget', kind: 'usage', target: 'usage', accounts: ['claude-5'], windows: ['weekly'], usage_events: ['above', 'stale', 'recovered'], threshold_percent: 98, notice: true },
  queue: {},
  command: { name: 'build-finished', kind: 'command', target: 'type C:\\synthetic\\build-status.txt', pattern: '^BUILD COMPLETE$', once: true },
  silence: { name: 'worker-quiet', kind: 'activity', target: 'builder', fire_mode: 'silence', quiet_period_s: 600, pattern: '^tool_call', notice: true },
  event: { name: 'team-idle', kind: 'event', target: 'agents.active', threshold: 'below 1', event_scope: 'subtree', once: true },
  mqtt: { name: 'door-sensor', kind: 'mqtt', target: 'mqtts://broker.local:8883', pattern: 'home/+/door', payload_pattern: '"state":"open"',
    credentials: 'file: C:\\synthetic\\creds\\broker.json', connection: { state: 'connected', since: '2026-10-18T07:00:00Z' },
    last_output: 'home/front/door: {"state":"open"}', fired: 3 },
  'mqtt-down': { name: 'ci-status', kind: 'mqtt', target: 'mqtt://10.0.0.5:1883', pattern: 'ci/+/status', credentials: 'inline credentials (stored encrypted)',
    connection: { state: 'down', since: '2026-10-18T07:00:00Z', error: 'the broker host refused the TCP connection (is the broker listening on that port?)', retry_at: '2026-10-18T07:05:00Z' },
    health: '⚠ the broker is unreachable since 2026-10-18T07:00:00Z: the broker host refused the TCP connection (is the broker listening on that port?). It retries on its own (next try 2026-10-18T07:05:00Z); messages published meanwhile are missed.' },
  websocket: { name: 'ha-doors', kind: 'websocket', target: 'wss://ha.local/api/websocket', pattern: '"event_type":"state_changed"',
    credentials: 'file: C:\\synthetic\\creds\\ha.json', hello: [{ id: 1, type: 'subscribe_events', event_type: 'state_changed' }],
    connection: { state: 'connected', since: '2026-10-18T07:00:00Z' }, sent: 3, last_sent_at: '2026-10-18T07:10:00Z',
    last_output: '{"id":1,"type":"event","event":{"event_type":"state_changed"}}', fired: 4 },
  'websocket-refused': { name: 'gateway', kind: 'websocket', target: 'wss://gateway.discord.gg/?v=10&encoding=json',
    credentials: 'inline credentials (stored encrypted)', heartbeat: { message: '{"op":1,"d":null}', every_s: 40 }, protocols: ['json'],
    connection: { state: 'refused', since: '2026-10-18T07:00:00Z', error: 'the server refused the login (HTTP 401 Unauthorized): check the credentials', retry_at: '2026-10-18T08:00:00Z' },
    health: '⚠ REFUSED by the server since 2026-10-18T07:00:00Z: the server refused the login (HTTP 401 Unauthorized): check the credentials. It retries slowly (next try 2026-10-18T08:00:00Z); fix the credentials or the URL, then resume it.' },
}
;(window as unknown as { setWatchdogCase: (name: string) => void }).setWatchdogCase = name => {
  if (!cases[name]) throw Error('unknown fixture')
  flushSync(() => root.render(<WatchdogPanel key={name} slug="synthetic" dog={{ ...base, ...cases[name] }} toast={() => {}} close={() => {}} />))
  document.body.dataset.ready = 'true'
}
;(window as unknown as { setWatchdogCase: (name: string) => void }).setWatchdogCase('queue')
