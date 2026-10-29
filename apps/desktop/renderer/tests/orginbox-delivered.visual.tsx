// tests/orginbox-delivered.visual.tsx — what orginbox-delivered.capture.cjs draws for "the detail of
// a mail in the org inbox lists every agent it was delivered to" (USER 2026-10-29 ma660da825904):
// the real org inbox window over synthetic mail. A received mail delivered to two live agents, a
// retired one and one since removed; a received mail with no delivery record; nine recipients (the
// wrap); and the outbox's own "@agent as @org -> @recipient" line beside them. No engine, no real
// hub, no clipboard: everything is synthetic.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { OrgInboxModal } from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import type { OrgInboxEntry } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

setHubchatInstalled(true)
const WHEN = '2026-10-29T12:00:00Z'
const mail = (id: string, extra: Partial<OrgInboxEntry> & Record<string, unknown>): OrgInboxEntry =>
  ({ id, dir: 'in', peer: '@net:alice.fixture', at: WHEN, body: 'Hello org, a short outside message.', ...extra }) as OrgInboxEntry
const ENTRIES: OrgInboxEntry[] = [
  mail('in-many', { body: 'A message delivered to every agent that held the org inbox.',
    delivered_to: ['coordinator-opus', 'liaison-opus', 'rig-sol-b', 'build-sol', 'app-net-opus', 'desk-parity-opus', 'old-reviewer', 'old-builder', 'gone-agent'] }),
  mail('in-none', { body: 'An older message: no delivery record was kept for it.' }),
  mail('in-some', { body: 'Hello org, two agents got this one, a third has since been retired and a fourth removed.',
    delivered_to: ['coordinator-opus', 'liaison-opus', 'old-reviewer', 'gone-agent'] }),
  { id: 'out-1', dir: 'out', peer: '@net:peer.fixture', by: 'coordinator-opus', at: WHEN, state: 'read',
    body: 'Project update: the requested changes are ready for the next alpha.' } as OrgInboxEntry,
]
window.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/org_inbox')
  ? { entries: ENTRIES, total: ENTRIES.length, unread: 0 } : String(url).endsWith('/phone') ? { hubchat_pc: true } : { transfers: [] }))

const live = (id: string, tier: string) => [id, { id, tier, state: 'live' } as CanvasNode] as const
const MAP = new Map<string, CanvasNode>([
  live('coordinator-opus', 'opus'), live('liaison-opus', 'opus'), live('rig-sol-b', 'sol'), live('build-sol', 'sol'),
  live('app-net-opus', 'opus'), live('desk-parity-opus', 'opus'),
  ['old-reviewer', { id: 'old-reviewer', tier: 'sonnet', state: 'archived' } as CanvasNode],
  ['old-builder', { id: 'old-builder', tier: 'opus', state: 'archived' } as CanvasNode],
])

function Fixture({ jumpTo }: { jumpTo: string }) {
  useProvideAgentNav((id) => [{ label: `Desk of ${id}`, action: () => {} }], (id) => ({ title: `Agent ${id}` }))
  return <OrgInboxModal slug="fixture" inbox={{ entries: ENTRIES, total: ENTRIES.length, unread: 0, visible: true, holders: [] }}
    map={MAP} onFocusAgent={() => {}} toast={() => {}} close={() => {}} jumpTo={jumpTo} />
}

const root = createRoot(document.getElementById('root')!)
type Surface = 'some' | 'many' | 'none' | 'sent'
const TARGET: Record<Surface, string> = { some: 'in-some', many: 'in-many', none: 'in-none', sent: 'out-1' }
let seq = 0
Object.assign(window, { deliveredFixture: {
  show: (surface: Surface, theme: 'dark' | 'light') => {
    localStorage.setItem('orgtree-contrast-theme', theme === 'light' ? 'light' : 'charcoal')
    document.documentElement.classList.toggle('contrast-light', theme === 'light')
    root.render(<CurrentOrg.Provider value="fixture"><AgentNavProvider><Fixture key={surface + theme + ++seq} jumpTo={TARGET[surface]} /></AgentNavProvider></CurrentOrg.Provider>)
  },
} })
