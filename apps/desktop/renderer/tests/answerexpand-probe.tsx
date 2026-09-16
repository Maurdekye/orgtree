// answerexpand-probe.tsx — THE CRASH, IN A REAL BROWSER.
//
// USER CRASH 2026-09-15 21:08Z: the operator expanded a question answer on
// mail-hub's desk and the whole desk panel died instantly. Two crash reports,
// eight seconds apart, both React #185 ("Maximum update depth exceeded"), both
// with the click on the answer as the last breadcrumb.
//
// ⚠ THIS CANNOT BE WRITTEN AS A JSDOM TEST, and that is a fact about React
// rather than about the desk. The defect is that a no-op `setState` is still
// DISPATCHED while the fiber has work pending — React's eager-state bailout is
// refused there — so an effect with no dependency list re-runs itself on state
// that never moves. Under `act()` the bailout is not refused, so the same
// component settles in three renders and a jsdom "control" would pass before
// the fix as happily as after it. Measured, both idioms, before concluding it.
// The contract of the guard itself is pinned in `changedstate.test.tsx`; THIS
// is what holds the crash.
//
// THE THREE INGREDIENTS, all of them the user's own conditions:
//   1. the answer card FOLDED, expanded with ONE click (they confirmed it was
//      closed and the page died on the first click, with no flicker);
//   2. the agent MID-TURN — busy, responding, a live tail growing and a poll
//      landing every few hundred ms (they confirmed "it was working", and the
//      store agrees: mail-hub's rows are 21:01:34, a steer at 21:03:07, then
//      nothing until 21:09:07, with the crashes at 21:08:06 and 21:08:14);
//   3. the reader at the TAIL, not scrolled up ("i didnt have to scroll up").
//
// ⚠ AND THE FIXTURE RESPECTS THE WINDOW. A stub that answers every `last=N`
// with the same rows makes `fillViewport` ask for history forever by
// construction — a loop in the fixture, not in the desk, and it is exactly
// what this probe reported on its first run. The real endpoint returns the
// NEWEST `last` rows and says whether older ones exist, so this does too.
//
// The mail is SYNTHETIC with the real envelope shape (an `answer.batch` event
// carrying one ask section): the defect is in the desk's render loop, not in
// anybody's words, and a fixture does not need to carry a real mailbox.
//
// ISOLATION: run through tools/run-probe.mjs, which spawns Electron with
// ORGTREE_DATA and HOME inside a temp root and moves Electron's own state
// there with `app.setPath`. `fetch` is stubbed, so no server is contacted and
// the live data root is never opened.
//
// Run:  node tools/run-probe.mjs apps/desktop/renderer/tests/answerexpand-probe.tsx .probe
// Reads: result.json — `errors` must be empty and `answerFoldedAfter` false.
import { createRoot } from 'react-dom/client'
import { Component } from 'react'
import type { ReactNode } from 'react'
import { DeskChat } from '../src/canvas/desk'
import { DeskHosts } from '../src/canvas/deskhosts'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo } from '../src/convo'
import { getChat } from '../src/api'
import '../src/styles.css'

declare global { interface Window { PROBE: Record<string, unknown> } }
window.PROBE = { errors: [] as unknown[], steps: [] as string[] }
const errs = window.PROBE.errors as unknown[]
const steps = window.PROBE.steps as string[]
/** THE BEACON. A title change is PUSHED to the main process, so the last stage
 *  reached is still readable after a render loop wedges this thread — which is
 *  the only moment it matters. `executeJavaScript` is not: it needs the very
 *  thread that is spinning. */
const phase = (p: string) => { document.title = p; (window.PROBE as { phase?: string }).phase = p }
phase('module')

const ASK_ID = 'q9a1b85ef'
const ANSWER_ID = 'c585e4f21fc4'
const LABEL = 'Hub history'
const QUESTION = 'Mail-hub replacement: what should happen to the existing hub '
  + 'message history at migration? The canonical hub sweeps everything older than '
  + 'its retention default hourly, regardless of delivered or read state, which was '
  + 'its design for a relay queue. The hub in service kept history forever and the '
  + 'store has months of it. Migrating the full history under the canonical default '
  + 'would delete everything older than the retention window within the first hour.'
const ANSWER = 'Keep-forever for integrated hub'

/** a received mail row in the shape the transcript carries one */
const mailRow = (id: string, from: string, kind: string, body: string, at: string,
  ev?: unknown) => ({ id, from, kind, body, at, message_id: id,
    operation_id: 'mail:' + id, relationship: from === '@user' ? 'USER' : 'your superior',
    ...(ev ? { ev } : {}) })

