// EPIC Mode's engine room: which org changes become which events, that every
// event the detectors can produce has a picture and a sound in the playbook,
// that every sound synthesizes, and that the budgets hold under a flood.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { diffOrg, HIRE_WINDOW_MS, pulseEvent, snapshotOrg, sparkEvent, streamEvent } from '../src/epic/diff'
import type { EpicEvent, EventKind } from '../src/epic/diff'
import { EpicSynth, LIGHT_CAP, SOUND_NAMES, VOICE_CAP } from '../src/epic/audio'
import { PARTICLE_CAP, Stage } from '../src/epic/stage'
import { PLAYBOOK_KINDS, startEpic } from '../src/epic/director'
import * as taps from '../src/epic/tap'
import type { TreeNode, TreePayload } from '../src/types'
import { fakeAudio, recordCanvas } from './epicmode-fakes'

const NOW = 1_800_000_000_000

function node(id: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode {
  return {
    id, title: id, tier: 'opus', model_id: 'claude-opus', state: 'live', seat: 5, grant: 10, free: 0,
    ui_order: 1, created: new Date(NOW - 3_600_000).toISOString(), cost_usd: 0, occupancy: 0.2,
    context_window: 200000, charter: null, mail_pending: 0, limit_locked: false, resumable: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [], turns: [], frozen: null,
    audiences_held: [], bearer_state: null, generation: 1, children, lineage: [], busy: false,
    proc_warm: false, proc_live: false, waiting: false, responding: false, phase: null, queued: 0,
    last_error: null, activity: { phase: 'idle' },
    ...over,
  } as unknown as TreeNode
}

function tree(roots: TreeNode[], over: Partial<TreePayload> = {}): TreePayload {
  return {
    slug: 'acme', name: 'Acme', roots, work_items_summary: { attention: 0, active: 0, raises: [] },
    user_inbox_count: 0, urgent_unread: 0, org_inbox: { unread: 0 }, watchdogs: [], audiences: [],
    credit_requests: [], cost_usd_total: 0, killswitch: null, dirs: [],
    ...over,
  } as unknown as TreePayload
}

const kinds = (events: EpicEvent[]) => events.map(e => `${e.kind}:${e.node ?? ''}`)
const step = (a: TreePayload, b: TreePayload) => diffOrg(snapshotOrg(a), snapshotOrg(b), NOW)

test('the first tree is only a baseline: nothing is staged for what was already there', () => {
  assert.deepEqual(diffOrg(undefined, snapshotOrg(tree([node('boss')])), NOW), [])
})

test('a hire is a new live node created just now; an old node entering the selection is silent', () => {
  const before = tree([node('boss')])
  const fresh = node('newbie', { created: new Date(NOW - 2_000).toISOString() })
  const old = node('veteran', { created: new Date(NOW - HIRE_WINDOW_MS - 60_000).toISOString() })
  assert.deepEqual(kinds(step(before, tree([node('boss', {}, [fresh, old])]))), ['hire:newbie'])
})

test('absence is never retirement; live to archived is, and archived to live is a rehire', () => {
  const both = tree([node('boss', {}, [node('alice')])])
  assert.deepEqual(kinds(step(both, tree([node('boss')]))), [], 'a node missing from a selected tree was not removed')
  const archived = tree([node('boss', {}, [node('alice', { state: 'archived' })])])
  assert.deepEqual(kinds(step(both, archived)), ['retire:alice'])
  assert.deepEqual(kinds(step(archived, both)), ['rehire:alice'])
})

test('moves, reorders and renames', () => {
  const a = tree([node('boss', {}, [node('alice'), node('bob')]), node('carol')])
  const moved = tree([node('boss', {}, [node('bob')]), node('carol', {}, [node('alice')])])
  const ev = step(a, moved)
  assert.deepEqual(kinds(ev), ['move:alice'])
  assert.equal(ev[0]!.other, 'boss')
  const reordered = tree([node('boss', {}, [node('alice', { ui_order: 3 }), node('bob', { ui_order: 2 })]), node('carol')])
  assert.deepEqual(kinds(step(a, reordered)), ['reorder:alice'], 'one reorder per sibling group')
  assert.deepEqual(pulseEvent({ type: 'node_event', node: 'al', event: 'renamed', was: 'alice' }), { kind: 'rename', node: 'al', other: 'alice' })
})

test('freeze (and a usage-limit freeze), thaw, halt, unhalt and an interrupted turn', () => {
  const calm = tree([node('alice')])
  const frozen = tree([node('alice', { frozen: { at: 'x', until: null, until_ts: null, error: null } as TreeNode['frozen'] })])
  const limited = tree([node('alice', { frozen: { at: 'x', until: '2030-01-01T00:00:00Z', until_ts: 1, error: null } as TreeNode['frozen'] })])
  assert.deepEqual(kinds(step(calm, frozen)), ['freeze:alice'])
  assert.deepEqual(kinds(step(calm, limited)), ['limit:alice'])
  assert.deepEqual(kinds(step(frozen, calm)), ['thaw:alice'])
  const halted = tree([node('alice', { halt: { phase: 'halted', requested_at: 'x', by: '@user' } })])
  assert.deepEqual(kinds(step(calm, halted)), ['halt:alice'])
  assert.deepEqual(kinds(step(halted, calm)), ['unhalt:alice'])
  const killed = tree([node('alice', { turns: [{ at: 'x', cost: 0, denials: 0, killed: true }] })])
  assert.deepEqual(kinds(step(calm, killed)), ['interrupt:alice'])
})

test('turns, tools, questions, documents, errors, compaction and status reports', () => {
  const idle = tree([node('alice')])
  const busy = tree([node('alice', { busy: true, activity: { phase: 'thinking' } })])
  assert.deepEqual(kinds(step(idle, busy)), ['turnStart:alice', 'thinking:alice'])
  const tooling = tree([node('alice', { busy: true, activity: { phase: 'tool', tool: 'Bash' } })])
  const tool = step(busy, tooling)
  assert.deepEqual(kinds(tool), ['tool:alice'])
  assert.equal(tool[0]!.text, 'Bash')
  assert.deepEqual(kinds(step(tooling, busy)), ['toolDone:alice'])
  assert.deepEqual(kinds(step(busy, idle)), ['turnEnd:alice'])
  const asking = tree([node('alice', { ask: { id: 'q1', node: 'alice', status: 'open', at: 'x' } })])
  assert.deepEqual(kinds(step(idle, asking)), ['question:alice'])
  assert.deepEqual(kinds(step(asking, idle)), ['answer:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { documents_count: 2 })]))), ['docs:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { last_error: 'boom' })]))), ['error:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { phase: 'compacting' })]))), ['compact:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { last_status: { status: 'blocked', at: 't1' } })]))), ['blocked:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { tier: 'sonnet' })]))), ['model:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { grant: 14 })]))), ['credits:alice'])
  assert.deepEqual(kinds(step(idle, tree([node('alice', { proc_live: true })]))), ['wake:alice'])
})

