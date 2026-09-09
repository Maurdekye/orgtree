// progress.test.tsx — FR-2, the desk's task-progress panel (canvas/progress.tsx).
//
// THE ONE PROPERTY THIS SUITE EXISTS TO HOLD: the panel never renders EMPTY.
// When it has no data it says WHICH kind of nothing — "no todo list in the
// loaded transcript window", "Antigravity agents have no todo or plan source
// orgtree knows of" — because an empty checklist teaches the operator that
// the agent is doing nothing, when the truth is that we do not know.
//
// FR-17 (2026-09-05): Codex's native `turn/plan/updated` checklist now runs
// through this SAME panel, as its OWN labelled source (`source: 'codex-plan'`)
// — never folded into or mistaken for Claude's TodoWrite path. Antigravity is
// the only lane still `lane-cannot`.
//
// §1 is the lane × state truth table over `deriveProgress`, asserting the
//    VERDICT and NON-EMPTY COPY in every cell. A cell that merely rendered
//    "nothing" would pass a snapshot test while the feature is broken; the
//    Codex cells additionally prove Claude-shaped fixtures (TodoWrite rows/
//    chips) are NEVER read as a Codex plan (anti-fabrication) and Antigravity
//    still asserts `lane-cannot` by name.
// §1e is Codex's OWN dedicated matrix, on its OWN wire shape (a 'plan' live
//    row / a `codexPlan` transcript record): live, durable, all three
//    statuses, the live-no-body degrade, explicit clearing vs never-observed,
//    successive snapshots (newest wins), and prior-turn labelling — real
//    turnId identity preferred, timestamp fallback only when identity is
//    unavailable, an equal timestamp never mislabelled, and idle/restarted
//    state never labelled "previous" for want of anything to be after.
// §2 pins the `☑ ◐ ☐` glyph parser to the three glyphs supervisor._todo_glyphs
//    emits — change one there and THIS is what goes red.
// §3 mounts ProgressView and reads the DOM: the note is present in every
//    state, the checklist only when there are items, the "previous list"
//    marker whenever what is shown is not current, and a Codex section's own
//    header names Codex on screen.
// §4 mounts the real DeskChat against the fake server. ⚠ THE FIFTH TAB IS NO
//    LONGER THIS PANEL: the user ruled on 2026-09-05 21:07 that its contents
//    are replaced entirely by the docket items the agent is answerable for,
//    so §4 pins THAT wiring — the tab is `docket`, the chip counts the rows
//    the tab lists (and another agent's item is in the fixture so "lists my
//    items" cannot pass on a tab listing everything), and selecting a row
//    opens the docket's own detail pane. §4b is the same wiring on a Codex
//    node, and adds the review case: an item this agent was NAMED TO REVIEW
//    is its work too, while still naming its real owner in the assignment
//    column.
//    §1–§3b still cover `deriveProgress`/`ProgressView` as a unit. ⚠ NOTHING
//    IN src/ RENDERS ProgressView SINCE THE TAB CHANGED — raised for a
//    decision rather than deleted here.
//
// ANTI-VACUITY, per behavioural claim (verified red while writing — see the
// commit message for the mutations run):
//   · §1 non-empty copy: `note: ''` in any deriveTodo branch → red
//   · §1 anti-fabrication: making the openai branch fall through to the
//     Claude TodoWrite path → red (a Claude-shaped fixture would then show
//     items/supply='live'|'durable')
//   · §1e successive snapshots: reading the FIRST matching message instead
//     of walking backward from the newest → red
//   · §1e identity-preferred labelling: dropping the `current` check and
//     falling straight to the timestamp rule → red (the "identity says
//     CURRENT despite an earlier timestamp" case flips)
//   · §2 glyphs: a glyph swap in parseTodoResult → red
//   · §4 wiring: removing the `view === 'docket'` branch → red
//   · §4 the filter: `agentItems` returning every item → the third row
//     (another agent's) appears and both the list and the chip go red
//   · §4b reviewership: dropping the `reviewer?.node === nid` half of
//     `agentItems` → the review row vanishes and the count falls to 1
//   · §5d the desk's world: putting the tab's old narrow `handles`
//     (item + agent) back → red on the document chip
//   · §5d CONTROL: declaring `handles` as a literal all-kinds set instead of
//     deriving it from the desk's own → red, because a desk with no reader
//     would then advertise one
//   · §5c and §5d the item route: deleting the in-place `setSelId` and
//     delegating every kind to the desk → both go red, because the tab
//     navigates the canvas away from a row already on screen
//
// Run:  cd frontend && node tests/run.mjs progress

