// chipalign.visual.tsx — the fixture for USER 2026-10-31 08:44:26Z m4b300ae4cbd1 ("agent links are sometimes
// vertically misaligned with the surrounding text in places, can that be cleaned up?"): every inline link chip
// kind (agent, project, ticket, document, app, panel, network person / org / chat / unknown) drawn the way each
// surface draws it, as the app's own React chips and as the chips Markdown builds: chat prose (an assistant
// message, a user message), a mail body, a docket description, an event head, a mail row, a tray row and a plain
// flex line. The capture (chipalign.capture.cjs) measures, per row, whether every run of text on a line shares one
// baseline and whether each chip's badge sits on its label. Browser-only fixture data: no engine, bridge or live org.
import { createRoot } from 'react-dom/client'
import { useAppFeed } from '../src/appfeed'
import { HubContactChip, setHubchatInstalled } from '../src/canvas/agentmentions'
import { AgentName, NodeLink, ProjectLink } from '../src/canvas/identity'
import { setNetRoster } from '../src/canvas/netmentions'
import { ToolChip } from '../src/canvas/desk'
import { RefChip, refToken, resolveRef, type RefWorld } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { useRefNames } from '../src/canvas/refnames'
import { SenderChip } from '../src/canvas/senderchip'
import { buildMentionIndex, WorkRefText, type TypedRef } from '../src/canvas/workrefs'
import { useMemo } from 'react'
import type { NetBlock, TreeNode } from '../src/types'
import { installWrapBackend } from './mentionwrap.fixture'
import '../src/styles.css'
import '../src/shell.css'

