import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Msg } from '../src/canvas/desk'

// Watchdog fire cards as the transcript draws them (tests/
// watchdogfire-capture.cjs): `?case=sources|json|actions&theme=dark|light`.
// Events are built the way the engine builds them (events.rs
// watchdog_fired, runtime/watchdogs.rs fire_with, mqtt/render.rs and
// ws/render.rs message lines, run_fire_actions results).
function fire(name: string, prefix: string, lines: string[], extra: Record<string, unknown> = {}) {
  return { v: 1, variant: 'monitor.watchdog_fired', actor: { kind: 'watchdog', id: name }, engine_authored: false,
    object: { kind: 'watchdog', org: 'synthetic', id: name, name, owner: 'coordinator' },
    prefix, lines, count: lines.length, once: false, ...extra }
}
let n = 0
const row = (ev: ReturnType<typeof fire>, at: string) =>
  ({ id: 'm' + ++n, from: ev.object.name, kind: 'watchdog', at, body: 'mail text', ev, notice: false })
const cases: Record<string, ReturnType<typeof fire>[]> = {
  sources: [
    fire('ws-test', 'WEBSOCKET —', [
      '2026-10-20T06:53:53.510Z  36 bytes\n    │ welcome: connected to ws-test-server',
      '2026-10-20T06:53:55.625Z  60 bytes\n    │ {"event":"state_changed","entity":"light.kitchen","on":true}',
    ], { source: 'websocket' }),
    fire('front-door', 'MQTT —', [
      '2026-10-20T07:00:01.000Z  home/door/front  41 bytes · retained\n    │ {\n    │   "state": "open",\n    │   "battery": 87\n    │ }',
    ], { source: 'mqtt', count: 3 }),
  ],
  json: [
    fire('claude-limits', 'USAGE —', ['{"account":"claude-5","provider":"claude","window":"weekly","used":98,"threshold_percent":98,"event":"above"}']),
    fire('build-status', '', ['{"status":"ok","tests":884,"failed":0}', 'build finished in 3.2s']),
    fire('turns', '', ['agent.turn_ended {"node":"worker","state":"idle"} (1 matches)']),
  ],
  actions: [
    fire('deploy-done', '^DONE$', ['DONE'], { fire_actions: 'Fire actions (run as you, with your current authority):\n  orgtree_message: ok\n    {\n      "sent": "m4f2a91c0",\n      "to": "coordinator-opus"\n    }\n  orgtree_work: FAILED\n    no docket item named "deploy"\n' }),
  ],
}
const params = new URLSearchParams(location.search)
const which = params.get('case') ?? 'sources'
document.documentElement.classList.toggle('contrast-light', params.get('theme') === 'light')
const segments = [{ kind: 'mail', rows: (cases[which] ?? []).map((ev, i) => row(ev, `2026-10-20T07:0${i}:00Z`)) }]
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(
  <main style={{ padding: 16, width: 940 }} data-case={which}>
    <Msg slug="synthetic" nid="coordinator" m={{ role: 'user', text: 'raw mail text', segments,
      steered: true, receipt: 'Delivered after a tool call.' }} />
  </main>,
))
document.body.dataset.ready = 'true'
