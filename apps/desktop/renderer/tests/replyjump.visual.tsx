// replyjump.visual.tsx: capture fixture for the jump-to-message link inside a
// reply block's header row (@item:orgtree/restyle-reply-blocks-and-the-inline-quoted-reply,
// USER 2026-11-03 m3db1ac4251e4). Build the SAME file at the base and the tip: the
// components exist at both, only the link's place changes.
//   sent-mail      a reply whose source is a mail (the screenshot: header "Message . agent . time")
//   sent-answer    a reply whose source is an assistant message (header row with the time)
//   (at 360 px the sent-mail header wraps: the link stays on the header's rows)
//   text-only      a quote with no header of its own (link stays in the block head)
//   composer       a draft being written: jump + remove stay in the control strip
// Window.replyJump.theme(contrast) / width(px) / only(name) like replystyle.visual.tsx.
// Browser-only synthetic data; the clipboard is refused.
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReplyPreview, ReplySourceProvider } from '../src/canvas/replypreview'
import { indexReplySources, ReplySourceContent } from '../src/canvas/replysource'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import '../src/styles.css'
import '../src/shell.css'

const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
window.fetch = (async () => new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

const org = 'synthetic'
const TEXT = 'That ruling (mc90a10be598b) is already in the fold-stack commit b437cc4. "Collapse subtree" / "Expand subtree" is an entry in the right-click menu of every agent and project node that has members, in both menu builders, at mini and norm zoom. One gap: the focused agent desk has no fold entry via right-click. Tell me if you want that changed.'
const sources = indexReplySources({
  pending: [{ id: 'm-src', event_id: 'ev-mail', from: 'project-themes-sonnet', kind: 'message', body: TEXT, at: '2026-11-03T11:16:30Z' } as never],
  messages: [
    { role: 'assistant', event_id: 'ev-answer', text: 'Done: the fold entry is in both menu builders.', ts: '2026-11-03T11:16:30Z' } as never,
    { role: 'assistant', event_id: 'ev-long', text: 'A short answer under a long header.', ts: '2026-11-03T11:16:30Z' } as never,
  ],
})
const ref = (eventId: string, quote = 'Saved excerpt') => ({ org, agent: 'coordinator-opus', generation: 1, eventId, quote })
const provider = (node: ReactNode) => <ReplySourceProvider value={r => sources.has(r.eventId)
  ? <ReplySourceContent source={sources.get(r.eventId)!} slug={org} nid="coordinator-opus" profile="operator" /> : null}>{node}</ReplySourceProvider>

const SURFACES: Record<string, () => ReactNode> = {
  'sent-mail': () => provider(<ReplyPreview reply={ref('ev-mail')} available onLocate={() => {}} />),
  'sent-answer': () => provider(<ReplyPreview reply={ref('ev-answer')} available onLocate={() => {}} />),
  'text-only': () => <ReplyPreview reply={ref('none', TEXT)} available onLocate={() => {}} />,
  composer: () => <div className="composer-wrap">{provider(<ReplyPreview reply={ref('ev-answer')} available onLocate={() => {}} onRemove={() => {}} />)}</div>,
}

function Fixture() {
  const [state, setState] = useState({ width: 760, only: '' })
  ;(window as unknown as { replyJump: unknown }).replyJump = {
    surfaces: Object.keys(SURFACES),
    /** contrast: obsidian-black | charcoal | solarized-light | light */
    theme: (contrast: string, accent = 'claude') => { applyContrast(contrast); applyTheme(accent) },
    width: (width: number) => setState(s => ({ ...s, width })),
    only: (name: string) => setState(s => ({ ...s, only: name })),
  }
  const names = state.only ? [state.only] : Object.keys(SURFACES)
  return <div style={{ width: state.width, padding: 10, background: 'var(--panel)' }} data-fixture="replyjump">
    {names.map(name => <div key={name} data-surface={name} style={{ marginBottom: 14 }}>
      <div className="dim" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>{name}</div>
      <div className="desk-chat">{SURFACES[name]!()}</div>
    </div>)}
  </div>
}

applyContrast('charcoal'); applyTheme('claude')
createRoot(document.getElementById('root')!).render(<Fixture />)