const backend = installWrapBackend()
/** the engine's one-message lookup, synthetic: an id starting `gone` is not in the box, one starting `unread` is pending in the user's inbox */
const MAIL_BODY = 'Please review the attached plan today'
window.fetch = (async (input, init) => {
  const hit = /^\/api\/orgs\/chips\/mail\/(?:user|org|node)\/([^/?]+)/.exec(new URL(String(input), 'http://chips.invalid').pathname)
  if (!hit) return backend.fetcher(input, init)
  const id = decodeURIComponent(hit[1]!)
  return new Response(JSON.stringify(id.startsWith('gone') ? { found: false, mail: null }
    : { found: true, mail: { id, from: 'writer', at: '2026-10-31T08:00:00Z', kind: 'message', body: MAIL_BODY, unread: id.startsWith('unread') } }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
window.WebSocket = backend.Socket as unknown as typeof WebSocket

const refs: { kind: string; ref: TypedRef }[] = [
  { kind: 'item', ref: { kind: 'item', org: 'chips', id: 'docket-copy' } },
  { kind: 'doc', ref: { kind: 'doc', org: 'chips', id: 'notes' } },
  { kind: 'app', ref: { kind: 'app', org: 'chips', id: 'board' } },
  { kind: 'panel', ref: { kind: 'panel', org: 'chips', id: 'one' } },
]
const labels: Record<string, string> = { item: 'Double-clicking a docket item', doc: 'Release notes', app: 'Caption board', panel: 'Panel 1',
  'item-s': 'Fix the bug', 'doc-s': 'Notes', 'app-s': 'Board', 'doc-n': 'Notes' }
/** the same kinds with labels short enough that the sentence keeps the control's two lines (a row is measured against the control only when the line counts match) */
const shortRefs: TypedRef[] = [{ kind: 'item', org: 'chips', id: 'item-s' }, { kind: 'doc', org: 'chips', id: 'doc-s' }, { kind: 'app', org: 'chips', id: 'app-s' }]
const world: RefWorld = {
  org: 'chips',
  items: new Map([['docket-copy', labels.item!], ['item-s', labels['item-s']!]]), docs: new Map([['notes', labels.doc!], ['doc-s', labels['doc-s']!], ['doc-n', labels['doc-n']!]]),
  agents: new Map([['dev1', 'dev1'], ['crew', 'crew']]),
  tierOf: id => (id === 'crew' ? 'project' : 'opus'),
  // an unread presentation (doc-n) wears its flare, so a message link's can be compared with it
  refName: ref => ({ outcome: 'ready', label: labels[ref.id.endsWith('-s') || ref.id === 'doc-n' ? ref.id : ref.kind] ?? ref.id,
    flare: ref.kind === 'item' ? { cls: 'status-in_progress', tip: 'In progress' } : ref.id === 'doc-n' ? { cls: 'doc-new', tip: 'Unread' } : undefined }),
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
const nodes = new Map<string, TreeNode>([['dev1', { id: 'dev1', tier: 'opus', state: 'live' } as TreeNode]])
const index = buildMentionIndex([{ slug: 'docket-copy', title: labels.item!, status: 'in_progress' }], [['dev1', 'opus']])
/** the world with the app's own name reader for mail (a message's first words), the way a surface builds it */
function useChipsWorld(): RefWorld {
  const refName = useRefNames('chips')
  return useMemo(() => ({ ...world, refName: ref => (ref.kind === 'mail' ? refName(ref) : world.refName!(ref)) }), [refName])
}
const mailRef = (id: string, box: 'user' | 'org' | 'node' = 'user'): TypedRef => ({ kind: 'mail', org: 'chips', box, id })
const NETS = ['net-person:@net:ann.person.aa1111', 'net-org:@net:acme.org.bb2222', 'net-chat:@net:helper.chat.cc3333', 'net-unknown:@net:stranger.dd4444']
/** the markdown a message carries for each chip kind: the token the app's own renderer turns into the chip */
const TOKENS: Record<string, string> = {
  agent: '@dev1', project: '@crew',
  item: refToken(refs[0]!.ref), doc: refToken(refs[1]!.ref), app: refToken(refs[2]!.ref), panel: refToken(refs[3]!.ref),
  'net-person': '@net:ann.person.aa1111', 'net-org': '@net:acme.org.bb2222',
}
const SENTENCE = (token: string) => `<p>Changes everywhere it appears, on both sides, were posted to ${token}. It'll be built soon.</p>`

/** a row of the capture: `ctx` names it, and a row whose context has no chip is the line-height control */
const Ctx = ({ ctx, children, className, style }: { ctx: string; children: React.ReactNode; className?: string; style?: React.CSSProperties }) =>
  <div className={className} data-ctx={ctx} style={style}>{children}</div>

function Md({ ctx, token, kind = 'msg assistant', body }: { ctx: string; token: string; kind?: string; body?: string }) {
  const w = useChipsWorld()
  return <Ctx ctx={ctx} className="desk-body" style={{ marginBottom: 6 }}><div className="msgs" style={{ display: 'block', overflow: 'visible' }}>
    <div className={kind}><RefMdBody className="md" world={w} onOpen={noop} html={{ __html: body ?? SENTENCE(token) }} /></div>
  </div></Ctx>
}

function Rows() {
  const w = useChipsWorld()
  return <section className="chip-section" style={{ padding: '8px 12px', width: 640 }}>
    <Md ctx="control" token="the desk" />
    {Object.entries(TOKENS).map(([kind, token]) => <Md key={kind} ctx={'msg-' + kind} token={token} />)}
    {shortRefs.map(ref => <Md key={ref.kind + '-s'} ctx={'msg-' + ref.kind + '-s'} token={refToken(ref)} />)}
    {/* the @mail: link: alone, beside a ticket and a presentation link in a desk message, for a message that is not there, as the React chip,
        in a docket description, and on the tool row of a sent mail where an "open" button used to be */}
    <Md ctx="msg-mail" token={refToken(mailRef('m-plan'))} />
    <Md ctx="msg-mail-mixed" token="" body={`<p>See ${refToken(shortRefs[0]!)}, ${refToken(shortRefs[1]!)} and ${refToken(mailRef('m-plan'))} together.</p>`} />
    <Md ctx="msg-mail-gone" token={refToken(mailRef('gone-1'))} />
    {/* a message the user has not read (USER 2026-10-31 m5345a1e44ad1): alone, beside an unread presentation link, as the React chip, and on the tool row */}
    <Md ctx="msg-mail-unread" token={refToken(mailRef('unread-1'))} />
    <Md ctx="msg-mail-unread-mixed" token="" body={`<p>See ${refToken({ kind: 'doc', org: 'chips', id: 'doc-n' })} and ${refToken(mailRef('unread-1'))} together.</p>`} />
    <Md ctx="msg-user-agent" kind="msg user" token="@dev1" />
    <Md ctx="msg-mixed" token="@dev1" body={`<p>Ask ${TOKENS.agent} or ${TOKENS.project}, then see ${TOKENS.item} and ${TOKENS.doc}; ${TOKENS['net-person']} replied.</p>`} />
    {/* the mail reading pane's own body */}
    <Ctx ctx="mail-body-agent" className="mailer-body" style={{ marginBottom: 6 }}>
      <RefMdBody className="md" world={world} onOpen={noop} html={{ __html: SENTENCE('@dev1') }} /></Ctx>
    {/* the React chips, each in its own sentence; `react-control` is the same sentence with no chip */}
    <Ctx ctx="react-control" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>Before <b>plain</b> after</Ctx>
    {refs.map(({ kind, ref }) => <Ctx key={kind} ctx={'react-' + kind} style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
      Before <RefChip r={resolveRef(ref, world)} onOpen={noop} /> after</Ctx>)}
    <Ctx ctx="react-agent" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
      Before <NodeLink id="dev1" tier="opus" onFocus={noop} className="ref-chip ref-agent ref-ready" /> after</Ctx>
    <Ctx ctx="react-project" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
      Before <ProjectLink id="crew" onFocus={noop} className="ref-chip ref-agent ref-ready" /> after</Ctx>
    {NETS.map(entry => { const kind = entry.slice(0, entry.indexOf(':')), address = entry.slice(entry.indexOf(':') + 1)
      return <Ctx key={kind} ctx={'react-' + kind} style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
        Before <HubContactChip address={address} /> after</Ctx> })}
    <Ctx ctx="react-mail" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
      Before <RefChip r={resolveRef(mailRef('m-plan'), w)} onOpen={noop} /> after</Ctx>
    <Ctx ctx="react-mail-unread" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
      Before <RefChip r={resolveRef(mailRef('unread-1'), w)} onOpen={noop} /> after</Ctx>
    <Ctx ctx="docket-mail" className="settings docket-modal" style={{ position: 'static', width: 'auto', maxWidth: 'none', height: 'auto', maxHeight: 'none', minHeight: 0, padding: '4px 12px', marginBottom: 6 }}>
      <div className="docket-desc"><RefMdBody className="md" world={w} onOpen={noop}
        html={{ __html: `<p>Blocked by ${refToken(shortRefs[0]!)} until ${refToken(mailRef('m-plan'))} is answered.</p>` }} /></div></Ctx>
    <Ctx ctx="tool-mail" className="desk-body" style={{ marginBottom: 6 }}><div className="msgs" style={{ display: 'block', overflow: 'visible' }}>
      <ToolChip t={{ id: 'sent', name: 'orgtree_message', arg: 'dev1', mail: { id: 'm-plan', to: 'user_inbox' } } as never} slug="chips" nid="dev1" onMailLink={noop} /></div></Ctx>
    <Ctx ctx="tool-mail-unread" className="desk-body" style={{ marginBottom: 6 }}><div className="msgs" style={{ display: 'block', overflow: 'visible' }}>
      <ToolChip t={{ id: 'sent-unread', name: 'orgtree_message', arg: 'user', mail: { id: 'unread-1', to: 'user_inbox' } } as never} slug="chips" nid="dev1" onMailLink={noop} /></div></Ctx>
    {/* the docket: a description's mentions (WorkRefText) */}
    <Ctx ctx="docket-agent" className="settings docket-modal" style={{ position: 'static', width: 'auto', maxWidth: 'none', height: 'auto', maxHeight: 'none', minHeight: 0, padding: '4px 12px', marginBottom: 6 }}>
      <p style={{ margin: 0 }}>Hand it to <WorkRefText text="dev1" index={index} onPick={noop} onFocusAgent={noop} /> when done.</p></Ctx>
    <Ctx ctx="docket-item" className="settings docket-modal" style={{ position: 'static', width: 'auto', maxWidth: 'none', height: 'auto', maxHeight: 'none', minHeight: 0, padding: '4px 12px', marginBottom: 6 }}>
      <p style={{ margin: 0 }}>Blocked by <WorkRefText text="docket-copy" index={index} onPick={noop} onFocusAgent={noop} /> for now.</p></Ctx>
    {/* a flex line: the event head and a mail row */}
    <Ctx ctx="event-head" className="event-head" style={{ padding: '7px 9px' }}>
      <span className="event-actor"><NodeLink id="dev1" tier="opus" onFocus={noop} /></span><span>posted to</span><span>the docket</span></Ctx>
    <Ctx ctx="event-actor-name" className="event-head" style={{ padding: '7px 9px' }}>
      <span className="event-actor"><AgentName id="dev1" tier="opus" onFocus={noop} /></span><span>posted to</span><span>the docket</span></Ctx>
    <Ctx ctx="docket-actor" className="settings docket-modal" style={{ position: 'static', width: 'auto', maxWidth: 'none', height: 'auto', maxHeight: 'none', minHeight: 0, padding: '4px 12px', marginBottom: 6 }}>
      <span className="docket-actor fit-current"><AgentName id="dev1" tier="opus" nameClass="docket-actor-name" onFocus={noop} /></span> wrote this</Ctx>
    <Ctx ctx="mailrow-from" className="mailrow" style={{ position: 'static' }}><div className="l1">
      <span className="mfrom"><SenderChip id="dev1" nodes={nodes} onFocusAgent={noop} /></span><span className="msubj">a subject line</span></div></Ctx>
    <Ctx ctx="mailrow-hub" className="mailrow" style={{ position: 'static' }}><div className="l1">
      <span className="mfrom"><SenderChip id="@net:ann.person.aa1111" nodes={nodes} /></span><span className="msubj">a subject line</span></div></Ctx>
    {/* the compact summaries a chip sits in: an ask's folded line and a tray row's summary */}
    <Ctx ctx="ask-fold-item" style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 6 }}><span className="ask-fold-line">
      <span className="ask-fold-text">Question about</span><RefChip r={resolveRef(refs[0]!.ref, world)} onOpen={noop} /></span></Ctx>
    <Ctx ctx="idle-ticket" className="idle-ticket" style={{ fontSize: 12, marginBottom: 6 }}>
      <RefChip r={resolveRef(refs[0]!.ref, world)} onOpen={noop} /><span className="idle-ticket-status">in progress</span></Ctx>
    <Ctx ctx="tool-refs" style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 6 }}>
      <span className="tool-refs"><RefChip r={resolveRef(refs[0]!.ref, world)} onOpen={noop} /><span className="tool-ticket-plain">plain-slug</span></span></Ctx>
    <Ctx ctx="answered-qtext" className="answered-qtext" style={{ fontSize: 13, marginBottom: 6 }}>
      <RefChip r={resolveRef(refs[0]!.ref, world)} onOpen={noop} />Which option do you want?</Ctx>
    <Ctx ctx="tray-sum-agent" className="tray-sum" style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 6 }}>
      <span className="tray-sum-text">Waiting on <NodeLink id="dev1" tier="opus" onFocus={noop} className="ref-chip ref-agent ref-ready" /> and <RefChip r={resolveRef(refs[0]!.ref, world)} onOpen={noop} /></span></Ctx>
  </section>
}

/** the shell keeps the app feed open in the real app; its "wrap object mentions" value reaches the page through it */
function Feed() { useAppFeed(); return null }
function Fixture() { return <div id="stage"><Feed /><Rows /></div> }

Object.assign(window, { chipFixture: { wrap: (on: boolean) => backend.emit(on) } })
createRoot(document.getElementById('root')!).render(<Fixture />)
