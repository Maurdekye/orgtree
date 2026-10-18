import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { WatchdogPanel } from '../src/canvas/modals'
import type { Watchdog } from '../src/types'

const root = createRoot(document.getElementById('root')!)
const base: Watchdog = { id: 'worker/watch', owner: 'test-proj-worker-b', name: 'test-project-mail',
  kind: 'fair_queue', target: 'test-project', state: 'armed', interval_s: 60, fired: 2,
  once: false, spent: false, at: '2026-10-18T07:00:00Z', events: [] }
const cases: Record<string, Partial<Watchdog> & { notice?: boolean }> = {
  queue: {},
  command: { name: 'build-finished', kind: 'command', target: 'type C:\\synthetic\\build-status.txt', pattern: '^BUILD COMPLETE$', once: true },
  silence: { name: 'worker-quiet', kind: 'activity', target: 'builder', fire_mode: 'silence', quiet_period_s: 600, pattern: '^tool_call', notice: true },
  event: { name: 'team-idle', kind: 'event', target: 'agents.active', threshold: 'below 1', event_scope: 'subtree', once: true },
}
;(window as unknown as { setWatchdogCase: (name: string) => void }).setWatchdogCase = name => {
  if (!cases[name]) throw Error('unknown fixture')
  flushSync(() => root.render(<WatchdogPanel key={name} slug="synthetic" dog={{ ...base, ...cases[name] }} toast={() => {}} close={() => {}} />))
  document.body.dataset.ready = 'true'
}
;(window as unknown as { setWatchdogCase: (name: string) => void }).setWatchdogCase('queue')
