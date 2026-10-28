// traystatus.visual.tsx — the fixture for USER 2026-10-28 10:59:43Z m06a44d7adc0c ("this is a problem, the status text
// shouldnt run into multiple rows"): the agents list's (tray) second line, an agent's reported status with a long
// ticket chip in it, as the app's own AgentTray renders it, at the two ends of the tray's width (200 and 280 px). The capture (traystatus.capture.cjs)
// flips the "wrap object mentions" setting (inline fragments instead of inline-flex buttons) and measures each row
// against a row whose status has no chip. Browser-only fixture data: no engine, bridge or live org.
import { createRoot } from 'react-dom/client'
import { useAppFeed } from '../src/appfeed'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { refToken, type RefWorld } from '../src/canvas/reflinks'
import type { CanvasNode } from '../src/canvas/shared'
import type { TypedRef } from '../src/canvas/workrefs'
import { installWrapBackend } from './mentionwrap.fixture'
import '../src/styles.css'
import '../src/shell.css'

const backend = installWrapBackend()
window.fetch = backend.fetcher
window.WebSocket = backend.Socket as unknown as typeof WebSocket

const ref = (kind: string, id: string) => ({ kind, org: 'tray', id }) as TypedRef
const long = '4.5.0 high fixes: migration immutability (0063), upgrade deleting app messages, four rig/test-tool highs'
const labels: Record<string, string> = {
  'item/long': long, 'item/short': 'Dismiss the tutorial', 'item/twin': 'Chip icon centring',
  'doc/notes': 'A presentation describing every step of the initial tutorial recording',
  'app/board': 'An app with a deliberately long name for inline wrapping', 'panel/one': 'unbroken'.repeat(11),
}
const world: RefWorld = {
  org: 'tray',
  items: new Map([['long', labels['item/long']!], ['short', labels['item/short']!], ['twin', labels['item/twin']!]]),
  docs: new Map([['notes', labels['doc/notes']!]]),
  agents: new Map([['dev1', 'dev1']]), tierOf: () => 'opus',
  refName: r => ({ outcome: 'ready', label: labels[`${r.kind}/${r.id}`] ?? r.id,
    flare: r.kind === 'item' ? { cls: 'status-in_progress', tip: 'In progress' } : undefined }),
}
const refs = { world, onOpen: () => {} }

const now = Date.now()
const at = (s: number) => new Date(now - s * 1000).toISOString()
const make = (id: string, summary: string | null) => ({ id, tier: 'opus', state: 'live', children: [], lineage: [], turns: [],
  busy: false, waiting: false, occupancy: null, context_window: null, prev_status: null, halt: null, frozen: null,
  last_status: summary === null ? null : { status: 'working', summary, at: at(240) } } as unknown as CanvasNode)

/** `row` is the row's name in the capture; `control` carries no chip and is the one-line reference. */
const rows: [string, string | null][] = [
  ['control', 'Working through the long list of fixes that the release needs before it can go out, one by one'],
  ['item-long', `On ${refToken(ref('item', 'long'))}: six highs (D3, D14, E15-E18) on rigs`],
  ['item-short', `On ${refToken(ref('item', 'short'))} now`],
  ['two-items', `${refToken(ref('item', 'long'))} then ${refToken(ref('item', 'twin'))} and the rest`],
  ['doc', `Reading ${refToken(ref('doc', 'notes'))} before replying`],
  ['app', `Editing ${refToken(ref('app', 'board'))} for the release`],
  ['panel', `Using ${refToken(ref('panel', 'one'))} to check the layout`],
  ['agent', 'Waiting on @dev1 for the answer to the review question that blocks the merge'],
  ['none', null],
]

function Section({ width }: { width: number }) {
  const nodes = rows.map(([id, summary]) => make(id, summary))
  const map = new Map(nodes.map(n => [n.id, n]))
  return <section className="tray-section" data-width={width} style={{ margin: '0 0 0 12px' }}>
    {/* the canvas tray is 200 to 280 px wide (.tray min-width / max-width) and as wide as its widest line; the width is set on the tray itself */}
    <div className="tray-wrap" style={{ position: 'static', display: 'block', height: 'auto' }}>
      <AgentTray map={map} rows={trayRows(map)} query="" onQuery={() => {}} archived={false} onArchived={() => {}}
        onPick={() => {}} refs={refs} listProps={{ style: { width } }} />
    </div>
  </section>
}

/** The shell keeps the app feed open, and the feed is what sets the wrap-object-mentions class on the page. */
function Feed() { useAppFeed(); return null }

Object.assign(window, { trayFixture: { wrap: (on: boolean) => backend.emit(on) } })
createRoot(document.getElementById('root')!).render(
  <div id="stage" style={{ display: 'flex', alignItems: 'flex-start', padding: '8px 0' }}><Feed /><Section width={200} /><Section width={280} /></div>)