test('the org: killswitch, docket, inbox, watchdogs, audiences, credit requests and settings', () => {
  const base = tree([node('boss')], { watchdogs: [{ id: 'd1', owner: 'boss', fired: 0, spent: false } as never] })
  const after = tree([node('boss')], {
    killswitch: { at: 'x', by: '@user' },
    work_items_summary: { attention: 1, active: 2, raises: [] },
    user_inbox_count: 1,
    org_inbox: { unread: 3 } as TreePayload['org_inbox'],
    watchdogs: [{ id: 'd1', owner: 'boss', fired: 1, spent: false } as never],
    audiences: [{ grantor: 'boss', grantee: 'carol', granted_at: 'x', reason: '' }],
    credit_requests: [{ status: 'open' }],
    compact_at: 80,
  })
  assert.deepEqual(kinds(step(base, after)).sort(), [
    'attention:', 'audience:carol', 'creditRequest:', 'dogFired:boss', 'externalMail:',
    'killswitch:', 'settings:', 'ticket:', 'userMail:',
  ].sort())
  const done = tree([node('boss')], { work_items_summary: { attention: 0, active: 1, raises: [] } })
  const two = tree([node('boss')], { work_items_summary: { attention: 0, active: 2, raises: [] } })
  assert.deepEqual(kinds(step(two, done)), ['ticketDone:'])
})

