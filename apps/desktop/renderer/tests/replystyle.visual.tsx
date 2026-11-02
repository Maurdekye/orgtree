// replystyle.visual.tsx — before/after captures for
// @item:orgtree/restyle-reply-blocks-and-the-inline-quoted-reply.
// Every reply surface, rendered by the app's own components and styles:
//   transcript-linked  the desk "Mail reply" card of the user's screenshot (typed reply.mail)
//   transcript-legacy  a desk mail row replying through a stored snapshot (keeps its chip)
//   transcript-urgent  a reply quoting an urgent user mail (no second edge inside)
//   reader             the mail reader pane (.mailer-read.event-surface) with its quote
//   composer           a reply being written (the × remove control)
//   selection          a selection reply with its nearby context
//   presentation       a reply to a presentation (title link)
// Build the SAME file at the base and at the tip for the before/after pair:
// at the base the components exist unchanged, only their styles differ.
// Browser-only data: no engine, bridge or live org; the clipboard is refused.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MailMessage } from '../src/events/segments'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview } from '../src/canvas/replypreview'
import { SelectionReplyPreview } from '../src/canvas/selectionpreview'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import type { RefWorld } from '../src/canvas/reflinks'
import '../src/styles.css'
import '../src/shell.css'

const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
window.fetch = (async () => new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

const org = 'synthetic'
const world: RefWorld = { org, handles: new Set(['mail', 'item', 'doc']), docs: new Map([['doc-plan', 'Attract mode: design notes']]) }
const QUOTE = 'USER 2026-11-02 21:05:08Z m578f4c33fa34, verbatim: "finish the muse work on appropriate claude and codex agents. whats left to be done?" This supersedes m2e2a78426006\'s "Wonder seats finish their own work" and "don\'t move frozen Wonder work unasked". Move the three unfinished Wonder items.'
const BODY = 'Done (USER m578f4c33fa34). I removed the Muse-reset watchdog and retired all four Wonder seats. Their handover notes were already on the items.'
const AT = '2026-11-02T21:06:33Z', QAT = '2026-11-02T21:05:29Z'
const linkedEv = {
  v: 1, variant: 'reply.mail', actor: { kind: 'agent', id: 'coordinator-opus' },
  object: { kind: 'mail', org, box: 'user', id: 'm578f4c33fa34', sender: 'user', at: QAT },
  engine_authored: false, body: BODY, quote: { from: 'liaison-opus', at: QAT, gist: QUOTE },
}
const props = { profile: 'operator' as const, slug: org, nid: 'coordinator-opus', world, onOpen: () => {} }

const SURFACES: Record<string, () => ReactNode> = {
  'transcript-linked': () => <MailMessage {...props} row={{ id: 'm-reply', from: 'coordinator-opus', kind: 'message', body: BODY, at: AT, ev: linkedEv }} />,
  'transcript-legacy': () => <MailMessage {...props} row={{ id: 'm-legacy', from: 'writer', kind: 'message', body: BODY, at: AT,
    reply_to: { kind: 'mail', box: 'user', id: 'm-old', from: 'liaison-opus', at: QAT, gist: QUOTE } }} />,
  'transcript-urgent': () => <MailMessage {...props} row={{ id: 'm-urgent', from: 'coordinator-opus', kind: 'message', body: BODY, at: AT,
    urgent: true, urgent_reason: 'blocking', reply_to: { kind: 'mail', box: 'user', id: 'm-u', from: 'user', at: QAT, gist: QUOTE } }} />,
  reader: () => <div className="mailer-read event-surface" style={{ border: 0 }}>
    <MailReplyPreview row={{ reply_to: { kind: 'mail', box: 'user', id: 'm-old', from: 'liaison-opus', at: QAT, gist: QUOTE } }} org={org} world={world} onOpen={() => {}} />
    <div className="mailer-body md"><p>{BODY}</p></div>
  </div>,
  composer: () => <div className="composer-wrap"><ReplyPreview reply={{ org, agent: 'coordinator-opus', generation: 1, eventId: 'e1', quote: QUOTE }}
    available onLocate={() => {}} onRemove={() => {}} /></div>,
  selection: () => <SelectionReplyPreview target={{ kind: 'mail', org, id: 'm-old' }}
    snapshot={{ version: 1, excerpt: 'finish the muse work', prefix: 'verbatim: "', suffix: ' on appropriate claude and codex agents',
      selector: { part: 'mail.body' } } as never} />,
  presentation: () => <MailReplyPreview row={{ reply_to: { kind: 'document', id: 'doc-plan', from: 'attract-mode-opus', at: QAT, gist: 'One app-wide toggle; each org window cycles on its own.' } }}
    org={org} world={world} onOpen={() => {}} />,
}

function Fixture() {
  const [state, setState] = useState({ width: 760, only: '' })
  ;(window as unknown as { replyVisual: unknown }).replyVisual = {
    surfaces: Object.keys(SURFACES),
    /** contrast: obsidian-black | charcoal | solarized-light | light; accent: claude (orange) by default */
    theme: (contrast: string, accent = 'claude') => { applyContrast(contrast); applyTheme(accent) },
    /** 760 = an ordinary desk; 360 = the narrow desk */
    width: (width: number) => setState(s => ({ ...s, width })),
    only: (name: string) => setState(s => ({ ...s, only: name })),
  }
  const names = state.only ? [state.only] : Object.keys(SURFACES)
  return <div style={{ width: state.width, padding: 10, background: 'var(--panel)' }} data-fixture="replies">
    {names.map(name => <div key={name} data-surface={name} style={{ marginBottom: 14 }}>
      <div className="dim" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>{name}</div>
      <div className="desk-chat">{SURFACES[name]!()}</div>
    </div>)}
  </div>
}

applyContrast('charcoal'); applyTheme('claude')
createRoot(document.getElementById('root')!).render(<Fixture />)
