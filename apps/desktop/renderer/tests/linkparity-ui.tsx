import { createRoot } from 'react-dom/client'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectMenuBoundary, useContextMenu } from '../src/canvas/contextmenu'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { UserMention } from '../src/canvas/usermention'
import { OrgRows } from '../src/shell/orgrows'
import { HubContactChip, setKnownOrgs, setHubchatInstalled } from '../src/canvas/agentmentions'
import { senderMenuAction } from '../src/canvas/objectactions'
import { useObjectNavRegistry } from '../src/canvas/objectnav'
import { mailLinkProps } from '../src/canvas/mailidentity'
import type { Watchdog } from '../src/types'
import { WatchdogLink } from '../src/canvas/watchdoglink'
import { registerObjectNativeTooltipDocument } from '../src/canvas/objecttooltip'

setKnownOrgs(['example']); setHubchatInstalled(false)
const doc = { id: 'doc', title: 'Architecture review', node: 'writer', presented_by: 'writer', format: 'markdown', at: '2026-10-21T00:00:00Z', body: 'Synthetic document' }
const mail = { id: 'message', from: 'writer', at: '2026-10-21T00:00:00Z', body: 'Synthetic complete message', kind: 'message' }
globalThis.fetch = (async input => {
  const url = String(input)
  const data = url.includes('/mail/') ? { found: true, mail } : url.includes('/documents/') ? doc
    : url.includes('quick-staff') ? {} : { item: { slug: 'ticket', title: 'Review shared link behavior', status: 'open' } }
  return new Response(JSON.stringify(data), { status: 200 })
}) as typeof fetch
const world = { org: 'example', docs: new Map([['doc', doc.title]]), items: new Map([['ticket', 'ticket']]) }
const noop = () => {}
const dog = { id: 'writer/ready', owner: 'writer', name: 'Ready signal', kind: 'event', target: 'example', state: 'armed', once: false, spent: false, fired: 0 } as unknown as Watchdog
function SenderTargets() {
  const menu = useContextMenu(), objects = useObjectNavRegistry()
  return <><div className="sample" data-sample="sender"><b>Context-menu identity link</b><button onContextMenu={e => {
    const sender = senderMenuAction(e.currentTarget, '@user', [], undefined, objects?.openUserInbox)
    menu.open(e, sender ? [sender] : [])
  }}>Reply frame: Sender…</button></div>{menu.node}</>
}
function Fixture() {
  return <ObjectNavProvider><ObjectNavHost org="example" dogs={[dog]} openDog={noop} openTicket={noop} openDocument={noop} openMail={noop} toast={noop} />
    <ObjectMenuBoundary><main><h1>Shared link menus</h1><p>Real renderer components, synthetic identities and routes.</p><section>
      <div className="sample" data-sample="ticket"><b>Docket item</b><RefChip r={resolveRef({ kind: 'item', org: 'example', id: 'ticket' }, world)} onOpen={noop} /></div>
      <div className="sample" data-sample="document"><b>Presentation</b><RefChip r={resolveRef({ kind: 'doc', org: 'example', id: 'doc' }, world)} onOpen={noop} /></div>
      <div className="sample" data-sample="mail"><b>Mail message</b><RefChip r={resolveRef({ kind: 'mail', org: 'example', box: 'user', id: 'message' }, world)} onOpen={noop} /></div>
      <div className="sample" data-sample="icon"><b>Icon-only mail</b><button {...mailLinkProps({ org: 'example', box: 'user', id: 'message' }, 'open mail')} aria-label="open mail">✉</button></div>
      <div className="sample" data-sample="watchdog"><b>Watchdog</b><WatchdogLink org="example" dog={dog} onOpen={noop} /></div>
      <div className="sample" data-sample="user"><b>User inbox identity</b><UserMention refs={{ world, onOpen: noop }} /></div>
      <div className="sample" data-sample="contact"><b>Remote contact</b><HubContactChip address="@net:sample.123456" /></div>
      <div className="sample" data-sample="org"><b>Local organization</b><HubContactChip address="@org:example" /></div>
      <div className="sample" data-sample="orgrow"><b>Organization row</b><OrgRows orgs={[{ slug: 'example', name: 'Example org', nodes: 0, live: 0, created: null }]} slug={null} onPick={noop} onDelete={noop} /></div>
      <SenderTargets />
      <div className="sample" data-sample="file"><b>Local file capability</b><RefMdBody html={{ __html: '<a data-local-path="C:\\synthetic\\report.txt" href="#">report.txt</a>' }} /></div>
    </section><output id="identity-readout">Hover identity is checked before each menu capture.</output></main></ObjectMenuBoundary>
    <style>{`html,body,#root{margin:0;min-height:100%;background:var(--bg);color:var(--text)}main{padding:24px;font:14px system-ui}h1{margin:0 0 8px;font-size:22px}p{color:var(--muted)}section{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:900px}.sample{padding:14px;border:1px solid var(--line);border-radius:6px;min-height:78px;display:flex;align-items:flex-start;flex-direction:column;gap:12px}.sample>b{font-size:12px;color:var(--muted)}.sample>.org{min-width:240px}output{display:block;margin-top:20px;white-space:pre-wrap;border-top:1px solid var(--line);padding-top:12px}`}</style>
  </ObjectNavProvider>
}
// A detached document uses the same exact-id tooltip host. Tests cover its
// cleanup/stale rules; this fixture exposes the registration for capture QA.
;(window as unknown as { registerIdentityDocument: typeof registerObjectNativeTooltipDocument }).registerIdentityDocument = registerObjectNativeTooltipDocument
createRoot(document.getElementById('root')!).render(<Fixture />)