const answer = mailRow(ANSWER_ID, '@user', 'message',
  '[ANSWERS to your questions]\n' + LABEL + ' — ' + QUESTION + '\n→ ' + ANSWER,
  '2026-09-15T21:01:34.739Z',
  { v: 1, variant: 'answer.batch', actor: { kind: 'user', id: '@user' },
    object: { kind: 'batch', org: 'orgtree', id: ASK_ID, node: 'mail-hub' },
    engine_authored: false,
    sections: [{ kind: 'ask', ask_id: ASK_ID,
      questions: [{ label: LABEL, question: QUESTION, answer: ANSWER }] }] })

const kickoff = mailRow('96e694bc7cf9', 'coordinator-opus', 'request',
  'Start on the hub extraction. Read the work item first, then the reference '
  + 'implementation, and report what the two stores actually differ on.',
  '2026-09-15T19:54:00.329Z')
const notice = mailRow('9c1abdc05c2e', 'coordinator-opus', 'notice',
  'The destination repository exists, so the initial push is yours to shape.',
  '2026-09-15T19:55:15.952Z')

/** the resolved ask, as node.ask carries it once answered */
const ask = {
  id: ASK_ID, node: 'mail-hub', kind: 'question', status: 'answered',
  at: '2026-09-15T20:58:00.000Z', resolved_at: '2026-09-15T21:01:34.739Z',
  answer_mail: ANSWER_ID, header: LABEL, question: QUESTION,
  options: [{ label: ANSWER }, { label: 'Adopt the 30-day sweep' },
    { label: 'Migrate recent only' }, { label: 'Ask me again at migration' }],
  answer: { selected: [ANSWER] },
}

const turns: unknown[] = []
let seq = 1
const assistantTurn = (text: string) => {
  turns.push({ role: 'assistant', seq: seq++, event_id: 'ev-a' + seq,
    ts: '2026-09-15T20:0' + (seq % 10) + ':00.000Z', text })
}
const mailTurn = (rows: unknown[], at: string) => {
  turns.push({ role: 'user', seq: seq++, event_id: 'ev-m' + seq,
    ts: at, segments: [{ kind: 'mail', rows }] })
}

mailTurn([kickoff], kickoff.at)
assistantTurn('Starting on the hub extraction. '
  + 'Reading the reference and the current implementation first. '.repeat(6))
mailTurn([notice], notice.at)
assistantTurn('Understood — the repository exists, so the initial push is mine to shape. '
  + 'Characterising both hubs before any change. '.repeat(6))
// …and THE ANSWER IS THE LAST SETTLED ROW. The reader did not have to scroll to
// reach it, and the turn it started was still running: what sits below it on
// screen is the LIVE tail, not more transcript.
mailTurn([answer], answer.at)

/** THE LIVE TAIL, and it GROWS — ingredient 2. */
let tick = 0
const liveRows = () => {
  const words = 'characterising the hub, its persistence layer and its sweep timer. '
  return [
    { kind: 'think', event_id: 'live-think-1', secs: 12 + tick,
      text: 'Working out what the keep-forever ruling means for migration. ' + words.repeat(2) },
    { kind: 'tool', event_id: 'live-tool-1', id: 'toolu_live_1', n: 1,
      text: 'Read apps/hub/store.py' },
    { kind: 'text', event_id: 'live-text-1', n: 2,
      text: 'Keeping history forever, then. ' + words.repeat(1 + (tick % 9)) },
  ]
}

/** a deep history behind the visible tail, paged the way the server pages it */
const FILLER = 60
const HISTORY: { seq: number; row: unknown }[] = []
for (let i = 0; i < FILLER; i++) {
  HISTORY.push({ seq: i - FILLER, row: { role: 'assistant', seq: i - FILLER,
    event_id: 'ev-old' + i, ts: '2026-09-15T19:0' + (i % 10) + ':00.000Z',
    text: 'Earlier turn ' + i + '. '
      + 'reading the reference implementation and its sweep timer. '.repeat(8) } })
}
turns.forEach((row, i) => HISTORY.push({ seq: i, row }))

const windowOf = (last: number) => {
  const n = Math.max(1, Math.min(HISTORY.length, Math.ceil(last)))
  const slice = HISTORY.slice(HISTORY.length - n)
  return { messages: slice.map((h) => h.row), has_older: slice.length < HISTORY.length,
    before: slice.length < HISTORY.length ? String(slice[0]!.seq) : null }
}
const beforeOf = (cursor: number, last: number) => {
  const end = HISTORY.findIndex((h) => h.seq >= cursor)
  const hi = end < 0 ? HISTORY.length : end
  const lo = Math.max(0, hi - Math.max(1, Math.ceil(last)))
  const slice = HISTORY.slice(lo, hi)
  return { messages: slice.map((h) => h.row), has_older: lo > 0,
    before: lo > 0 ? String(HISTORY[lo]!.seq) : null }
}

const payload = (last: number, before?: string | null) => {
  const w = before ? beforeOf(Number(before), last) : windowOf(last)
  return { busy: true, queued: 0, responding: true, last_error: null, occupancy: 1000,
    messages: w.messages, live: before ? [] : liveRows(), draft_epoch: 'boot0:0',
    windowed: true, has_older: w.has_older, before: w.before,
    mail_pending: 0, pending_mail: [] }
}

