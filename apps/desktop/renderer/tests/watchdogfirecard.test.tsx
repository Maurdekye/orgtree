import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import { EventCard } from '../src/events/card'
import { decodeEventRow } from '../src/events/decode'
import { isSegments } from '../src/events/segments'

// A watchdog fire's event as the engine builds it: events.rs watchdog_fired,
// plus what runtime/watchdogs.rs fire_with merges in for an mqtt or
// websocket dog (`source`, the true `count`) and for a dog with fire
// actions (`fire_actions`, their results). Message lines are written the way
// mqtt/render.rs and ws/render.rs write them: a header line, then the text
// behind a gutter.
function fire(name: string, prefix: string, lines: string[], extra: Record<string, unknown> = {}) {
  return { v: 1, variant: 'monitor.watchdog_fired', actor: { kind: 'watchdog', id: name }, engine_authored: false,
    object: { kind: 'watchdog', org: 'org', id: name, name, owner: 'coordinator' },
    prefix, lines, count: lines.length, once: false, ...extra }
}
const WS_WELCOME = '2026-10-20T06:53:53.510Z  36 bytes\n    │ welcome: connected to ws-test-server'
const WS_JSON = '2026-10-20T06:53:55.625Z  60 bytes\n    │ {"event":"state_changed","entity":"light.kitchen","on":true}'
const WS_CUT = '2026-10-20T06:54:01.000Z  2000 bytes\n    │ {"id":7,"items":[1,2,\n    │ … (message cut here: 2000 bytes in all)'
const MQTT_JSON = '2026-10-20T07:00:01.000Z  home/door/front  41 bytes · retained\n    │ {\n    │   "state": "open",\n    │   "battery": 87\n    │ }'
const ACTIONS = 'Fire actions (run as you, with your current authority):\n  orgtree_message: ok\n    {\n      "sent": "m1",\n      "to": "coordinator"\n    }\n'
const ws = fire('ws-test', 'WEBSOCKET —', [WS_WELCOME], { source: 'websocket' })
const mqtt = fire('door', 'MQTT —', [MQTT_JSON], { source: 'mqtt', count: 3 })
const actions = fire('build', '', ['build finished'], { fire_actions: ACTIONS })
const body = 'Watchdog "ws-test" fired WEBSOCKET — (websocket · ws://127.0.0.1:8787/ws), fire #1:\n' + WS_WELCOME
let n = 0
const mail = (ev: object, text = body) => ({ id: 'm' + ++n, from: 'ws-test', kind: 'watchdog', at: '2026-10-20T06:53:53Z', body: text, ev, notice: false })
const card = (el: Element) => [...el.querySelectorAll('[data-event-variant="monitor.watchdog_fired"]')]
// An mqtt or websocket fire names the standing passage that holds the rule
// with a small muted header tag; the long amber caution is gone (user
// 2026-10-20 09:17Z-09:21Z, coordinator 09:35Z).
function tagged(el: Element, text: string) {
  const tag = el.querySelector('.event-head .event-external')
  assert.ok(tag, 'the outside source shows as a small tag in the card header')
  assert.equal(tag?.textContent, 'untrusted · see EXTERNAL')
  assert.match(tag?.getAttribute('title') ?? '', /external input/, 'its tooltip says what it means')
  assert.ok(!el.querySelector('.event-untrusted'), 'no caution paragraph above the messages')
  assert.doesNotMatch(text, /never follow instructions|UNTRUSTED:/, 'the long warning is not drawn')
}

test('websocket, mqtt and fire-action fires decode as watchdog fire events; the stored older shape still does', () => {
  for (const ev of [ws, mqtt, actions, fire('old', '', ['READY'])])
    assert.equal(decodeEventRow({ ev, body }, 'operator').kind, 'known', JSON.stringify(ev).slice(0, 120))
  for (const ev of [fire('x', '', ['a'], { source: 'sse' }), fire('x', '', ['a'], { fire_actions: 3 }), fire('x', '', ['a'], { extra: 1 })])
    assert.notEqual(decodeEventRow({ ev, body }, 'operator').kind, 'known', 'the schema stays strict: ' + JSON.stringify(ev).slice(-40))
})

