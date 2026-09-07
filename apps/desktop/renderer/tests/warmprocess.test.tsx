// D-201: process warmth is a speed cue. The canvas must distinguish it without
// turning a normal cold start into an error or lifecycle state.

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NodeSquare } from '../src/canvas/cards'
import { DestinationBusy, ProcessLifecycleMark } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

declare const __SRC_DIR__: string

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)
const seats = { haiku: 1, sonnet: 2, opus: 5, fable: 10,
  'gpt-reserve': 0.2, luna: 0.2, terra: 2, sol: 5, flash: 1, pro: 2 }
const hire = { enabled: true, installed: true, reason: null }

function node(warm: boolean): CanvasNode {
  return { id: warm ? 'warm' : 'cold', state: 'live', tier: 'terra', model_id: 'terra',
    proc_warm: warm, proc_live: warm, proc_relaunch: false,
    proc_relaunch_reason: null, children: [], seat: 2, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] } }
}

function card(warm: boolean) {
  const n = node(warm)
  return mountView(<NodeSquare node={n} pos={{ x: 0, y: 0 }} lod="norm" focused={false}
    dragging={false} isDrop={false} seats={seats} codexHire={hire} antigravityHire={hire} claudeHire={hire}
    map={new Map([[n.id, n]])} op={op} slug="org" toast={noop} pxc={1} zoom={1} compactAt={.8}
    pub={false} maxTop={0} kioskRemaining={null} cascadeAlloc onSpawn={noop} onSpawnSide={noop}
    onSpawnTop={noop} onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
    onRecenter={noop} onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
    onDragEnd={noop} onDragCancel={noop} />, (el) => el)
}

test('live cards retain warm-cache styling while using the unified cue', async (t) => {
  for (const warm of [false, true]) {
    const view = await card(warm)
    t.after(() => view.unmount())
    const root = view.el.querySelector('.sq')!
    assert.equal(root.classList.contains('proc-warm'), warm)
    assert.equal(root.classList.contains('proc-cold'), !warm)
    assert.equal(root.querySelectorAll('.proc-state').length, 0,
      'zoomed-out cards do not mount CLI process status dots')
    assert.equal(root.querySelectorAll('.cc-spin').length, 0,
      'idle agents do not show spinning arrow')
    assert.equal(root.querySelectorAll('.proc-mark').length, 0)
  }
})

test('the desk header collapses live and warm into one accessible process cue', async () => {
  const view = await mountView(<>
    <ProcessLifecycleMark warm live tier="haiku" />
    <ProcessLifecycleMark warm={false} live={false} />
    <ProcessLifecycleMark warm={false} live busy tier="terra" />
    <ProcessLifecycleMark warm={false} live />
    <ProcessLifecycleMark warm={false} live relaunch
      reason="identity-changed — system prompt changed" />
  </>, (el) => el)
  try {
    assert.equal(view.el.querySelectorAll('.proc-state').length, 5)
    assert.equal(view.el.querySelectorAll('.proc-one-mark').length, 5)
    assert.equal(view.el.querySelectorAll('.proc-state.standby').length, 2)
    assert.equal(view.el.querySelectorAll('.proc-state.off').length, 1)
    assert.equal(view.el.querySelectorAll('.proc-state.active').length, 1)
    assert.equal(view.el.querySelectorAll('.proc-state.relaunch').length, 1)
    assert.equal(view.el.querySelectorAll('.proc-state .proc-mark').length, 0,
      'the header regressed to a second persistent warm/cold dot')
    const labels = [...view.el.querySelectorAll<HTMLElement>('.proc-state')]
      .map((el) => el.getAttribute('aria-label') ?? '')
    assert.ok(labels.some((v) => /parked on standby and ready/.test(v)))
    assert.ok(labels.some((v) => /serving the current turn/.test(v)))
    assert.ok(labels.some((v) => /spawning or initializing/.test(v)))
    assert.ok(labels.some((v) => /no CLI process live/.test(v)))
    const relaunch = view.el.querySelector<HTMLElement>('.proc-relaunch')
      ?.closest<HTMLElement>('.proc-state')
    assert.match(relaunch?.title ?? '', /identity-changed — system prompt changed/)
  } finally { view.unmount() }
})