test('mail sparks: agent to agent zaps, the user, the org inbox and watchdogs are told apart', () => {
  assert.deepEqual(sparkEvent({ type: 'mail', from: 'boss', to: 'alice' }), { kind: 'zap', node: 'alice', other: 'boss' })
  assert.equal(sparkEvent({ type: 'mail', from: '@user', to: 'alice' })?.kind, 'userSend')
  assert.equal(sparkEvent({ type: 'mail', from: 'alice', to: '@user' })?.kind, 'toUser')
  assert.equal(sparkEvent({ type: 'mail', from: 'org_inbox', to: 'alice' })?.kind, 'orgInbox')
  assert.equal(sparkEvent({ type: 'mail', from: 'dog:7', to: 'alice' })?.kind, 'bark')
  assert.equal(sparkEvent({ type: 'changed' }), null)
  assert.deepEqual(pulseEvent({ type: 'node_event', node: 'alice', event: 'turn_done' }), { kind: 'turnEnd', node: 'alice' })
  assert.deepEqual(streamEvent({ type: 'node_stream', node: 'alice', kind: 'tool', id: 't1', text: 'Edit' }), { kind: 'tool', node: 'alice', text: 'Edit' })
})

test('every event the detectors can produce has a picture and a sound in the playbook', () => {
  const produced: EventKind[] = [
    'hire', 'rehire', 'retire', 'move', 'reorder', 'rename', 'freeze', 'thaw', 'limit', 'halt', 'unhalt',
    'interrupt', 'turnStart', 'turnEnd', 'tool', 'toolDone', 'thinking', 'writing', 'compact', 'error',
    'question', 'answer', 'docs', 'model', 'account', 'effort', 'credits', 'wake', 'sleep', 'ready',
    'working', 'blocked', 'idle', 'waiting', 'queued', 'mailbox', 'zap', 'userSend', 'toUser', 'bark',
    'orgInbox', 'killswitch', 'killswitchOff', 'ticket', 'ticketDone', 'attention', 'userMail', 'urgent',
    'externalMail', 'dogNew', 'dogGone', 'dogFired', 'audience', 'unaudience', 'creditRequest', 'settings', 'cost',
  ]
  const missing = produced.filter(k => !PLAYBOOK_KINDS.includes(k))
  assert.deepEqual(missing, [])
  for (const user of ['click', 'tab', 'toggle', 'select', 'type', 'enter', 'erase', 'zoomIn', 'zoomOut', 'pan',
    'grab', 'drop', 'menu', 'copy', 'paste', 'fileDrop', 'dialogOpen', 'dialogClose', 'popup', 'toast',
    'toastError', 'send', 'destroy', 'epicOn', 'epicLaunch', 'epicOff', 'scroll', 'focus', 'undo', 'redo',
    'shortcut', 'doubleClick', 'linkDown', 'linkUp', 'usageWarn', 'usageMax', 'usageReset', 'brownout',
    // the final version's additions
    'confirm', 'refused', 'notice', 'combo', 'navigate'] as const) {
    assert.equal(PLAYBOOK_KINDS.includes(user), true, `no effect for the user action ${user}`)
  }
})

test('every sound synthesizes, and the voice budget holds under a flood', () => {
  const audio = fakeAudio()
  let synth = new EpicSynth(audio.Ctor)
  assert.equal(SOUND_NAMES.length >= 58, true, `only ${SOUND_NAMES.length} sounds`)
  for (const added of ['combo', 'note', 'confirm', 'refused', 'maxed', 'ping'] as const) {
    assert.equal(SOUND_NAMES.includes(added), true, `the final version's ${added} sound`)
  }
  for (const name of SOUND_NAMES) {
    // a fresh synth before the budget could refuse the next one
    if (synth.active >= LIGHT_CAP - 1) { synth.close(); synth = new EpicSynth(audio.Ctor) }
    const before = audio.log.nodes
    assert.equal(synth.play(name), true, `${name} was refused`)
    assert.equal(audio.log.nodes > before, true, `${name} built no nodes`)
  }
  synth.close()
  const flood = new EpicSynth(audio.Ctor)
  let clicks = 0
  for (let i = 0; i < 200; i++) if (flood.play('click')) clicks++
  assert.equal(clicks, LIGHT_CAP, 'light sounds stop at their cap')
  let loud = 0
  for (let i = 0; i < 200; i++) if (flood.play('boom')) loud++
  assert.equal(clicks + loud, VOICE_CAP, 'nothing plays past the voice cap')
  flood.close()
  assert.equal(flood.play('zap'), false, 'a closed synth plays nothing')
})