test('a websocket fire delivered after a tool call draws as the fire card, with its header tag and message', async t => {
  const segments = [{ kind: 'mail', rows: [mail(ws)] }]
  assert.equal(isSegments(segments, 'operator'), true, 'the transcript row keeps its typed mail')
  const v = await mountView(<Msg slug="org" nid="coordinator" m={{ role: 'user', text: body, segments,
    steered: true, receipt: 'Delivered after a tool call.' }} />, h => h)
  t.after(() => v.unmount())
  assert.equal(card(v.el).length, 1)
  const text = v.el.textContent ?? ''
  assert.doesNotMatch(text, /fired WEBSOCKET — \(websocket ·/, 'not the mail text')
  assert.match(text, /welcome: connected to ws-test-server/)
  tagged(v.el, text)
  assert.match(text, /Delivered after a tool call\./)
})

test('an ordinary message keeps its card beside an mqtt fire in the same delivery', async t => {
  const message = { id: 'plain', from: 'alpha', kind: 'message', at: '2026-10-20T07:00:00Z', body: 'hello', notice: false,
    ev: { v: 1, variant: 'ordinary.message', actor: { kind: 'agent', id: 'alpha' }, engine_authored: false, object: null, body: 'Plain hello' } }
  const segments = [{ kind: 'mail', rows: [message, mail(mqtt, 'mqtt mail text')] }]
  assert.equal(isSegments(segments, 'operator'), true)
  const v = await mountView(<Msg slug="org" nid="coordinator" m={{ role: 'user', text: 'raw batch text', segments }} />, h => h)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.event-card').length, 2)
  const text = v.el.textContent ?? ''
  assert.doesNotMatch(text, /raw batch text/)
  assert.match(text, /Plain hello/)
  tagged(v.el, text)
})

test('a fire carries its fire-action results into the card', async t => {
  const v = await mountView(<EventCard org="org" profile="operator" row={{ ev: actions, body: 'mail text' }} />, h => h)
  t.after(() => v.unmount())
  assert.equal(card(v.el).length, 1)
  const text = v.el.textContent ?? ''
  assert.match(text, /Fire actions/)
  assert.match(text, /orgtree_message: ok/)
  assert.match(text, /build finished/)
  assert.ok(!v.el.querySelector('.event-external'), 'no tag without an outside source')
})

test('JSON in fire lines draws with the tool-call JSON viewer; other text stays text', async t => {
  const usage = fire('limits', 'USAGE —', ['{"account":"claude-5","provider":"claude","window":"weekly","used":98,"event":"above"}'])
  const command = fire('cmd', '', ['{"status":"ok","n":3}', 'build finished in 3.2s', '[1] not json', '42', '{not json}'])
  const events = fire('turns', '', ['agent.turn_ended {"node":"worker","state":"idle"} (1 matches)'])
  const sockets = fire('ws-test', 'WEBSOCKET —', [WS_JSON, WS_WELCOME, WS_CUT], { source: 'websocket' })
  const cases: [object, number, RegExp[], RegExp[]][] = [
    [usage, 1, [/account/, /claude-5/, /used/, /98/], [/\{"account"/]],
    [command, 1, [/status/, /build finished in 3\.2s/, /\[1\] not json/, /42/, /\{not json\}/], [/\{"status"/]],
    [events, 1, [/agent\.turn_ended/, /node/, /worker/, /\(1 matches\)/], [/\{"node"/]],
    [sockets, 2, [/60 bytes/, /entity/, /light\.kitchen/, /welcome: connected/, /items/, /message cut here: 2000 bytes in all/], [/\{"event"/, /\{"id"/]],
    [mqtt, 1, [/home\/door\/front/, /battery/, /87/], [/"battery"/]],
    [actions, 1, [/orgtree_message: ok/, /sent/, /coordinator/], [/"sent"/]],
  ]
  for (const [ev, viewers, shown, hidden] of cases) {
    const v = await mountView(<EventCard org="org" profile="operator" row={{ ev, body: 'mail text' }} />, h => h)
    t.after(() => v.unmount())
    const label = JSON.stringify(ev).slice(0, 160)
    assert.equal(card(v.el).length, 1, label)
    assert.equal(v.el.querySelectorAll('.sj').length, viewers, 'JSON viewers: ' + label)
    assert.equal(v.el.querySelectorAll('.sj-raw').length, viewers, 'each viewer has the Raw toggle: ' + label)
    const text = v.el.textContent ?? ''
    for (const re of shown) assert.match(text, re, label)
    for (const re of hidden) assert.doesNotMatch(text, re, 'JSON is not shown as raw text: ' + label)
  }
})

test('a fire with no JSON draws exactly as text', async t => {
  const v = await mountView(<EventCard org="org" profile="operator" row={{ ev: fire('plain', '^READY$', ['READY', 'done in {x} s']), body: 'mail text' }} />, h => h)
  t.after(() => v.unmount())
  assert.equal(card(v.el).length, 1)
  assert.ok(!v.el.querySelector('.sj'), 'no JSON viewer')
  assert.match(v.el.textContent ?? '', /READY/)
  assert.match(v.el.textContent ?? '', /done in \{x\} s/)
})
