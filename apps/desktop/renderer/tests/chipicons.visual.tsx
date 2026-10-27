// chipicons.visual.tsx — the fixture for USER 2026-10-27 22:34:06Z m2aeb0fd887cb ("center the icon appearing in
// all links to things"): every mention chip kind that wears an icon (ticket, document, app, panel, agent model
// badge, project folder, network person / org / agent session / unknown), as the app's own React chips and as the
// chips Markdown builds, in a sentence at two font sizes. The capture (chipicons.capture.cjs) flips the "wrap
// object mentions" setting (inline fragments instead of inline-flex buttons) and measures each icon against its
// label. Browser-only fixture data: no engine, bridge or live org.
import { createRoot } from 'react-dom/client'
import { HubContactChip, setHubchatInstalled } from '../src/canvas/agentmentions'
import { NodeLink, ProjectLink } from '../src/canvas/identity'
import { setNetRoster } from '../src/canvas/netmentions'
import { RefChip, refToken, resolveRef, type RefWorld } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import type { TypedRef } from '../src/canvas/workrefs'
import type { NetBlock } from '../src/types'
import { installWrapBackend } from './mentionwrap.fixture'
import '../src/styles.css'
import '../src/shell.css'

const backend = installWrapBackend()
window.fetch = backend.fetcher
window.WebSocket = backend.Socket as unknown as typeof WebSocket

const refs: { kind: string; ref: TypedRef }[] = [
  { kind: 'item', ref: { kind: 'item', org: 'chips', id: 'docket-copy' } },
  { kind: 'doc', ref: { kind: 'doc', org: 'chips', id: 'notes' } },
  { kind: 'app', ref: { kind: 'app', org: 'chips', id: 'board' } },
  { kind: 'panel', ref: { kind: 'panel', org: 'chips', id: 'one' } },
]
const labels: Record<string, string> = { item: 'Double-clicking a docket item', doc: 'Release notes', app: 'Caption board', panel: 'Panel 1' }
const world: RefWorld = {
  org: 'chips',
  items: new Map([['docket-copy', labels.item!]]), docs: new Map([['notes', labels.doc!]]),
  agents: new Map([['dev1', 'dev1'], ['crew', 'crew']]),
  tierOf: id => (id === 'crew' ? 'project' : 'opus'),
  refName: ref => ({ outcome: 'ready', label: labels[ref.kind] ?? ref.id,
    flare: ref.kind === 'item' ? { cls: 'status-in_progress', tip: 'In progress' } : undefined }),
}

const net: NetBlock = {
  slug: 'home.chips.111111',
  hubs: [{ id: 'local', address: 'http://hub.example:7370', name: 'Fixture hub', version: '2.2.0', enabled: true, connected: true, queued: 0,
    roster: [
      { slug: 'ann.person.aa1111', org_name: 'Ann', kind: 'person', online: true },
      { slug: 'acme.org.bb2222', org_name: 'Acme', kind: 'org', online: true },
      { slug: 'helper.chat.cc3333', org_name: 'Helper', kind: 'chat', online: false },
    ] }],
}
setNetRoster('chips', net)
setHubchatInstalled(true)

const noop = () => {}
const NETS = ['net-person:@net:ann.person.aa1111', 'net-org:@net:acme.org.bb2222', 'net-chat:@net:helper.chat.cc3333', 'net-unknown:@net:stranger.dd4444']

/** One sentence per chip: `row` is the row's name in the capture, and a row without a chip is the line-height control. */
function Row({ row, children }: { row: string; children?: React.ReactNode }) {
  return <p className="chip-row" data-chip-row={row} style={{ margin: '0 0 6px', whiteSpace: 'nowrap' }}>
    Before {children ?? <b>plain</b>} after
  </p>
}

function Rows({ size }: { size: number }) {
  return <section className="chip-section" data-size={size} style={{ fontSize: size, lineHeight: 1.5, padding: '8px 12px', width: 620 }}>
    <Row row="control" />
    {refs.map(({ kind, ref }) => <Row key={kind} row={kind}><RefChip r={resolveRef(ref, world)} onOpen={noop} /></Row>)}
    {refs.map(({ kind, ref }) => <Row key={'md-' + kind} row={'md-' + kind}>
      <RefMdBody el="span" world={world} onOpen={noop} html={{ __html: refToken(ref) }} /></Row>)}
    <Row row="agent"><NodeLink id="dev1" tier="opus" onFocus={noop} className="ref-chip ref-agent ref-ready" /></Row>
    <Row row="project"><ProjectLink id="crew" onFocus={noop} className="ref-chip ref-agent ref-ready" /></Row>
    <Row row="md-agent"><RefMdBody el="span" world={world} onOpen={noop} html={{ __html: '@dev1' }} /></Row>
    {NETS.map(entry => { const [kind, address] = [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)]
      return <Row key={kind} row={kind}><HubContactChip address={address} /></Row> })}
    <Row row="md-net-person"><RefMdBody el="span" world={world} onOpen={noop} html={{ __html: '@net:ann.person.aa1111' }} /></Row>
  </section>
}

function Fixture() {
  return <div id="stage"><Rows size={13} /><Rows size={22} /></div>
}

Object.assign(window, { chipFixture: { wrap: (on: boolean) => backend.emit(on) } })
createRoot(document.getElementById('root')!).render(<Fixture />)
