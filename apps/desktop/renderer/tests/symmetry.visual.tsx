// tests/symmetry.visual.tsx — what symmetry.capture.cjs draws for the UX
// symmetry fixes (USER 2026-10-29 m019c9500d23a): Org settings → Connections
// (#2 the chip's avatar, #5 the grey offline ring), the org inbox's sent folder
// with a queued message open (#6 the clock, #23 the named marks, #7 the ages
// and the header's full time), Presentations and an agent's docket with one
// item open (#7). No engine: every read is answered here from synthetic data,
// with times relative to now. The same file draws the base (before) and the
// tip (after), so it imports only what both have.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { ConnectionsPanel } from '../src/canvas/connections'
import { OrgInboxModal } from '../src/canvas/mail'
import { DocGalleryModal } from '../src/canvas/gallery'
import { AgentDocketView } from '../src/canvas/docket'
import { PinFrame } from '../src/canvas/modalpin'
import { instanceKind } from '../src/modalkinds'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { setNetRoster } from '../src/canvas/netmentions'
import type { DocRow } from '../src/api'
import type { NetBlock, NetPeer, OrgInboxEntry, TreePayload, WorkItem } from '../src/types'

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const OWN = 'orgtree.syn.0fff'
const CONTACTS: [string, NetPeer['kind'], boolean, string][] = [
  ['Acme Labs', 'org', true, 'acme-labs.syn.1001'], ['Maurdekye', 'person', true, 'maurdekye.syn.1002'],
  ['claude-code', 'chat', true, 'claude-code.syn.1003'], ['Unity', 'org', true, 'unity.syn.1004'],
  ['Penelope', 'chat', false, 'penelope.syn.1005'], ['Resonite', 'org', false, 'resonite.syn.1006'],
  ['neoja', 'person', false, 'neoja.syn.1007'], ['orgtree-rustengine', 'chat', false, 'orgtree-rustengine.syn.1008'],
]
const ROSTER: NetPeer[] = CONTACTS.map(([name, kind, online, slug]) => ({
  slug, kind, online, blurb: kind === 'chat' ? 'independent Claude Code chat' : '',
  ...(kind === 'org' ? { org_name: name } : { username: name }),
}))
const NET: NetBlock = {
  slug: OWN,
  hubs: [{ id: 'local', address: 'http://127.0.0.1:7370', name: 'maurdekye-net', version: '2.2.0', enabled: true,
    connected: true, queued: 0, roster: ROSTER }],
}
const RECENT: Record<string, string> = { [ROSTER[0]!.slug]: ago(10 * MIN), [ROSTER[5]!.slug]: ago(3 * DAY) }
const STRANGER = '@net:stranger.unlisted.9999'
const to = (i: number) => '@net:' + ROSTER[i]!.slug
const out = (id: string, peer: string, at: number, state: OrgInboxEntry['state'], body: string, extra: Partial<OrgInboxEntry> = {}): OrgInboxEntry =>
  ({ id, dir: 'out', peer, body, at: ago(at), by: 'coordinator', net_id: 'n-' + id, state, state_at: ago(at), ...extra })
const ENTRIES: OrgInboxEntry[] = [
  { id: 'e-in', dir: 'in', peer: to(0), body: 'The release window works for us.', at: ago(10 * MIN) },
  out('e-q', to(0), 2 * MIN, 'queued', 'Can you confirm the release window?'),
  out('e-s', to(1), 3 * HOUR, 'sent', 'Here is the build for your phone.'),
  out('e-d', to(5), 3 * DAY, 'delivered', 'The world file is attached.'),
  out('e-r', to(3), 3 * 7 * DAY, 'read', 'Thanks for the package update.'),
  out('e-x', STRANGER, 120 * DAY, 'queued', 'Are you still on this address?',
    { tries: 4, last_err: 'hub unreachable — connection failing; retrying' }),
]
const TREE = { slug: 'fixture', net: NET,
  org_inbox: { entries: ENTRIES, total: ENTRIES.length, unread: 0, holders: ['coordinator'], visible: true, multi_holder_enabled: false },
} as unknown as TreePayload

const DOCS = ([[5 * MIN, 'Release notes draft'], [5 * HOUR, 'Connections rows mockup'], [9 * DAY, 'Docket paging plan'],
  [60 * DAY, 'Hub hosting overview'], [400 * DAY, 'The first presentation']] as [number, string][])
  .map(([at, title], i) => ({ id: 'doc-' + i, node: 'coordinator', title, tier: 'opus', at: ago(at), evicted: false,
    node_state: 'live', format: 'markdown', bytes: 120 })) as DocRow[]

