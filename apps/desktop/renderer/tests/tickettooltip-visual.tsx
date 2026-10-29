import { createRoot } from 'react-dom/client'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { ToolChip } from '../src/canvas/desk'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { objectNavProps } from '../src/canvas/objectnav'

const noop = () => {}
const id = 'project-card-resize', title = 'Project card shrinks and grows as it is highlighted and unhighlighted (fit-to-card rescales on hover)'
let status = 'open'
;(window as unknown as { setTicketState: (next: string) => void }).setTicketState = next => { status = next }
globalThis.fetch = (async () => new Response(JSON.stringify({ item: { slug: id, title, status, archived: false, owner: null } }))) as typeof fetch
const world = { org: 'demo', items: new Map([[id, title]]), itemTitles: new Map([[id, title]]) }
createRoot(document.getElementById('root')!).render(<ObjectNavProvider>
  <ObjectNavHost org="demo" dogs={[]} openDog={noop} openTicket={noop} toast={noop} />
  <ObjectMenuBoundary><main>
    <h1>Ticket identity hover</h1>
    <p>Every ticket link draws its full title; its hover is the current status, then the slug.</p>
    <h2>Native title attribute read back from each hovered link (an offscreen window paints no OS tooltip)</h2>
    <div id="hover-readout" />
    <section data-surface="tool"><h2>Transcript tool row</h2>
      <ToolChip t={{ id: 'change', name: 'orgtree_work', work: { slug: id } }} slug="demo" nid="worker" onWorkLink={noop} />
    </section>
    <section><h2>Typed reference</h2><RefChip r={resolveRef({ kind: 'item', org: 'demo', id }, world)} onOpen={noop} /></section>
    <section><h2>Markdown mention</h2><RefMdBody html={{ __html: `<p>@item:demo/${id}</p>` }} world={world} onOpen={noop} /></section>
    <section><h2>Inbox reply target</h2><MailReplyPreview row={{ reply_to: { id, kind: 'work_item', org: 'demo', gist: title } }} org="demo" world={world} onOpen={noop} /></section>
    <section><h2>Another org's ticket</h2><button type="button" data-surface="away" {...objectNavProps('ticket', id, 'away')}>{title}</button></section>
  </main></ObjectMenuBoundary>
  <style>{`html,body,#root{margin:0;min-height:100%;background:var(--bg);color:var(--ink)}main{display:block;height:auto;padding:26px;max-width:920px;font:14px system-ui}h1{font-size:24px;margin:0 0 10px}h2{font-size:13px;margin:0 0 12px;color:var(--dim)}p{color:var(--dim)}section{padding:16px;margin:12px 0;border:1px solid var(--line);border-radius:6px}#hover-readout{position:sticky;top:0;z-index:5;background:var(--bg);border:1px solid var(--line);padding:10px 14px;font:12px/1.55 ui-monospace,Consolas,monospace;max-width:850px;min-height:20px;box-shadow:0 6px 12px var(--bg)}`}</style>
</ObjectNavProvider>)
