// projectwatchdogs.visual.tsx — captures for project watchdogs
// (docket project-watchdogs-a-watchdog-owned-by-a-project-f; spec rev 1.3 B1-B3).
// Real ProjectDesk (the members row carries the project's dog cards), real ListenersView (Event sources,
// the >8 group card, Recently Fired source links). Browser-only data: no engine, bridge, network or clipboard.
// API:  window.pwdVisual.contrast(light: boolean)   light or charcoal
// Scenes (fixed ids): [data-fixture="few"] a project desk with three dogs; [data-fixture="many"] a project desk
// with eleven dogs (group card); [data-fixture="listeners"] the Listeners tab body with two sources and four fires.
import { createRoot } from 'react-dom/client'
import { ListenersView } from '../src/canvas/listenersdesk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { CurrentOrg } from '../src/popout'
import type { CanvasNode, OpFn, OpResult } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'
import '../src/styles.css'

// no network, no clipboard
const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
;(window as unknown as { WebSocket: unknown }).WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
window.fetch = (async () => new Response(JSON.stringify({ items: [], pending: [], delivered: [], sent: [], messages: [], live: [] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

const noop = () => {}
const node = (id: string, extra: Record<string, unknown> = {}): CanvasNode => ({
  id, title: id, tier: 'haiku', state: 'live', model_id: '', seat: 1, grant: 0, free: 0, children: [], generation: 0, busy: false,
  scope: { tools: {}, add_dirs: [] }, turns: [], audiences_held: [], documents: [], ...extra } as unknown as CanvasNode)
const member = node('member'), other = node('other')
const stream = node('stream', { tier: 'project', kind: 'project', parent: 'boss', title: 'stream', children: [member, other],
  configured_scope: { tools: {}, add_dirs: [], event_listeners: true }, charter: '# The stream\n\nWatch the chat.', lineage: [],
  mail_pending: 0, mail_held: 0, dead_letters: 0, documents_count: 0 })
const boss = node('boss', { tier: 'opus', children: [stream] })
const map = new Map<string, CanvasNode>([['boss', boss], ['stream', stream], ['member', member], ['other', other]])

const feed = (name: string, extra: Partial<Watchdog> = {}): Watchdog => ({
  id: 'stream/' + name, owner: 'stream', name, kind: 'websocket', target: 'ws://127.0.0.1:8787/v1/events',
  interval_s: 5, state: 'armed', at: '2026-11-03T10:00:00Z', fired: 3, once: false, spent: false,
  owner_kind: 'project', created_by: 'member', ...extra } as Watchdog)
const few = [feed('stream-chat'), feed('stream-control', { created_by: 'user' }), feed('donations', { kind: 'file', target: 'donations.log' })]
const many = Array.from({ length: 8 }, (_, i) => feed('src-' + i))
const sources = few.slice(0, 2).map((d, i) => i ? { ...d, state: 'paused',
  paused_why: "project stream's event listeners were turned off by boss" } as Watchdog : d)
const op: OpFn = (async () => ({}) as OpResult)
const treeOf = (dogs: Watchdog[], counts?: Record<string, unknown>) => ({ slug: 'org', name: 'Fixture', epoch: 1, rev: 1, roots: [boss],
  watchdogs: dogs, watchdog_counts: counts, slot_leases: [], work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0,
  user_inbox_urgent_count: 0, asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload)
const refs = { world: { org: 'org' }, onOpen: noop } as never
const counts = { stream: { total: 11, kept: 11, one_shot: 0 } }

const history = [
  { id: 4, at: '2026-11-03T10:07:00Z', kind: 'event', by: 'stream/stream-chat', message: 'chat message', listeners: [],
    source: { kind: 'watchdog', handle: 'stream/stream-chat', dog: 'stream-chat', name: 'stream-chat', dog_kind: 'websocket', gone: false } },
  { id: 3, at: '2026-11-03T10:06:00Z', kind: 'event', by: 'stream/older-feed', message: 'beyond the tree preview', listeners: [],
    source: { kind: 'watchdog', handle: 'stream/older-feed', dog: 'older-feed', name: 'older-feed', dog_kind: 'command', gone: false } },
  { id: 2, at: '2026-11-03T10:05:00Z', kind: 'event', by: 'stream/gone-dog', message: 'text from a removed dog', message_truncated: true, listeners: [],
    source: { kind: 'watchdog', handle: 'stream/gone-dog', dog: 'gone-dog', name: 'gone-dog', dog_kind: 'command', gone: true } },
  { id: 1, at: '2026-11-03T10:00:00Z', kind: 'event', by: 'boss', message: 'a manual fire', listeners: [] },
]
const listenerOp: OpFn = (async (req: { op: string }) => (req.op === 'listener_history' ? { history, history_next: null } : {}) as OpResult)

function Scenes() {
  return <CurrentOrg.Provider value="org">
    <div style={{ display: 'flex', gap: 10, padding: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div data-fixture="few" style={{ width: 520, height: 600, display: 'flex', flexDirection: 'column' }}>
        <DeskDogsProvider value={{ org: 'org', dogs: few, open: noop }}>
          <ProjectDesk node={stream} slug="org" tree={treeOf(few)} map={map} op={op} toast={noop} refs={refs} bare onJump={noop} onOpenDoc={noop} />
        </DeskDogsProvider>
      </div>
      <div data-fixture="many" style={{ width: 520, height: 600, display: 'flex', flexDirection: 'column' }}>
        <DeskDogsProvider value={{ org: 'org', dogs: many, counts, open: noop }}>
          <ProjectDesk node={stream} slug="org" tree={treeOf(many, counts)} map={map} op={op} toast={noop} refs={refs} bare
            onJump={noop} onOpenDoc={noop} />
        </DeskDogsProvider>
      </div>
      <div data-fixture="listeners" style={{ width: 760, padding: 8 }}>
        <DeskDogsProvider value={{ org: 'org', dogs: sources, open: noop }}>
          <ListenersView node={stream} dogs={sources} map={map} op={listenerOp} toast={noop} />
        </DeskDogsProvider>
      </div>
    </div>
  </CurrentOrg.Provider>
}
Object.assign(window, { pwdVisual: { contrast: (light: boolean) => {
  document.documentElement.classList.toggle('contrast-light', light)
  document.documentElement.classList.toggle('contrast-charcoal', !light)
} } })
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Scenes />)
