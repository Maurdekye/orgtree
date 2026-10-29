// tests/connectionlist.visual.tsx — what connectionlist.capture.cjs draws:
// Org settings → Connections over 200 synthetic connections, and App settings
// → Mail hub over this computer's synthetic hub (USER 2026-10-29). No engine:
// every read is answered here from synthetic data. The first eighteen are the
// shapes of the user's own list (u606427050cc1-image.png); the rest are
// generated. The same file draws the base (before) and the tip (after).
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { ConnectionsPanel } from '../src/canvas/connections'
import { AccountsPanel } from '../src/canvas/accounts'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { setNetRoster } from '../src/canvas/netmentions'
import type { NetBlock, NetPeer, TreePayload } from '../src/types'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
let seed = 20261029
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

const CC = 'independent Claude Code chat'
const USERS: [string, NetPeer['kind'], boolean, string?][] = [
  ['alpha test', 'org', true], ['cc-system32-general', 'chat', false, CC], ['le-measure-echo', 'chat', false, CC],
  ['le-measure-echoseq', 'chat', false, CC], ['Penelope', 'chat', false, 'Waiting to be linked to a Hubchat identity'],
  ['Maurdekye Works', 'org', true], ['Maurdekye', 'person', true], ['neoja', 'person', true],
  ['orgtree-alpha-startup-fix', 'chat', false, CC], ['orgtree-coordinator-opus', 'chat', true, CC], ['orgtree-drag-opus', 'chat', false, CC],
  ['orgtree-lifetime-refused', 'chat', false, CC], ['orgtree-rustengine', 'chat', true, CC], ['orgtree-tempcleaner', 'chat', false, CC],
  ['orgtree-troubleshooter', 'chat', false, CC], ['Resonite', 'org', true], ['testname', 'org', false], ['Unity', 'org', true],
]
const slugOf = (name: string, i: number) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.syn.${(0x1000 + i).toString(16)}`
const peer = (name: string, kind: NetPeer['kind'], online: boolean, i: number, blurb?: string): NetPeer => ({
  slug: slugOf(name, i), kind, online, blurb: blurb ?? '', last_seen: ago(Math.round(rand() * 600)),
  ...(kind === 'org' ? { org_name: name } : { username: name }),
})
const ROSTER: NetPeer[] = USERS.map(([name, kind, online, blurb], i) => peer(name, kind, online, i, blurb))
for (let i = ROSTER.length; i < 200; i++) {
  const r = rand()
  const kind: NetPeer['kind'] = r < 0.55 ? 'chat' : r < 0.8 ? 'org' : 'person'
  const name = kind === 'chat' ? `cc-session-${String(i).padStart(3, '0')}` : kind === 'org' ? `Synthetic org ${i}` : `Synthetic person ${i}`
  ROSTER.push(peer(name, kind, rand() < 0.25, i, kind === 'chat' ? CC : ''))
}
const RECENT: Record<string, string> = {}
for (const p of ROSTER) if (rand() < 0.6) RECENT[p.slug] = ago(Math.round(rand() * 30 * 1440))

const OWN = 'orgtree.syn.0fff'
const NET: NetBlock = {
  slug: OWN,
  hubs: [{ id: 'local', address: 'http://127.0.0.1:7370', name: 'maurdekye-net', version: '2.2.0', enabled: true,
    connected: true, queued: 0, roster: ROSTER }],
}
const TREE = { slug: 'fixture', net: NET,
  org_inbox: { entries: [], total: 42, unread: 0, holders: [], visible: true, multi_holder_enabled: false } } as unknown as TreePayload

// this computer's hub: the first forty, and this org itself
const HUB_ROWS: NetPeer[] = [{ slug: OWN, org_name: 'Orgtree', kind: 'org', online: true }, ...ROSTER.slice(0, 40)]
const HUB = {
  version: 2, port: 7370, bind: '127.0.0.1', name: 'maurdekye-net', retention_days: null, org_retention_days: 45,
  public_listener: false, public_listener_port: 7371,
  status: { running: true, healthy: true, address: 'http://127.0.0.1:7370', exposed: false, hub_name: 'maurdekye-net',
    hub_version: '2.2.0', orgs: HUB_ROWS.length, queued: 3 },
  data_migration: { messages: 0, attachments: 0, orgs_copied: 0, orgs_skipped: [] },
  v2_import: { orgs: 16, messages: 86, attachments: 2 },
}
const LINK = { name: 'Maurdekye', address: '@net:' + ROSTER[6]!.slug, org: 'fixture' }

const answer = (url: string): unknown => {
  const path = url.split('?')[0]!
  if (path === '/api/orgs/fixture/net/recent') return { recent: RECENT }
  if (path === '/api/desktop/hub') return HUB
  if (path === '/api/desktop/hub/connections') return { running: true, connections: HUB_ROWS, recent: { ...RECENT, [OWN]: ago(3) } }
  if (path === '/api/desktop/phone/card') return { card: { show: false, dismissed: true, org: 'fixture' }, link: LINK }
  if (path === '/api/desktop/phone') return { hubchat_pc: true, link: LINK, card: { show: false, dismissed: true, org: 'fixture' } }
  if (path.includes('/profile-picture')) return { picture: null }
  if (path.startsWith('/api/accounts')) return { version: 2, primary: { id: 'primary', signed_in: true, email: 'me@example.test' }, keys: [], assignments: {} }
  if (path.startsWith('/api/providers')) return { providers: [] }
  if (path.startsWith('/api/runtime-settings')) return { warming_enabled: true }
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
type Surface = 'connections' | 'mailhub'
Object.assign(window, { connFixture: {
  reads, roster: ROSTER, recent: RECENT, hubRows: HUB_ROWS,
  show: (surface: Surface, theme: 'dark' | 'light') => {
    // App settings holds the contrast setting, which reads this key without a desktop bridge
    localStorage.setItem('orgtree-contrast-theme', theme === 'light' ? 'light' : 'charcoal')
    document.documentElement.classList.toggle('contrast-light', theme === 'light')
    root.render(surface === 'connections'
      ? <ConnectionsPanel key={surface + theme} tree={TREE} toast={() => {}} close={() => {}} />
      : <AccountsPanel key={surface + theme} toast={() => {}} close={() => {}} initialTab="mailhub" />)
  },
} })