test('in-use wins the warm handoff and carries each provider theme', async () => {
  const view = await mountView(<>
    <ProcessLifecycleMark warm live busy tier="haiku" />
    <ProcessLifecycleMark warm live busy tier="terra" />
    <ProcessLifecycleMark warm live busy relaunch reason="prompt changed" tier="pro" />
    <ProcessLifecycleMark warm live tier="terra" />
  </>, (el) => el)
  try {
    const active = [...view.el.querySelectorAll<HTMLElement>('.proc-state.active')]
    assert.deepEqual(active.map((el) => [...el.classList]
      .find((c) => c.startsWith('prov-'))), [
      'prov-claude', 'prov-openai', 'prov-google',
    ])
    assert.equal(view.el.querySelectorAll('.proc-state.standby.prov-openai').length, 1,
      'warm without a current turn must remain neutral standby')
    assert.equal(view.el.querySelectorAll('.proc-state.standby.active').length, 0)
    assert.match(active[2]!.title, /serving the current turn.*relaunch afterward/,
      'current use must win the color state without hiding a pending relaunch')
  } finally { view.unmount() }
})

test('process colors and idle-toggle hit target are explicit in shipped CSS', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.proc-state\.standby \.proc-one-mark\s*\{[^}]*var\(--dim\)/s,
    'standby process is no longer neutral grey')
  for (const provider of ['claude', 'openai', 'google']) {
    assert.match(css, new RegExp(
      String.raw`\.proc-state\.active\.prov-${provider}\s*\{[^}]*--process-accent:\s*var\(--prov-${provider}\)`),
    `active ${provider} process lost its provider theme`)
  }
  assert.match(css, /\.proc-toggle\s*\{[^}]*min-width:\s*24px[^}]*min-height:\s*24px/s,
    'switchboard process toggle is smaller than a 24px hit target')
  assert.doesNotMatch(css,
    /\.proc-state\.standby \.proc-one-mark\s*\{[^}]*animation:/s,
    'solid-grey standby process must not pulse')
  assert.doesNotMatch(css,
    /\.proc-state\.active \.proc-one-mark\s*\{[^}]*animation:/s,
    'ordinary provider-colored in-use state must not pulse')
  assert.match(css,
    /\.proc-state\.relaunch \.proc-one-mark\s*\{[^}]*animation:\s*proc-relaunch-pulse 3\.2s ease-in-out infinite/s,
    'amber relaunch-pending state lost its slow pulse')
  assert.match(css, /@keyframes proc-relaunch-pulse\s*\{[^}]*opacity:\s*\.68/s,
    'relaunch pulse no longer has the subtle low-opacity phase')
  assert.match(css,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.proc-state\.relaunch \.proc-one-mark\s*\{[^}]*animation:\s*none[^}]*opacity:\s*\.92/s,
    'relaunch pulse does not become a solid amber mark under reduced motion')
})

test('idle process cue is a native toggle with an honest disabled reason', async () => {
  let toggles = 0
  const view = await mountView(<>
    <ProcessLifecycleMark warm live controlEnabled controlAction="stop"
      onToggle={() => { toggles += 1 }} />
    <ProcessLifecycleMark warm={false} live={false} paused controlEnabled
      controlAction="start" onToggle={() => { toggles += 1 }} />
    <ProcessLifecycleMark warm live controlAction="stop" controlEnabled={false}
      controlReason="the agent is responding" onToggle={() => { toggles += 1 }} />
  </>, (el) => el)
  try {
    const buttons = [...view.el.querySelectorAll<HTMLButtonElement>(
      'button.proc-toggle')]
    assert.equal(buttons.length, 3)
    assert.equal(buttons[0]!.getAttribute('aria-pressed'), 'false')
    assert.equal(buttons[1]!.getAttribute('aria-pressed'), 'true')
    assert.equal(buttons[2]!.disabled, true)
    assert.match(buttons[0]!.title, /click to stop/)
    assert.match(buttons[1]!.title, /click to start/)
    assert.match(buttons[2]!.title, /agent is responding/)
    buttons[0]!.click()
    buttons[2]!.click()
    assert.equal(toggles, 1, 'disabled controls must not invoke their handler')
  } finally { view.unmount() }
})

test('navigation busy arrows carry the destination provider, not an ancestor theme', async () => {
  const view = await mountView(<div className="prov-openai">
    <DestinationBusy tier="haiku" />
    <DestinationBusy tier="terra" />
    <DestinationBusy tier="pro" />
  </div>, (el) => el)
  try {
    const spins = [...view.el.querySelectorAll('.cc-spin')]
    assert.equal(spins[0]!.classList.contains('prov-claude'), true)
    assert.equal(spins[1]!.classList.contains('prov-openai'), true)
    assert.equal(spins[2]!.classList.contains('prov-google'), true)
  } finally { view.unmount() }
})