// every field a docket row reads, as zoomdocket.fixture.ts mkItem (inlined: the base
// bundle carries only this fixture beside the archived source)
const item = (slug: string, at: number): WorkItem => ({
  slug, rev: 1, kind: 'code', title: slug.replace(/-/g, ' '), objective: 'Synthetic work item.', status: 'in_progress',
  blocked_reason: null, archived: false, archived_at: null, owner: { node: 'coordinator', generation: 1 },
  owner_current: true, owner_state: 'live', reviewer: null, participants: [], created_by: { node: 'coordinator', generation: 1 },
  at: ago(at + HOUR), updated_at: ago(at), docket_at: ago(at), status_at: ago(at), done_so_far: [], working_on_next: [],
  last_updater: { node: 'coordinator', generation: 1 }, manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
} as unknown as WorkItem)
const ITEMS = [item('fresh-item', 30 * MIN), item('two-day-item', 50 * HOUR), item('three-week-item', 20 * DAY),
  item('old-item', 400 * DAY)]

const answer = (url: string): unknown => {
  const path = url.split('?')[0]!
  if (path === '/api/orgs/fixture/net/recent') return { recent: RECENT }
  if (path === '/api/orgs/fixture/org_inbox') return { entries: ENTRIES, total: ENTRIES.length, unread: 0 }
  if (path.endsWith('/transfers')) return { transfers: [], next_cursor: null }
  const doc = path.match(/\/documents\/([^/]+)$/)
  if (doc) return { ...DOCS.find((d) => d.id === doc[1]), body: '# A synthetic presentation\n\nIts text is not under test.' }
  // a locate read names what it found, as the engine does (gallerylazy.test.tsx)
  const locate = new URLSearchParams(url.split('?')[1] ?? '').get('locate')
  if (path.endsWith('/documents')) return { documents: DOCS, total: DOCS.length, next_offset: null, offset: 0, ...(locate ? { located: locate } : {}) }
  const work = path.match(/\/work-items\/([^/]+)$/)
  if (work) return { item: ITEMS.find((i) => i.slug === work[1]) }
  if (path.includes('/profile-picture')) return { picture: null }
  if (path === '/api/desktop/phone') return { hubchat_pc: true }
  return {}
}
const reads: string[] = []
window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  reads.push(url)
  return new Response(JSON.stringify(answer(url)), { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

setNetRoster('fixture', NET)
setHubchatInstalled(true)
window.open = (() => null) as typeof window.open
const root = createRoot(document.getElementById('root')!)
type Surface = 'connections' | 'orginbox' | 'presentations' | 'docket'
const noop = () => {}
let seq = 0
Object.assign(window, { symFixture: {
  reads, entries: ENTRIES, docs: DOCS, items: ITEMS, stranger: STRANGER,
  show: (surface: Surface, theme: 'dark' | 'light') => {
    localStorage.setItem('orgtree-contrast-theme', theme === 'light' ? 'light' : 'charcoal')
    document.documentElement.classList.toggle('contrast-light', theme === 'light')
    const key = surface + theme + ++seq
    root.render(surface === 'connections'
      ? <ConnectionsPanel key={key} tree={TREE} toast={noop} close={noop} />
      : surface === 'orginbox'
        ? <OrgInboxModal key={key} inbox={TREE.org_inbox} net={NET} map={new Map()} slug="fixture" toast={noop}
            close={noop} jumpTo="e-q" jumpSeq={seq} />
        : surface === 'presentations'
          ? <DocGalleryModal key={key} slug="fixture" toast={noop} close={noop} jumpTo={{ id: 'doc-0', seq }} />
          // framed as the app's centred agent docket (canvas/agentdocket.tsx): a wide settings panel
          : <PinFrame key={key} kind={instanceKind('agent-docket', 'coordinator')} title="coordinator · Docket"
              panel="settings wide" close={noop}>
              <AgentDocketView slug="fixture" nid="coordinator" mine={ITEMS} facts={new Map()} toast={noop}
                onFocusAgent={noop} onChanged={noop}
                refs={{ world: { nodes: new Map(), items: new Map() }, onOpen: noop } as never} /></PinFrame>)
  },
} })
