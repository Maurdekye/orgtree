import { createRoot } from 'react-dom/client'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview, ReplySourceProvider } from '../src/canvas/replypreview'
import { indexReplySources, ReplySourceContent } from '../src/canvas/replysource'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import '../src/styles.css'
import '../src/shell.css'

// Capture fixture: the three reply quotes side by side (USER 2026-11-03 m64286c099254): a MAIL reply and a DOCKET reply
// (the references) and an AGENT-MESSAGE reply, which must now look like them. Theme: ?theme=light|charcoal. All data synthetic.
const theme = new URLSearchParams(location.search).get('theme') ?? 'light'
applyContrast(theme === 'charcoal' ? 'charcoal' : 'light'); applyTheme('claude')
const org = 'synthetic'
const world = { org, handles: new Set<'doc' | 'mail' | 'item'>(['doc', 'mail', 'item']), docs: new Map(), items: new Map([['fix-title', 'Fix the title']]) }
const long = 'One more for the fold (18:22:52Z, verbatim): "also i want the nodes to visibly animate into the collapsed position rather than disappearing instantly". It is on the fold ticket. My gap-fills: expanding plays the reverse; lines and sibling shifts animate with the nodes; timing matches the existing canvas layout animations; an interrupted animation continues from the current positions.'
const sources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'a1', text: 'Got it, they already animate out when you expand, so that part needs no work. The only change is collapsing: the nodes will slide into the stack using the same motion and timing as the expand animation, the reverse of what you see now. It is on the fold ticket with the new stack look, and the coordinator has it.', ts: '2026-11-03T18:23:09Z' }] })
window.fetch = (async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
createRoot(document.getElementById('root')!).render(
  <main className="settings" style={{ width: 760, maxWidth: 'none', position: 'static', transform: 'none', margin: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
    <section data-scene="mail"><h4>Mail reply (reference)</h4>
      <MailReplyPreview row={{ reply_to: { id: 'm1', kind: 'mail', box: 'user', from: 'liaison-opus', at: '2026-11-03T18:23:01Z', gist: long } }} org={org} world={world} onOpen={() => {}} /></section>
    <section data-scene="docket"><h4>Docket reply (reference)</h4>
      <MailReplyPreview row={{ reply_to: { id: 'fix-title', kind: 'work_item', from: 'coordinator-opus', at: '2026-11-03T18:20:00Z', gist: 'Fix the title: a ticket gist retained with the reply, clamped like the mail one.' } }} org={org} world={world} onOpen={() => {}} /></section>
    <section data-scene="agent"><h4>Agent message reply</h4>
      <ReplySourceProvider value={r => <ReplySourceContent source={sources.get(r.eventId)!} slug={org} nid="coordinator-opus" profile="operator" />}>
        <ReplyPreview reply={{ org, agent: 'coordinator-opus', generation: 1, eventId: 'a1', quote: 'Got it' }} available onLocate={() => {}} />
      </ReplySourceProvider></section>
  </main>)
