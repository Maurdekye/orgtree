// tests/agefmt.visual.tsx — what agefmt.capture.cjs draws for "every age in
// Orgtree uses one scale" (USER 2026-10-29 m1baa42b32cb6): the agents tray (a
// status age written days ago, an idle turn, a halt of weeks, a turn running for
// days), a retired pile's rows, and the card badge, the map clock and the desk
// header's status seat for the same turns. No engine: everything is synthetic,
// with times relative to now. The same file draws the base (before, ago(): hours
// without end) and the tip (after, fmtAge: days and weeks), so it imports only
// what both have.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { AgentTray } from '../src/canvas/agenttray'
import { PilePicker } from '../src/canvas/modals'
import { AgentWorkstate, LastTurnAge, MapTurnAge, TurnStatusBanner } from '../src/canvas/desk'
import type { Pile } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const turn = (ms: number, killed = false) => ({ at: ago(ms), killed, cost: 0, denials: 0 })

const node = (id: string, extra: Record<string, unknown> = {}): CanvasNode => ({
  id, tier: 'sonnet', state: 'live', children: [], lineage: [], turns: [], halt: null, frozen: null, busy: false, waiting: false,
  occupancy: null, context_window: null, last_status: null, prev_status: null, ...extra } as unknown as CanvasNode)

// the tray: the same four kinds of row at every age
const TRAY: CanvasNode[] = [
  node('idle-three-days', { turns: [turn(3 * DAY)], last_status: { status: 'done', summary: 'Wrote the release notes', at: ago(3 * DAY) } }),
  node('halted-three-weeks', { halt: { phase: 'halted', requested_at: ago(21 * DAY), at: ago(20 * DAY), by: 'user' },
    last_status: { status: 'idle', summary: 'Waiting for the new base', at: ago(20 * DAY) } }),
  node('running-two-days', { busy: true, inflight_at: ago(2 * DAY), turns: [turn(5 * DAY)],
    last_status: { status: 'working', summary: 'Rebuilding the index', at: ago(40 * MIN) } }),
  node('idle-minutes', { turns: [turn(12 * MIN)], last_status: { status: 'done', summary: 'Answered the review', at: ago(12 * MIN) } }),
]

// a retired pile whose members last ran minutes, a day, three days and three weeks ago
const retired = (id: string, ms: number, killed = false): CanvasNode =>
  ({ id, state: 'archived', tier: 'opus', children: [], turns: [turn(ms, killed)] }) as unknown as CanvasNode
const PILE_NODES = [retired('reviewer-one', 10 * MIN), retired('builder-two', 26 * HOUR), retired('tester-three', 3 * DAY, true),
  retired('scribe-four', 21 * DAY)]
const PILE: Pile = { key: 'lead|a', parent: 'lead', kind: 'a', list: PILE_NODES.map((n) => n.id), front: 'reviewer-one' }

const noop = () => {}
const Row = ({ label, children }: { label: string; children: React.ReactNode }) =>
  <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
    <div style={{ width: 230, color: 'var(--dim)', fontSize: 12 }}>{label}</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{children}</div>
  </div>

/** The same turns on the card badge, the map clock, the zoom card and the desk header's status seat. */
function Clocks() {
  const idle = turn(3 * DAY, true), halt = { phase: 'halted' as const, requested_at: ago(21 * DAY), at: ago(20 * DAY), by: 'user' }
  const running = node('running', { busy: true, inflight_at: ago(2 * DAY) })
  return <div style={{ width: 760, background: 'var(--panel)', color: 'var(--ink)', font: '13px system-ui' }}>
    <Row label="card badge, last turn 3 days ago"><LastTurnAge turn={idle} /></Row>
    <Row label="map clock, idle 3 days"><MapTurnAge node={node('m')} turn={idle} /></Row>
    <Row label="map clock, running 2 days"><MapTurnAge node={running} turn={idle} /></Row>
    <Row label="zoom card, idle 3 days"><AgentWorkstate node={node('z')} turn={idle} /></Row>
    <Row label="zoom card, halted 3 weeks"><AgentWorkstate node={node('h', { halt })} turn={idle} /></Row>
    <Row label="zoom card, running 2 days"><AgentWorkstate node={running} turn={idle} /></Row>
    <Row label="desk header, idle 3 days"><TurnStatusBanner state="idle" turn={idle} /></Row>
    <Row label="desk header, halted 3 weeks"><TurnStatusBanner state="idle" turn={idle} halted haltedAt={halt.at} /></Row>
    <Row label="desk header, running 2 days"><TurnStatusBanner state="working" inflightAt={running.inflight_at} /></Row>
  </div>
}

const root = createRoot(document.getElementById('root')!)
type Surface = 'tray' | 'pile' | 'clocks'
let seq = 0
Object.assign(window, { ageFixture: {
  show: (surface: Surface, theme: 'dark' | 'light') => {
    localStorage.setItem('orgtree-contrast-theme', theme === 'light' ? 'light' : 'charcoal')
    document.documentElement.classList.toggle('contrast-light', theme === 'light')
    const key = surface + theme + ++seq
    root.render(surface === 'tray'
      ? <div key={key} style={{ position: 'relative', width: 560, height: 520 }}>
          <AgentTray map={new Map(TRAY.map((n) => [n.id, n]))} rows={TRAY.map((n) => ({ node: n, depth: 0 }))}
            query="" onQuery={noop} archived={false} onArchived={noop} onPick={noop} /></div>
      : surface === 'pile'
        ? <PilePicker key={key} pile={PILE} map={new Map(PILE_NODES.map((n) => [n.id, n]))} onPick={noop} close={noop} />
        : <Clocks key={key} />)
  },
} })