import './harness'
import { advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { deriveProgress, parseTodoResult, ProgressView, WORKING_STALE_MS } from '../src/canvas/progress'
import type { ProgressModel } from '../src/canvas/progress'
import type { CanvasNode, LiveRow } from '../src/canvas/shared'
import type { Convo } from '../src/convo'
import { resetConvos } from '../src/convo'
import type { ChatMessage, ChatPayload, OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

// ---------------------------------------------------------------- fixtures

function node(over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'agent', state: 'live', tier: 'sonnet', model_id: 'sonnet', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
    busy: false, proc_live: false, tasks: 0, bg_tasks: 0, last_status: null,
    inflight_at: null, activity: { phase: 'thinking' },
    ...over,
  }
}

function convo(over: Partial<Convo> = {}, messages: ChatMessage[] = [],
               codexTurnId?: string | null): Convo {
  const chat: ChatPayload = {
    busy: false, queued: 0, responding: false, last_error: null, occupancy: null,
    messages, live: [], mail_pending: 0, pending_mail: [],
    ...(codexTurnId !== undefined ? { codex_turn_id: codexTurnId } : {}),
  } as unknown as ChatPayload
  return {
    chat, live: [], pending: [], draft: '', thinking: '', thinkSecs: null,
    win: 120, loadingOlder: false, loaded: true, ...over,
  }
}

const GLYPHS = '☑ read the plan\n◐ write the panel\n☐ land it'

function todoMsg(result = GLYPHS, ts = '2026-09-04T20:00:00.000Z'): ChatMessage {
  return { role: 'assistant', text: '', ts, seq: 1,
    tools: [{ name: 'TodoWrite', arg: '', id: 'toolu_1', result, result_lines: 3 }] }
}

const liveTodoRow = (todos?: LiveRow['todos']): LiveRow =>
  ({ kind: 'tool', text: 'TodoWrite', id: 'toolu_live', at: '2026-09-04T20:30:00.000Z',
    ...(todos ? { todos } : {}) })

// FR-17: Codex's native fixtures, structurally parallel to the two above but
// on their OWN wire shape (a 'plan' live row / a `codexPlan` transcript
// record) — never the Claude shape, so a test built on these cannot pass by
// accident through code that actually reads TodoWrite.
// already in the NORMALIZED vocabulary — supervisor._codex_plan_steps maps
// codex's own camelCase 'inProgress' to 'in_progress' on the backend, once,
// before either the journal or the live wire ever sees it (Astra's guard:
// no redundant normalization / no second, divergent mapping on this side).
const PLAN_STEPS = [
  { step: 'read the plan', status: 'completed' },
  { step: 'write the panel', status: 'in_progress' },
  { step: 'land it', status: 'pending' },
]

function planMsg(steps = PLAN_STEPS, ts = '2026-09-04T20:00:00.000Z',
                 explanation: string | null = null, turnId = 'turn-1'): ChatMessage {
  return { role: 'assistant', text: '', ts, seq: 1,
    codexPlan: { steps, explanation, threadId: 'thread-1', turnId } }
}

const livePlanRow = (steps?: LiveRow['plan'], explanation: string | null = null,
                     turnId = 'turn-1'): LiveRow =>
  ({ kind: 'plan', text: 'checklist updated', at: '2026-09-04T20:30:00.000Z',
    threadId: 'thread-1', turnId, explanation, ...(steps ? { plan: steps } : {}) })

const items = (m: ProgressModel) => (m.todo.items ?? []).map((t) => [t.status, t.content])

// ------------------------------------------------ §1 the lane × state table

test('§1 deriveProgress: every cell of the lane × state table carries a verdict AND a sentence', () => {
  const lanes = { claude: 'sonnet', openrouter: 'or-anthropic-claude-sonnet-4', codex: 'luna', antigravity: 'flash' }
  const states: Record<string, { n: Partial<CanvasNode>; c: Partial<Convo>; msgs?: ChatMessage[] }> = {
    'live todo':      { n: { busy: true, inflight_at: '2026-09-04T20:29:00Z' },
                        c: { live: [liveTodoRow([{ content: 'a', status: 'in_progress' }])] } },
    'live, no body':  { n: { busy: true }, c: { live: [liveTodoRow()] }, msgs: [todoMsg()] },
    'durable todo':   { n: {}, c: {}, msgs: [todoMsg()] },
    'none':           { n: {}, c: {}, msgs: [{ role: 'user', text: 'hi', seq: 0 }] },
    'no transcript':  { n: {}, c: {}, msgs: [] },
    'loading':        { n: {}, c: { loaded: false, chat: null } },
    'archived':       { n: { state: 'archived' }, c: {}, msgs: [todoMsg()] },
    'restarted':      { n: { busy: false, proc_live: false }, c: {}, msgs: [todoMsg()] },
  }
  for (const [lane, tier] of Object.entries(lanes)) {
    for (const [state, s] of Object.entries(states)) {
      const m = deriveProgress(node({ tier, ...s.n }), convo(s.c, s.msgs ?? []))
      const cell = `${lane} × ${state}`
      // THE PROPERTY: never silence. Every section, every cell.
      assert.ok(m.todo.note.trim().length > 10, `${cell}: todo note is empty`)
      assert.ok(m.subagents.note.trim(), `${cell}: subagent note is empty`)
      assert.ok(m.reported.note.trim(), `${cell}: reported note is empty`)
      assert.ok(m.activity.note.trim(), `${cell}: activity note is empty`)
      assert.ok(m.processNote.trim(), `${cell}: process note is empty`)
      assert.ok(m.chip.trim(), `${cell}: chip text is empty`)
      assert.equal(m.chipTitle, m.todo.note, `${cell}: chip tooltip is not the todo note`)
      if (lane === 'antigravity') {
        // Antigravity still has no source orgtree knows of at all — unchanged.
        assert.equal(m.todo.supply, 'lane-cannot', `${cell}: supply`)
        assert.equal(m.todo.items, null, `${cell}: a lane that cannot supply must show no list`)
        assert.match(m.todo.note, /Antigravity/, `${cell}: note names the lane`)
        assert.match(m.todo.note, /cannot see/, `${cell}: note says orgtree cannot see, not that there is none`)
        assert.equal(m.chip, 'todo n/a', `${cell}: chip`)
        continue
      }
      if (lane === 'codex') {
        // FR-17 supersedes the old "Codex cannot" pin: it is never
        // 'lane-cannot' again, and it is ALWAYS its own labelled source.
        assert.notEqual(m.todo.supply, 'lane-cannot', `${cell}: supply must not be lane-cannot`)
        assert.equal(m.todo.source, 'codex-plan', `${cell}: source is always labelled`)
        // ⚠ ANTI-FABRICATION: every fixture in `states` is Claude-shaped (a
        // TodoWrite tool row / tools chip) — none of it is a Codex 'plan' row
        // or a `codexPlan` transcript record. If Codex ever picked any of it
        // up as its own checklist, this is exactly where it would show: an
        // `items` list or a 'live'/'durable'/'updating' supply born from data
        // that was never turn/plan/updated. It must not.
        assert.ok(['none-in-window', 'loading'].includes(m.todo.supply),
          `${cell}: Claude-shaped fixtures must never read as a Codex plan (got ${m.todo.supply})`)
        assert.equal(m.todo.items, null, `${cell}: no items from data that was never turn/plan/updated`)
        assert.doesNotMatch(m.todo.note, /TodoWrite/, `${cell}: never speaks in Claude's tool name`)
        continue
      }
      // Claude and OpenRouter run the same CLI: identical verdicts
      switch (state) {
        case 'live todo':
          assert.equal(m.todo.supply, 'live', cell)
          assert.deepEqual(items(m), [['in_progress', 'a']], cell)
          assert.match(m.todo.note, /^live, this turn: 0\/1 done · now: a/, cell)
          assert.equal(m.chip, '◐ 0/1', cell)
          break
        case 'live, no body':
          assert.equal(m.todo.supply, 'updating', cell)
          assert.match(m.todo.note, /updating its todo list now/, cell)
          assert.match(m.todo.note, /PREVIOUS list/, `${cell}: the shown list must be called previous`)
          assert.equal(items(m).length, 3, `${cell}: the previous list is shown, dimmed`)
          assert.match(m.chip, /↻/, cell)
          break
        case 'durable todo':
          assert.equal(m.todo.supply, 'durable', cell)
          assert.deepEqual(items(m), [['completed', 'read the plan'], ['in_progress', 'write the panel'], ['pending', 'land it']], cell)
          assert.equal(m.todo.earlierTurn, false, cell)
          assert.match(m.todo.note, /^from the transcript: 1\/3 done · now: write the panel/, cell)
          assert.equal(m.chip, '◐ 1/3', cell)
          break
        case 'none':
          assert.equal(m.todo.supply, 'none-in-window', cell)
          assert.match(m.todo.note, /no todo list in the loaded transcript window \(last 1 message\)/, cell)
          assert.match(m.todo.note, /older one may exist further back/, `${cell}: the window is named as a window`)
          assert.equal(m.chip, 'no todos', cell)
          break
        case 'no transcript':
          assert.equal(m.todo.supply, 'none-in-window', cell)
          assert.match(m.todo.note, /no transcript yet/, cell)
          break
        case 'loading':
          assert.equal(m.todo.supply, 'loading', cell)
          assert.match(m.todo.note, /cannot say yet/, `${cell}: loading must not claim there is none`)
          assert.equal(m.chip, 'todo …', cell)
          break
        case 'archived':
          assert.equal(m.historical, true, cell)
          assert.match(m.processNote, /retired/, cell)
          assert.match(m.processNote, /not live progress/, cell)
          assert.equal(m.todo.supply, 'durable', `${cell}: the last list is still shown, as a record`)
          break
        case 'restarted':
          // after a backend restart the live tail is gone and only the
          // transcript remains: the panel must say nothing is live rather
          // than present the durable list as current
          assert.equal(m.todo.supply, 'durable', cell)
          assert.match(m.processNote, /not in a turn/, cell)
          assert.match(m.processNote, /nothing below is live/, cell)
          break
      }
    }
  }
})

test('§1b deriveProgress: a durable list from BEFORE the running turn is labelled as earlier', () => {
  const m = deriveProgress(
    node({ busy: true, inflight_at: '2026-09-04T20:10:00.000Z' }),
    convo({}, [todoMsg(GLYPHS, '2026-09-04T20:00:00.000Z')]))
  assert.equal(m.todo.supply, 'durable')
  assert.equal(m.todo.earlierTurn, true)
  assert.match(m.todo.note, /EARLIER turn/)
  assert.match(m.todo.note, /running turn has not written a todo list yet/)
  assert.match(m.chip, /\(prev\)/)
  // and the same list written AFTER the turn began is current
  const cur = deriveProgress(
    node({ busy: true, inflight_at: '2026-09-04T20:10:00.000Z' }),
    convo({}, [todoMsg(GLYPHS, '2026-09-04T20:11:00.000Z')]))
  assert.equal(cur.todo.earlierTurn, false)
  assert.doesNotMatch(cur.chip, /prev/)
})

test('§1c deriveProgress: a CLEARED list is a list, not an absence', () => {
  const live = deriveProgress(node({ busy: true }), convo({ live: [liveTodoRow([])] }))
  assert.equal(live.todo.supply, 'live')
  assert.deepEqual(live.todo.items, [])
  assert.match(live.todo.note, /cleared its todo list/)
  assert.equal(live.chip, 'todo cleared')
  const durable = deriveProgress(node(), convo({}, [todoMsg('')]))
  assert.equal(durable.todo.supply, 'durable')
  assert.deepEqual(durable.todo.items, [])
  assert.match(durable.todo.note, /cleared/)
})

// -------------------------------------------- §1e FR-17: Codex's own source

test('§1e deriveProgress (Codex): live, durable, all three statuses, explanation preserved', () => {
  const live = deriveProgress(node({ tier: 'luna', busy: true }),
    convo({ live: [livePlanRow(PLAN_STEPS, 'because the plan changed')] }))
  assert.equal(live.todo.supply, 'live')
  assert.equal(live.todo.source, 'codex-plan')
  assert.deepEqual(items(live), [['completed', 'read the plan'], ['in_progress', 'write the panel'], ['pending', 'land it']])
  assert.equal(live.todo.explanation, 'because the plan changed')
  assert.match(live.todo.note, /^live, this turn: 1\/3 done · now: write the panel/)
  assert.match(live.todo.note, /because the plan changed/)
  assert.equal(live.chip, '◐ 1/3')

  const durable = deriveProgress(node({ tier: 'luna' }), convo({}, [planMsg()]))
  assert.equal(durable.todo.supply, 'durable')
  assert.equal(durable.todo.earlierTurn, false)
  assert.deepEqual(items(durable), [['completed', 'read the plan'], ['in_progress', 'write the panel'], ['pending', 'land it']])
  assert.match(durable.todo.note, /Codex's own turn checklist/)
})

test('§1e deriveProgress (Codex): a live plan row with no contents degrades like a live TodoWrite row does', () => {
  const m = deriveProgress(node({ tier: 'luna', busy: true }),
    convo({ live: [livePlanRow(undefined)] }, [planMsg()]))
  assert.equal(m.todo.supply, 'updating')
  assert.match(m.todo.note, /updating its checklist now/)
  assert.match(m.todo.note, /PREVIOUS checklist/)
  assert.equal(items(m).length, 3)
})

test('§1e deriveProgress (Codex): an explicit empty plan is CLEARED, not absent — distinct from never having observed one', () => {
  const cleared = deriveProgress(node({ tier: 'luna', busy: true }), convo({ live: [livePlanRow([])] }))
  assert.equal(cleared.todo.supply, 'live')
  assert.deepEqual(cleared.todo.items, [])
  assert.match(cleared.todo.note, /cleared its todo list/)
  assert.equal(cleared.chip, 'todo cleared')
  const neverObserved = deriveProgress(node({ tier: 'luna' }), convo({}, []))
  assert.equal(neverObserved.todo.items, null, 'no event at all must never render as an empty (cleared) list')
  assert.match(neverObserved.todo.note, /no transcript yet/)
})

test('§1e deriveProgress (Codex): successive snapshots — the newest durable one wins, not the first', () => {
  const m = deriveProgress(node({ tier: 'luna' }), convo({}, [
    planMsg([{ step: 'a', status: 'pending' }], '2026-09-04T20:00:00.000Z'),
    planMsg([{ step: 'a', status: 'completed' }], '2026-09-04T20:05:00.000Z'),
  ]))
  assert.deepEqual(items(m), [['completed', 'a']])
})

test('§1e deriveProgress (Codex): prior-turn labelling prefers REAL turn identity over a timestamp guess', () => {
  // identity says CURRENT even though the timestamp alone would look earlier
  // than inflight_at — identity wins, so it must NOT be marked previous
  const currentByIdentity = deriveProgress(
    node({ tier: 'luna', busy: true, inflight_at: '2026-09-04T20:10:00.000Z' }),
    convo({}, [planMsg(PLAN_STEPS, '2026-09-04T20:00:00.000Z', null, 'turn-9')], 'turn-9'))
  assert.equal(currentByIdentity.todo.earlierTurn, false)
  assert.doesNotMatch(currentByIdentity.chip, /prev/)
  // identity says EARLIER (a different, known turnId) even though the
  // timestamp alone would look current
  const earlierByIdentity = deriveProgress(
    node({ tier: 'luna', busy: true, inflight_at: '2026-09-04T19:00:00.000Z' }),
    convo({}, [planMsg(PLAN_STEPS, '2026-09-04T20:00:00.000Z', null, 'turn-8')], 'turn-9'))
  assert.equal(earlierByIdentity.todo.earlierTurn, true)
  assert.match(earlierByIdentity.todo.note, /EARLIER turn/)
  assert.match(earlierByIdentity.chip, /\(prev\)/)
  // no identity available anywhere (older-backend record, codex_turn_id
  // absent) — falls back to Claude's own strict-less-than timestamp rule,
  // and an EQUAL timestamp must not be mislabelled as earlier
  const equalTs = deriveProgress(
    node({ tier: 'luna', busy: true, inflight_at: '2026-09-04T20:10:00.000Z' }),
    convo({}, [planMsg(PLAN_STEPS, '2026-09-04T20:10:00.000Z', null, '')]))
  assert.equal(equalTs.todo.earlierTurn, false, 'an equal timestamp is not earlier')
  const strictlyEarlier = deriveProgress(
    node({ tier: 'luna', busy: true, inflight_at: '2026-09-04T20:10:00.000Z' }),
    convo({}, [planMsg(PLAN_STEPS, '2026-09-04T20:00:00.000Z', null, '')]))
  assert.equal(strictlyEarlier.todo.earlierTurn, true)
  // idle (not busy) — nothing is "the running turn", so the last known
  // checklist is just the last known checklist, never labelled previous,
  // even with an identity mismatch or a restart that wiped codex_turn_id
  const idle = deriveProgress(node({ tier: 'luna', busy: false }),
    convo({}, [planMsg(PLAN_STEPS, '2026-09-04T20:00:00.000Z', null, 'turn-8')], null))
  assert.equal(idle.todo.earlierTurn, false)
})

test('§1d deriveProgress: subagents, reported status and activity', () => {
  // bg_tasks had NO frontend type before FR-2 — a fixture with only `tasks`
  // would leave it undefined and render 0 forever (the plan's named trap)
  const bg = deriveProgress(node({ busy: true, tasks: 1, bg_tasks: 2 }), convo())
  assert.equal(bg.subagents.fg, 1)
  assert.equal(bg.subagents.bg, 2)
  assert.match(bg.subagents.note, /1 foreground · 2 background subagents running/)
  assert.match(bg.subagents.note, /outlive the reply/)
  assert.match(bg.chip, /· 3 sub$/)
  const noneBusy = deriveProgress(node({ busy: true }), convo())
  assert.equal(noneBusy.subagents.note, 'no subagents running')
  const synthetic = deriveProgress(node({ tasks: undefined, bg_tasks: undefined }), convo())
  assert.equal(synthetic.subagents.known, false)
  assert.match(synthetic.subagents.note, /carries no subagent counts/)

  // reported status: the summary is TEXT here (it was a tooltip on the desk)
  const never = deriveProgress(node(), convo())
  assert.equal(never.reported.status, null)
  assert.match(never.reported.note, /never reported a status/)
  const fresh = deriveProgress(node({ last_status: { status: 'working', summary: 'wiring the tab', at: new Date(Date.now() - 120_000).toISOString() } }), convo())
  assert.equal(fresh.reported.stale, false)
  assert.equal(fresh.reported.summary, 'wiring the tab')
  assert.match(fresh.reported.note, /^reported 2m ago$/)
  // staleness mirrors the engine's own 20-minute check-up rule
  assert.equal(WORKING_STALE_MS, 20 * 60 * 1000)
  const stale = deriveProgress(node({ last_status: { status: 'working', summary: 's', at: new Date(Date.now() - WORKING_STALE_MS - 60_000).toISOString() } }), convo())
  assert.equal(stale.reported.stale, true)
  assert.match(stale.reported.note, /20-minute check-up threshold/)
  const oldDone = deriveProgress(node({ last_status: { status: 'done', summary: 's', at: new Date(Date.now() - WORKING_STALE_MS * 4).toISOString() } }), convo())
  assert.equal(oldDone.reported.stale, false, 'only "working" goes stale — an old "done" is simply old')

  // activity: phase from the node, tail from the live wire, and a sentence
  // when the wire is empty
  const idle = deriveProgress(node(), convo())
  assert.equal(idle.activity.note, 'not in a turn — no live activity')
  const quiet = deriveProgress(node({ busy: true, activity: { phase: 'thinking' } }), convo())
  assert.match(quiet.activity.note, /thinking/)
  assert.match(quiet.activity.note, /no tool calls on the live wire yet/)
  const tool = deriveProgress(node({ busy: true, activity: { phase: 'tool', tool: 'Bash · ls' } }),
    convo({ live: [{ kind: 'tool', text: 'Read · a.ts' }, { kind: 'text', text: 'x' }, { kind: 'tool', text: 'Bash · ls' }] }))
  assert.equal(tool.activity.note, 'running a tool: Bash · ls')
  assert.deepEqual(tool.activity.tail.map((r) => r.text), ['Read · a.ts', 'Bash · ls'])
})

// ------------------------------------------------------- §2 the glyph parser

test('§2 parseTodoResult pins the three glyphs supervisor._todo_glyphs emits', () => {
  assert.deepEqual(parseTodoResult(GLYPHS), [
    { content: 'read the plan', status: 'completed' },
    { content: 'write the panel', status: 'in_progress' },
    { content: 'land it', status: 'pending' },
  ])
  // CRLF-tolerant, blank-line-tolerant, and an unknown prefix DEGRADES TO A
  // VISIBLE pending item rather than a dropped one
  assert.deepEqual(parseTodoResult('☑ a\r\n\r\n?? odd\n'), [
    { content: 'a', status: 'completed' },
    { content: '?? odd', status: 'pending' },
  ])
  assert.deepEqual(parseTodoResult(''), [])
  assert.deepEqual(parseTodoResult(undefined), [])
})

// --------------------------------------------------------- §3 the view's DOM

test('§3 ProgressView: a sentence in every state; a checklist only with items; "previous" when not current', async () => {
  const cases: [string, ProgressModel, { items: number; previous: boolean; noteRe: RegExp }][] = [
    ['codex none', deriveProgress(node({ tier: 'luna' }), convo()), { items: 0, previous: false, noteRe: /no transcript yet/ }],
    ['codex live', deriveProgress(node({ tier: 'luna', busy: true }), convo({ live: [livePlanRow(PLAN_STEPS)] })), { items: 3, previous: false, noteRe: /live, this turn/ }],
    ['antigravity', deriveProgress(node({ tier: 'pro' }), convo()), { items: 0, previous: false, noteRe: /Antigravity/ }],
    ['none', deriveProgress(node(), convo({}, [{ role: 'user', text: 'x', seq: 0 }])), { items: 0, previous: false, noteRe: /no todo list in the loaded transcript window/ }],
    ['loading', deriveProgress(node(), convo({ loaded: false, chat: null })), { items: 0, previous: false, noteRe: /loading the transcript/ }],
    ['live', deriveProgress(node({ busy: true }), convo({ live: [liveTodoRow([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])] })), { items: 2, previous: false, noteRe: /live, this turn/ }],
    ['durable', deriveProgress(node(), convo({}, [todoMsg()])), { items: 3, previous: false, noteRe: /from the transcript/ }],
    ['updating', deriveProgress(node({ busy: true }), convo({ live: [liveTodoRow()] }, [todoMsg()])), { items: 3, previous: true, noteRe: /updating its todo list/ }],
    ['earlier turn', deriveProgress(node({ busy: true, inflight_at: '2026-09-04T20:10:00Z' }), convo({}, [todoMsg(GLYPHS, '2026-09-04T20:00:00Z')])), { items: 3, previous: true, noteRe: /EARLIER turn/ }],
    ['archived', deriveProgress(node({ state: 'archived' }), convo({}, [todoMsg()])), { items: 3, previous: true, noteRe: /from the transcript/ }],
  ]
  for (const [name, model, want] of cases) {
    const view = await mountView(<ProgressView model={model} />, (el) => el)
    try {
      const todo = view.el.querySelector('.progress-todo')
      assert.ok(todo, `${name}: no todo section`)
      const note = todo!.querySelector('.progress-note')?.textContent ?? ''
      assert.match(note, want.noteRe, `${name}: note`)
      assert.equal(todo!.querySelectorAll('.todo-item').length, want.items, `${name}: item count`)
      assert.equal(Boolean(todo!.querySelector('.todo-items.previous')), want.previous, `${name}: previous marker`)
      // the invariant, stated as DOM: no items ⇒ a sentence is on screen
      if (!want.items) assert.ok(note.trim().length > 10, `${name}: empty list AND empty note`)
      // FR-17: a Codex checklist's section header names its source, on screen
      if (name.startsWith('codex')) {
        assert.match(todo!.querySelector('h4')?.textContent ?? '', /Codex/, `${name}: header names Codex`)
      }
      // the whole panel always has the lane + process line
      assert.match(view.el.querySelector('.progress-state')?.textContent ?? '', /·/, `${name}: state line`)
      // every other section is a sentence too, whether open or folded
      for (const sec of ['subagents', 'reported', 'activity']) {
        assert.ok(view.el.querySelector(`.progress-${sec} h4`), `${name}: ${sec} header`)
      }
    } finally { await view.unmount() }
  }
  // glyph rendering: statuses reach the DOM as classes AND glyphs
  const v = await mountView(<ProgressView model={deriveProgress(node(), convo({}, [todoMsg()]))} />, (el) => el)
  try {
    const rows = [...v.el.querySelectorAll('.todo-item')]
    assert.deepEqual(rows.map((r) => r.className), ['todo-item completed', 'todo-item in_progress', 'todo-item pending'])
    assert.deepEqual(rows.map((r) => r.querySelector('.todo-glyph')?.textContent), ['☑', '◐', '☐'])
    assert.deepEqual(rows.map((r) => r.querySelector('.todo-text')?.textContent), ['read the plan', 'write the panel', 'land it'])
    // the reported section is OPEN by default and renders the summary as text
    // ⚠ DOM nodes are asserted as BOOLEANS: a failed assert.equal(el, null)
    // makes node inspect the whole jsdom tree for its diff, which on this
    // machine is an "Array buffer allocation failed" and a 60 s timeout
    // instead of a message (measured while writing this)
    assert.equal(Boolean(v.el.querySelector('.progress-reported-row')), false,
      'no status reported → no chip row, only the sentence')
    assert.match(v.el.querySelector('.progress-sec.progress-reported .progress-note')?.textContent ?? '', /never reported/)
  } finally { await v.unmount() }
  const withStatus = await mountView(<ProgressView model={deriveProgress(node({ last_status: { status: 'working', summary: 'the summary text', at: new Date().toISOString() } }), convo())} />, (el) => el)
  try {
    assert.equal(withStatus.el.querySelector('.progress-reported-row .statuschip.working')?.textContent, 'Working')
    assert.equal(withStatus.el.querySelector('.progress-summary')?.textContent, 'the summary text')
  } finally { await withStatus.unmount() }
})

test('§3b ProgressView: fold state is a habit — one app-wide key, and it toggles', async () => {
  localStorage.removeItem('orgtree-progress-open')
  const model = deriveProgress(node({ busy: true }), convo({ live: [{ kind: 'tool', text: 'Bash · ls' }] }))
  const view = await mountView(<ProgressView model={model} />, (el) => el)
  try {
    // activity is folded by default, so its tail is not in the DOM…
    assert.equal(Boolean(view.el.querySelector('.progress-tail')), false)
    // …but its HEADER is, so the section is never silently absent
    const btn = view.el.querySelector<HTMLButtonElement>('.progress-activity .progress-fold')
    assert.ok(btn)
    assert.equal(btn!.getAttribute('aria-expanded'), 'false')
    const { act } = await import('react')
    await act(async () => { btn!.click() })
    assert.equal(view.el.querySelector<HTMLButtonElement>('.progress-activity .progress-fold')?.getAttribute('aria-expanded'), 'true')
    assert.equal(view.el.querySelectorAll('.progress-tail li').length, 1)
    assert.match(localStorage.getItem('orgtree-progress-open') ?? '', /"activity":true/)
  } finally { await view.unmount() }
  // a fresh mount honours the stored habit
  const again = await mountView(<ProgressView model={model} />, (el) => el)
  try {
    assert.equal(again.el.querySelectorAll('.progress-tail li').length, 1, 'stored fold state was not honoured on remount')
  } finally { await again.unmount(); localStorage.removeItem('orgtree-progress-open') }
})

// ------------------------------------------------------ §4 the desk wiring

/** one docket row as the server serves it — only the fields the desk's tab
 *  and its chip actually read, so a change in the shape shows up here as a
 *  type error rather than as a row that renders blank */
const workRow = (over: Record<string, unknown>) => ({
  slug: 'an-item', rev: 1, kind: 'code', title: 'An item',
  objective: 'something is wrong; fix it', status: 'in_progress',
  blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'agent', generation: 1 }, owner_current: true,
  owner_state: 'live', reviewer: null, participants: [],
  created_by: { node: 'agent', generation: 1 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  docket_at: '2026-09-05T09:00:00.000Z',
  done_so_far: ['a step'], working_on_next: ['the next step'],
  last_updater: { node: 'agent', generation: 1 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [],
  dependencies: [], evidence: [], delivery: null, accepted: null,
  superseded_by: null, history: [], ...over,
})

test('§4 DeskChat: the fifth tab is the agent\'s OWN DOCKET, and the chip counts what it lists', async (t) => {
  resetConvos()
  useFakeClock()
  const server = new FakeServer()
  installFetch(server)
  server.busy = true
  server.userMsg('plan the work')
  // two items for this agent and one for somebody else — without the third
  // row, "the tab lists the agent's items" would pass on a tab that lists
  // EVERY item in the org, which is the Work panel and not this
  server.workItems = [
    workRow({ slug: 'mine-one', title: 'Mine one' }),
    workRow({ slug: 'mine-two', title: 'Mine two', status: 'blocked' }),
    workRow({ slug: 'someone-elses', title: 'Not mine',
              owner: { node: 'other-agent', generation: 1 },
              last_updater: { node: 'agent', generation: 1 } }),
  ]
  const n = node({ id: 'agent', busy: true, inflight_at: new Date().toISOString(), proc_live: true })
  const view = await mountView(
    <DeskChat node={n} map={new Map([['agent', n]])} op={op} slug="prog" toast={noop} pub={false} bare onJump={noop} />,
    (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  const tabs = [...view.el.querySelectorAll('.cc-tabs button')].map((b) => b.textContent)
  assert.deepEqual(tabs, ['chat', 'history', 'files', 'inbox', 'docket', 'presented'])
  assert.equal(Boolean(view.el.querySelector('.docket-agent')), false,
    'the panel must not be open on the chat tab')
  // the header chip: it counts the assignment, and it is a way in
  const chip = view.el.querySelector<HTMLButtonElement>('.cc-head-meta .progress-chip')
  assert.ok(chip, 'no docket chip in the metadata row')
  assert.equal(chip!.textContent, 'docket 2')
  assert.match(chip!.getAttribute('title') ?? '', /assigned to agent/)
  const { act } = await import('react')
  await act(async () => { chip!.click() })
  const panel = view.el.querySelector('.docket-agent')
  assert.ok(panel, 'clicking the chip did not open the docket tab')
  const names = [...panel!.querySelectorAll('.mailrow.docket-row .l1 .mfrom')]
    .map((r) => r.textContent)
  assert.deepEqual(names, ['mine-one', 'mine-two'])
  assert.equal(names.length, Number(chip!.textContent!.replace(/\D/g, '')),
    'the chip and the list disagree about how much work this agent has')
  // it is the DOCKET's own row, not a second rendering of one: the status
  // vocabulary and the assignment column come with it
  assert.match(panel!.querySelector('.mailrow.docket-row .l2')?.textContent ?? '',
    /In progress/)
  // the NAME, not the whole column: the column also carries the model chip
  // (a single letter) since the docket learned to show an owner's current
  // identity, so reading the column's text would compare 'Sagent'
  assert.equal(panel!.querySelector('.mailrow.docket-row .l2 .docket-actor-name')?.textContent,
    'agent')
  // and selecting one opens the docket's own detail pane
  await act(async () => { (panel!.querySelector('.mailrow.docket-row') as HTMLElement).click() })
  assert.match(view.el.querySelector('.docket-agent .mailer-read')?.textContent ?? '',
    /DONE SO FAR/)
  // the tab strip is the other way in
  const chatTab = [...view.el.querySelectorAll<HTMLButtonElement>('.cc-tabs button')].find((b) => b.textContent === 'chat')!
  await act(async () => { chatTab.click() })
  assert.equal(Boolean(view.el.querySelector('.docket-agent')), false)
  const docketTab = [...view.el.querySelectorAll<HTMLButtonElement>('.cc-tabs button')].find((b) => b.textContent === 'docket')!
  await act(async () => { docketTab.click() })
  assert.ok(view.el.querySelector('.docket-agent'))
})

test('§4b DeskChat: the tab is what the agent is ANSWERABLE for — reviews included, on any lane', async (t) => {
  resetConvos()
  useFakeClock()
  const server = new FakeServer()
  installFetch(server)
  server.userMsg('plan the work')
  // a Codex node, because nothing about the docket tab is lane-specific and
  // this used to be the lane whose panel was fed from a different source
  server.workItems = [
    workRow({ slug: 'i-own-this', title: 'I own this' }),
    workRow({ slug: 'i-review-this', title: 'I review this', status: 'review',
              owner: { node: 'other-agent', generation: 1 },
              reviewer: { node: 'agent', generation: 1 } }),
    workRow({ slug: 'neither', title: 'Neither',
              owner: { node: 'other-agent', generation: 1 },
              reviewer: { node: 'third-agent', generation: 1 } }),
  ]
  const n = node({ id: 'agent', tier: 'luna' })
  const view = await mountView(
    <DeskChat node={n} map={new Map([['agent', n]])} op={op} slug="prog" toast={noop} pub={false} bare onJump={noop} />,
    (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  const chip = view.el.querySelector<HTMLButtonElement>('.cc-head-meta .progress-chip')
  assert.ok(chip, 'no docket chip in the metadata row')
  assert.equal(chip!.textContent, 'docket 2', 'a review it was named to is its work too')
  const { act } = await import('react')
  await act(async () => { chip!.click() })
  const names = [...view.el.querySelectorAll('.docket-agent .mailrow.docket-row .l1 .mfrom')]
    .map((r) => r.textContent)
  assert.deepEqual(names, ['i-own-this', 'i-review-this'])
  // the review it holds still names its OWNER in the assignment column — the
  // tab shows what it is answerable for, and never claims it owns the item
  const reviewRow = [...view.el.querySelectorAll('.docket-agent .mailrow.docket-row')]
    .find((r) => r.querySelector('.l1 .mfrom')?.textContent === 'i-review-this')!
  assert.equal(reviewRow.querySelector('.l2 .docket-updater')?.textContent, 'other-agent')
  // an org with no work for this agent SAYS SO rather than rendering blank
  server.workItems = []
  await advance(20000)
  await flush()
  assert.match(view.el.querySelector('.docket-agent')?.textContent ?? '',
    /no docket items are assigned to agent/)
  assert.equal(view.el.querySelector('.cc-head-meta .progress-chip')?.textContent, 'docket 0')
})

// ------------------------------------------------ §5 references in the card
//
// A checklist item and a status summary are PROSE AN AGENT WROTE, so a
// canonical reference can appear in either. What makes this worth a section
// rather than a line: the card renders text NODES, not markdown, so it uses
// the React reference renderer — and a surface that judges references against
// nothing would light up every name it sees.
//
// ⚠ THE ACTIVITY AND NOTE LINES ARE DELIBERATELY LEFT ALONE. `progress-note`,
// the subagents note and the activity tail are composed by `deriveProgress`
// itself — machine sentences about the agent, not text the agent wrote — and
// linkifying them would invent a reference nobody put there. §5b pins that.

/** the same glyph fixture as `GLYPHS`, with a canonical reference written into
 *  the items — the shape a real checklist line takes.
 *
 *  ⚠ THE IN-PROGRESS ITEM CARRIES ONE ON PURPOSE, and this is not decoration:
 *  `describeList` quotes the current item into the machine note (`· now: …`),
 *  so the SAME token appears in text the agent wrote and in text the app
 *  wrote. Without that, §5b's "the note never linkifies" had nothing to
 *  linkify and passed for free — the over-linkifying mutant SURVIVED a full
 *  run before this line was written. */
const REF_GLYPHS = ['☑ read @item:org/slug-identity',
  '◐ write @item:org/desk-refs'].join('\n')

const refWorld = (kinds: string[] = ['item', 'agent']) => ({
  org: 'org',
  agents: new Map([['peer-one', 'peer-one']]),
  handles: new Set(kinds),
} as unknown as Parameters<typeof ProgressView>[0]['refs'] extends undefined
  ? never : NonNullable<Parameters<typeof ProgressView>[0]['refs']>['world'])

test('§5 a reference in a checklist item and in the reported summary is a control that opens it',
async () => {
  const opened: unknown[][] = []
  const refs = {
    world: refWorld(),
    onOpen: (...a: unknown[]) => { opened.push(a) },
  } as unknown as NonNullable<Parameters<typeof ProgressView>[0]['refs']>
  const model = deriveProgress(
    node({ last_status: { status: 'working', summary: 'landing @item:org/sort-selector', at: new Date().toISOString() } }),
    convo({}, [todoMsg(REF_GLYPHS)]))
  const v = await mountView(<ProgressView model={model} refs={refs} />, (el) => el)
  try {
    const chips = [...v.el.querySelectorAll('.ref-chip')]
    assert.equal(chips.length, 3,
      'two checklist items and the summary (found ' + chips.length + ')')
    assert.deepEqual(chips.map((c) => c.textContent),
      ['slug-identity', 'desk-refs', 'sort-selector'])
    // the item text around the reference survives untouched
    assert.equal(v.el.querySelector('.todo-item .todo-text')?.textContent,
      'read slug-identity')
    const { act } = await import('react')
    await act(async () => { (chips[0] as HTMLButtonElement).click() })
    assert.equal(opened.length, 1, 'the chip is a real control')
    assert.equal((opened[0][0] as { ref: { id: string } }).ref.id, 'slug-identity')
  } finally { await v.unmount() }
})

test('§5b CONTROL: with no world the same card is plain text, and the machine-written notes never linkify',
async () => {
  const model = deriveProgress(
    node({ last_status: { status: 'working', summary: 'landing @item:org/sort-selector', at: new Date().toISOString() } }),
    convo({}, [todoMsg(REF_GLYPHS)]))
  const plain = await mountView(<ProgressView model={model} />, (el) => el)
  try {
    assert.equal(plain.el.querySelectorAll('.ref-chip').length, 0,
      'no world ⇒ no judgement, and no control that would do nothing')
    // …and the text is still all there, character for character
    assert.equal(plain.el.querySelector('.todo-item .todo-text')?.textContent,
      'read @item:org/slug-identity')
    assert.equal(plain.el.querySelector('.progress-summary')?.textContent,
      'landing @item:org/sort-selector')
  } finally { await plain.unmount() }
  // the control's control: WITH a world the very same mount does linkify, so
  // the assertions above cannot pass because nothing rendered
  const refs = { world: refWorld(), onOpen: () => {} } as unknown as
    NonNullable<Parameters<typeof ProgressView>[0]['refs']>
  const lit = await mountView(<ProgressView model={model} refs={refs} />, (el) => el)
  try {
    assert.equal(lit.el.querySelectorAll('.ref-chip').length, 3)
    // ⚠ THE ANTI-VACUITY CONTROL FOR THE LINE BELOW: the note really does
    // contain a token, quoted out of the current checklist item, so "no chips
    // in the note" is a decision and not an absence of input.
    const note = lit.el.querySelector('.progress-todo .progress-note')?.textContent ?? ''
    assert.match(note, /@item:org\/desk-refs/,
      'the note quotes the current item, so there IS something here to linkify')
    assert.equal(lit.el.querySelectorAll('.progress-note .ref-chip').length, 0,
      'deriveProgress writes those lines, not the agent — nothing to point at')
  } finally { await lit.unmount() }
})

test('§5c the REAL desk hands its docket card a reference world', async (t) => {
  // ⚠ THIS CHECK CHANGED SURFACE, and the reason is worth reading. It used to
  // open the desk's PROGRESS panel and prove the desk handed that card its
  // references. The user replaced the fifth tab's contents with the agent's
  // own docket (2026-09-05 21:07), so the panel it opened is no longer on the
  // desk at all — and a check whose subject is gone must move to the surface
  // that took its place, not be deleted and not be left red. The claim is the
  // same one: a reference written by an AGENT renders as a live chip on the
  // real desk, and clicking it does what the surface says it does.
  //
  // What is DIFFERENT, deliberately: the docket tab routes an item reference
  // INTERNALLY (it selects the row) rather than through `onWorkLink`, because
  // the tab already holds the item. `onWorkLink` is still passed and must stay
  // untouched — a tab that quietly navigated the whole canvas away would be
  // the surprising behaviour.
  resetConvos()
  useFakeClock()
  const server = new FakeServer()
  installFetch(server)
  const opened: string[] = []
  server.workItems = [
    workRow({ slug: 'sort-selector', title: 'The sort selector' }),
    workRow({ slug: 'desk-refs', title: 'Desk references',
      objective: 'the checklist is dead text; land @item:org/sort-selector' }),
  ]
  const n = node({ id: 'agent' })
  const view = await mountView(
    <DeskChat node={n} map={new Map([['agent', n]])} op={op} slug="org" toast={noop}
      pub={false} bare onJump={noop}
      onWorkLink={(w) => { opened.push(String(w?.slug)) }} />,
    (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  const { act } = await import('react')
  const chip = view.el.querySelector<HTMLButtonElement>('.cc-head-meta .progress-chip')
  assert.ok(chip, 'positive control: the docket chip is there to click')
  await act(async () => { chip!.click() })
  assert.ok(view.el.querySelector('.docket-agent'), 'the docket tab opened')
  const rows = [...view.el.querySelectorAll<HTMLElement>('.docket-agent .mailrow.docket-row')]
  const refs = rows.find((r) => r.querySelector('.l1 .mfrom')?.textContent === 'desk-refs')!
  await act(async () => { refs.click() })
  const refChip = view.el.querySelector<HTMLButtonElement>('.docket-agent .mailer-read .ref-chip')
  assert.ok(refChip, 'the item reference is dead text — the desk did not hand '
    + 'the card its world')
  assert.equal(refChip!.textContent, 'sort-selector')
  await act(async () => { refChip!.click() })
  assert.equal(
    view.el.querySelector('.docket-agent .mailer-read .docket-pane-head b')?.textContent,
    'The sort selector',
    'the reference did not select the item it names')
  assert.deepEqual(opened, [],
    'the tab holds the item — it must not navigate the whole canvas away')
})

/** The docket tab's prose, with one reference of every kind in it. Written
 *  once so §5d and its control read the SAME sentence — a control that
 *  differed in its fixture would not be a control. */
const EVERY_KIND = 'ship @doc:org/d7, tell @mail:org/node/other/m3, '
  + 'ask @agent:org/other, after @item:org/sort-selector'

test('§5d the docket tab reaches the DESK\'S OWN doc, mail and agent handlers',
  async (t) => {
  // ⚠ WHY THIS EXISTS. The tab used to build its own reference world with
  // `handles` = item + agent, on the stated grounds that it "has no document
  // reader and no mailbox". The desk builds routes for both and renders its
  // own message bodies against them, so one desk answered the same `@doc:`
  // token two ways — a live control in the chat above, inert text in the
  // docket below. This pins the fix at the REAL desk: the tab is handed
  // `deskRefs` whole, so every kind reaches the handler the desk already had.
  //
  // The item kind is the one exception and §5c owns it: the tab holds that row,
  // so it selects in place instead of routing out. Asserted here too, because
  // the fix must not have quietly traded it away.
  resetConvos()
  useFakeClock()
  const server = new FakeServer()
  installFetch(server)
  const docs: string[] = []
  const mails: unknown[] = []
  const jumps: string[] = []
  const opened: string[] = []
  server.workItems = [
    workRow({ slug: 'sort-selector', title: 'The sort selector' }),
    workRow({ slug: 'desk-refs', title: 'Desk references', objective: EVERY_KIND }),
  ]
  const me = node({ id: 'agent' })
  const other = node({ id: 'other', tier: 'opus' })
  const view = await mountView(
    <DeskChat node={me} map={new Map([['agent', me], ['other', other]])} op={op}
      slug="org" toast={noop} pub={false} bare
      onJump={(id) => { jumps.push(id) }}
      onOpenDoc={(id) => { docs.push(id) }}
      onMailLink={(m) => { mails.push(m) }}
      onWorkLink={(w) => { opened.push(String(w?.slug)) }} />,
    (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  const { act } = await import('react')
  const chip = view.el.querySelector<HTMLButtonElement>('.cc-head-meta .progress-chip')
  assert.ok(chip, 'positive control: the docket chip is there to click')
  await act(async () => { chip!.click() })
  const rows = [...view.el.querySelectorAll<HTMLElement>('.docket-agent .mailrow.docket-row')]
  const refs = rows.find((r) => r.querySelector('.l1 .mfrom')?.textContent === 'desk-refs')!
  await act(async () => { refs.click() })
  const pane = view.el.querySelector('.docket-agent .mailer-read')!
  const live = (kind: string) =>
    pane.querySelector<HTMLButtonElement>(`button.ref-chip.ref-${kind}.ref-ready`)

  // each kind is a LIVE control, and each one lands on the desk's own handler
  const doc = live('doc')
  assert.ok(doc, 'the document reference is not a control on the docket tab')
  await act(async () => { doc!.click() })
  assert.deepEqual(docs, ['d7'], 'the doc chip did not reach the desk\'s reader')

  const mail = live('mail')
  assert.ok(mail, 'the mail reference is not a control on the docket tab')
  await act(async () => { mail!.click() })
  assert.deepEqual(mails, [{ id: 'm3', to: 'other' }],
    'the mail chip did not reach the desk\'s mail router, or it arrived as a '
    + 'raw token instead of the router\'s own {id,to}')

  const agent = live('agent')
  assert.ok(agent, 'the agent reference is not a control on the docket tab')
  await act(async () => { agent!.click() })
  assert.deepEqual(jumps, ['other'], 'the agent chip did not reach the desk\'s jump')

  // and the item still selects IN PLACE, without routing the canvas away
  const item = live('item')
  assert.ok(item, 'the item reference is not a control on the docket tab')
  await act(async () => { item!.click() })
  assert.equal(
    view.el.querySelector('.docket-agent .mailer-read .docket-pane-head b')?.textContent,
    'The sort selector',
    'the item reference did not select the row the tab already holds')
  assert.deepEqual(opened, [],
    'the tab holds the item — it must not navigate the whole canvas away')
})

test('§5d CONTROL: a desk with no doc or mail route renders those same '
  + 'references inert, and says so', async (t) => {
  // ⚠ THE ANTI-VACUITY HALF. §5d would pass just as well against a tab that
  // declared `handles` = every kind as a literal, which is the defect this
  // codebase keeps naming: a chip advertising an opener that is not wired up.
  // Same desk, same sentence, `onOpenDoc` and `onMailLink` withheld — the two
  // chips must go inert and READ as inert ("not from here"), while the agent
  // and item chips, whose routes are still there, stay live.
  resetConvos()
  useFakeClock()
  const server = new FakeServer()
  installFetch(server)
  server.workItems = [
    workRow({ slug: 'sort-selector', title: 'The sort selector' }),
    workRow({ slug: 'desk-refs', title: 'Desk references', objective: EVERY_KIND }),
  ]
  const me = node({ id: 'agent' })
  const other = node({ id: 'other', tier: 'opus' })
  const view = await mountView(
    <DeskChat node={me} map={new Map([['agent', me], ['other', other]])} op={op}
      slug="org" toast={noop} pub={false} bare onJump={noop}
      onWorkLink={noop} />,
    (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  const { act } = await import('react')
  const chip = view.el.querySelector<HTMLButtonElement>('.cc-head-meta .progress-chip')
  await act(async () => { chip!.click() })
  const rows = [...view.el.querySelectorAll<HTMLElement>('.docket-agent .mailrow.docket-row')]
  const refs = rows.find((r) => r.querySelector('.l1 .mfrom')?.textContent === 'desk-refs')!
  await act(async () => { refs.click() })
  const pane = view.el.querySelector('.docket-agent .mailer-read')!
  for (const kind of ['doc', 'mail']) {
    assert.equal(pane.querySelector(`button.ref-chip.ref-${kind}`), null,
      `the ${kind} chip is a control on a desk that cannot open one`)
    const inert = pane.querySelector(`.ref-chip.ref-${kind}.ref-elsewhere`)
    assert.ok(inert, `the ${kind} reference does not say it is not opened from here`)
  }
  assert.ok(pane.querySelector('button.ref-chip.ref-agent.ref-ready'),
    'the agent route is still wired, so its chip must still be live')
  assert.ok(pane.querySelector('button.ref-chip.ref-item.ref-ready'),
    'the tab holds its own rows, so an item chip must still be live')
})

test('agent docket hides archived rows/count by default and reveals then hides selected detail',
  async (t) => {
    resetConvos()
    useFakeClock()
    const server = new FakeServer()
    installFetch(server)
    server.workItems = [workRow({ slug: 'agent-active', title: 'Active work' })]
    server.workArchived = [workRow({ slug: 'agent-archived', title: 'Archived work',
      archived: true, status: 'done' })]
    const me = node({ id: 'agent' })
    const view = await mountView(
      <DeskChat node={me} map={new Map([['agent', me]])} op={op}
        slug="org" toast={noop} pub={false} bare onJump={noop} />,
      (el) => el)
    t.after(async () => { await view.unmount(); resetConvos(); realClock() })
    await flush()
    const { act } = await import('react')
    const chip = view.el.querySelector<HTMLButtonElement>('.cc-head-meta .progress-chip')!
    assert.equal(chip.textContent?.trim(), 'docket 1')
    await act(async () => { chip.click() })
    assert.equal(view.el.querySelectorAll('.docket-agent .docket-row').length, 1)
    const toggle = view.el.querySelector<HTMLInputElement>('.docket-agent .docket-showarchived input')!
    assert.equal(toggle.checked, false)
    await act(async () => {
      view.el.querySelector<HTMLInputElement>('.docket-agent .docket-showarchived input')!.click()
    })
    assert.equal(view.el.querySelectorAll('.docket-agent .docket-row').length, 2)
    assert.match(view.el.querySelector('.cc-head-meta .progress-chip')?.textContent ?? '', /docket 2/)
    const archived = [...view.el.querySelectorAll<HTMLElement>('.docket-agent .docket-row')]
      .find((r) => r.getAttribute('data-slug') === 'agent-archived')
      ?? [...view.el.querySelectorAll<HTMLElement>('.docket-agent .docket-row')][1]
    assert.ok(archived, 'positive control: archived row rendered')
    await act(async () => { archived.click() })
    assert.match(view.el.querySelector('.docket-agent .mailer-read')?.textContent ?? '',
      /Archived work/)
    await act(async () => {
      view.el.querySelector<HTMLInputElement>('.docket-agent .docket-showarchived input')!.click()
    })
    assert.equal(view.el.querySelectorAll('.docket-agent .docket-row').length, 1)
    assert.match(view.el.querySelector('.docket-agent .mailer-read')?.textContent ?? '',
      /select an item to view it/)
  })

test('Presented desk tab lists the selected agent documents and opens markdown', async (t) => {
  resetConvos()
  useFakeClock()
  const server = new FakeServer()
  installFetch(server)
  const opened: string[] = []
  const n = node({ id: 'agent', documents: [
    { id: 'doc-agent-md', title: 'Agent report', at: '2026-09-05T09:00:00.000Z', format: 'markdown' },
    { id: 'doc-agent-html', title: 'Agent preview', at: '2026-09-05T09:01:00.000Z', format: 'html' },
  ] })
  const view = await mountView(
    <DeskChat node={n} map={new Map([['agent', n]])} op={op} slug="prog" toast={noop}
      pub={false} bare onJump={noop} onOpenDoc={(id) => { opened.push(id) }} />,
    (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); realClock() })
  await flush()
  const { act } = await import('react')
  const tabs = [...view.el.querySelectorAll('.cc-tabs button')].map((b) => b.textContent)
  assert.ok(tabs.includes('presented'), 'desk is missing Presented tab')
  assert.equal(view.el.querySelector('.presented-control'), null,
    'the numbered Presented header control must not duplicate the tab')
  const control = [...view.el.querySelectorAll<HTMLButtonElement>('.cc-tabs button')]
    .find((b) => b.textContent === 'presented')
  assert.ok(control, 'desk lacks the retained unnumbered Presented tab')
  await act(async () => { control!.click() })
  assert.ok(view.el.querySelector('.desk-presented'))
  assert.match(view.el.querySelector('.desk-presented')?.textContent ?? '', /Agent report/)
  assert.match(view.el.querySelector('.desk-presented')?.textContent ?? '', /Agent preview/)
  const html = view.el.querySelector<HTMLElement>('.desk-presented-card.doc-mockup')
  assert.ok(html, 'HTML preview does not use the existing mockup card path')
  assert.ok(view.el.querySelector('.desk-presented .mailer'))
  assert.ok(view.el.querySelector('.desk-presented .mailer-list'))
  assert.ok(view.el.querySelector('.desk-presented .mailer-read'))
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /select a document to read it/)
  const markdown = view.el.querySelector<HTMLElement>('.desk-presented-card')
  assert.ok(markdown, 'markdown document is not actionable')
  await act(async () => { markdown!.click() })
  assert.ok(markdown!.classList.contains('on'))
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /Agent report/)
  await view.render(
    <DeskChat node={node({ id: 'agent', documents: [] })}
      map={new Map([['agent', node({ id: 'agent', documents: [] })]])}
      op={op} slug="prog" toast={noop} pub={false} bare onJump={noop}
      onOpenDoc={(id) => { opened.push(id) }} />)
  await flush()
  await act(async () => {
    const presented = [...view.el.querySelectorAll<HTMLButtonElement>('.cc-tabs button')]
      .find((b) => b.textContent === 'presented')!
    presented.click()
  })
  assert.match(view.el.querySelector('.desk-presented')?.textContent ?? '', /No presented documents/)
})