/** every /chat request answered — the record that says whether the desk asked
 *  once or asked forever */
const asked: { last: number; before: string | null }[] = []

window.fetch = ((url: string) => {
  const u = new URL(String(url), location.href)
  let body: unknown = { ok: true }
  if (/\/chat$/.test(u.pathname)) {
    const last = Number(u.searchParams.get('last') ?? 300)
    const before = u.searchParams.get('before')
    asked.push({ last, before })
    body = payload(last, before)
  } else if (/\/history$/.test(u.pathname)) body = { items: [] }
  else if (/\/work-items$/.test(u.pathname)) {
    body = { items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 },
      now: new Date().toISOString() }
  } else if (/\/documents$/.test(u.pathname)) body = { documents: [], total: 0, next_offset: null }
  else if (/\/scratch$/.test(u.pathname)) body = { path: '', entries: [] }
  return Promise.resolve({ ok: true, status: 200,
    headers: new Headers({ 'X-Orgtree-Instance': 'probe' }),
    json: () => Promise.resolve(body) } as unknown as Response)
}) as typeof window.fetch

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    errs.push({ message: error.message, componentStack: (info.componentStack ?? '').slice(0, 1400) })
  }
  render() { return this.state.error ? null : this.props.children }
}

const hub: CanvasNode = { id: 'mail-hub', generation: 2, state: 'live', tier: 'opus',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  ask } as unknown as CanvasNode
const boss: CanvasNode = { id: 'coordinator-opus', generation: 0, state: 'live', tier: 'opus',
  children: ['mail-hub'], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const MAP = new Map<string, CanvasNode>([[hub.id, hub], [boss.id, boss]])

const host = document.getElementById('root')!
host.style.cssText = 'width:560px;height:620px;display:flex;'
createRoot(host).render(
  <Boundary>
    <DeskHosts map={MAP} slug="orgtree">
      <DeskChat node={hub} map={MAP} slug="orgtree" op={async () => ({})}
        toast={() => {}} pub={false}
        onRecenter={() => steps.push('recenter')} />
    </DeskHosts>
  </Boundary>)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  window.addEventListener('error', (e) => errs.push({ window: String(e.message),
    stack: String((e as ErrorEvent).error?.stack ?? '').split(String.fromCharCode(10))
      .slice(0, 12).map((x) => x.trim().replace(/file:[^)]*\//, '')).join(' ~ ') }))
  window.addEventListener('unhandledrejection',
    (e) => errs.push({ rejection: String((e as PromiseRejectionEvent).reason) }))
  phase('boot')
  await sleep(400)
  phase('getChat')
  try { await getChat('orgtree', 'mail-hub', 40) } catch (e) { errs.push({ getChat: String(e) }) }
  phase('refresh')
  try { await refreshConvo('orgtree', 'mail-hub', { force: true }) } catch (e) { errs.push({ refresh: String(e) }) }
  // THE TURN KEEPS RUNNING while the reader reads, and the poll keeps landing.
  phase('streaming')
  const poll = setInterval(() => {
    tick++
    void refreshConvo('orgtree', 'mail-hub', { force: true }).catch(() => {})
  }, 220)
  await sleep(1600)

  phase('measure')
  window.PROBE.askedBeforeClick = asked.length
  window.PROBE.cards = document.querySelectorAll('.turn-mail').length
  const findP = () => [...document.querySelectorAll('p')]
    .find((x) => (x.textContent ?? '').trim() === LABEL) as HTMLElement | undefined
  const p = findP()
  window.PROBE.foundP = Boolean(p)
  const card = p?.closest('.turn-mail') as HTMLElement | null
  // ANTI-VACUITY: the card must actually be FOLDED before the click, or the
  // probe would be clicking something that had nothing to expand.
  window.PROBE.answerFoldedBefore = !!card?.querySelector('.turn-mail-preview.folded')
  const scroller = document.querySelector('.msgs') as HTMLElement | null
  window.PROBE.scroll = scroller
    ? { h: scroller.clientHeight, sh: scroller.scrollHeight, top: Math.round(scroller.scrollTop) } : null
  phase('clicking')
  steps.push('clicking')
  if (p) p.click()
  phase('clicked')
  await sleep(2500)
  phase('settled')
  window.PROBE.askedAfterClick = asked.length
  // …and the answer must be EXPANDED and STILL ON SCREEN. A desk that stopped
  // throwing by not rendering the answer would not be a fix.
  window.PROBE.answerFoldedAfter =
    !!findP()?.closest('.turn-mail')?.querySelector('.turn-mail-preview.folded')
  window.PROBE.stillThere = Boolean(findP())
  window.PROBE.answerTextShown = (findP()?.closest('.turn-mail')?.textContent ?? '').includes(ANSWER)
  clearInterval(poll)
  window.PROBE.done = true
})()