test('the stage caps its particles and leaves nothing behind', () => {
  const stage = new Stage(document)
  assert.equal(document.querySelectorAll('canvas.epic-stage').length, 1)
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.epic-stage')!
  assert.equal(canvas.style.pointerEvents, 'none', 'the stage never takes a click')
  for (let i = 0; i < 100; i++) stage.burst(100, 100, { count: 100 })
  assert.equal(stage.particleCount, PARTICLE_CAP)
  stage.destroy()
  assert.equal(document.querySelectorAll('canvas.epic-stage').length, 0)
  stage.burst(1, 1)
  assert.equal(stage.particleCount, 0, 'a destroyed stage spawns nothing')
})

// It waits about 18 s of real time (70 ms for each effect, 1.2 s for the slow
// ones), longer than the runner's 10 s default per test (tests/run.mjs), so it
// sets its own timeout. Cut short, its loop runs on into the next tests and
// leaves a stage behind for them.
test('every effect in the playbook really draws, and the word effects draw their words', { timeout: 40_000 }, async () => {
  const rec = recordCanvas()
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  // the slow ones: a move lands after the chart carries the card; fireworks climb first
  const SLOW = new Set(['move', 'ticketDone', 'killswitch', 'killswitchOff', 'epicOn', 'halt', 'urgent', 'attention', 'compact', 'interrupt'])
  try {
    const blank: string[] = []
    for (const kind of PLAYBOOK_KINDS) {
      if (kind === 'dialogClose') continue   // a whoosh and nothing else, by design
      const before = rec.calls.length
      const show = startEpic({ audio: null, greet: 'none' })
      show.cue(kind, { node: 'alice', other: 'boss', text: 'Bash', n: 2 })
      await wait(SLOW.has(kind) ? 1200 : 70)
      show.stop()
      if (rec.calls.length === before) blank.push(kind)
    }
    assert.deepEqual(blank, [], 'effects that drew nothing')
    for (const word of ['EPIC MODE', 'FROZEN!', 'STOP', 'ZAP!', 'HIRED!', 'TELEPORTED!', 'TICKET CLOSED!', 'WOOF!', 'BASH!', 'HALTED', 'UNDO!',
      // the final version's additions (a new rank is named in the corner
      // badge now, not in a word of its own: epicmode-final checks it)
      'REFUSED!', 'REPORT!', 'ALICE']) {
      assert.equal(rec.texts.includes(word), true, `never drew ${word}`)
    }
  } finally { rec.restore() }
})

test('the stage runs one frame loop, however many effects spawn from inside a frame', () => {
  const pending: ((t: number) => void)[] = []
  const view = window as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
  view.requestAnimationFrame = (cb: (t: number) => void) => { pending.push(cb); return pending.length }
  view.cancelAnimationFrame = () => {}
  const stage = new Stage(document)
  try {
    // rockets and comets burst from inside their own step: the old loop forked here
    for (let i = 0; i < 4; i++) stage.firework(100 + i * 50, 300)
    stage.comet(10, 10, 400, 300)
    stage.meteor(300, 300)
    assert.equal(pending.length, 1, 'one frame requested')
    let most = 0
    for (let frame = 0; frame < 90 && pending.length; frame++) {
      const run = pending.splice(0)
      for (const cb of run) cb(1000 + frame * 16)
      most = Math.max(most, pending.length)
    }
    assert.equal(most, 1, `at most one frame is ever pending (saw ${most})`)
  } finally {
    stage.destroy()
    delete view.requestAnimationFrame
    delete view.cancelAnimationFrame
  }
})

test('a direct show stages taps, survives unknown frames and stops cleanly', () => {
  const audio = fakeAudio()
  const show = startEpic({ audio: audio.Ctor, greet: 'enable' })
  const tap = taps.epic
  assert.equal(tap !== null, true, 'the show installs the taps')
  const before = show.staged
  tap!.frame('acme', { type: 'mail', from: 'boss', to: 'alice' })
  tap!.frame('acme', { type: 'record_changes', upserts: [] })
  tap!.frame('acme', null)
  tap!.tree('acme', tree([node('boss')]))
  tap!.tree('acme', tree([node('boss', { busy: true })]))
  tap!.action('acme', 'interrupt', 'boss')
  assert.equal(show.staged >= before + 3, true, `staged ${show.staged - before}`)
  show.stop()
  assert.equal(taps.epic === null, true, 'and removes them')
  assert.equal(audio.log.closed, 1)
  assert.equal(document.querySelectorAll('canvas.epic-stage').length, 0)
})
