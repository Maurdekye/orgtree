// Synthetic light-mode gallery for lightaccent-visual: the user's inbox and the
// Attention list, with every row kind that draws in the theme accent (unread
// senders, question and request pills, the urgent pill, mail and transcript
// @user mentions, a selected row, links in the reading pane), plus the accent
// fills (a primary button, count badges). window.__gallery switches the view,
// the contrast family and the visual theme. Fixture data only; window.fetch
// answers as the legacy engine does in tests.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { MailList } from '../src/canvas/mail'
import { AttentionQueue } from '../src/attention/AttentionQueue'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import type { MailRow } from '../src/canvas/shared'
import type { TreeNode, TreePayload } from '../src/types'

const pending = [
  { id: 'u1', from: 'rig-sol-b', kind: 'message', at: '2026-10-18T14:30:00Z', urgent: true, urgent_reason: 'the alpha.9 smoke failed',
    body: 'The alpha.9 smoke failed on the synthetic rig; the details are in [the receipt](https://example.invalid/receipt).' },
  { id: 'u2', from: 'taskbar-orgs-sol', kind: 'message', at: '2026-10-18T14:10:00Z', mailbox_attention: true,
    body: 'The picker structure is ready, @user, please try the new popover when you can.' },
  { id: 'q1', from: 'coordinator-opus', kind: 'question', at: '2026-10-18T13:50:00Z',
    body: 'Should the light theme keep the solarized surfaces as they are?' },
  { id: 'r1', from: 'skilltree-opus', kind: 'request', at: '2026-10-18T13:40:00Z',
    body: 'Please review the glossary page for the build slot.' },
] as unknown as MailRow[]
const delivered = [
  { id: 'd1', from: 'usage-header-sonnet', kind: 'message', at: '2026-10-18T12:30:00Z', tags: ['alpha'],
    body: 'Usage header spacing is fixed in both themes.' },
  { id: 'd2', from: 'helper-transcript-sol', kind: 'message', at: '2026-10-18T12:10:00Z', tags: ['review', 'docs'],
    body: 'The helper transcript is in the evidence folder.' },
] as unknown as MailRow[]
const node = (id: string, tier: string, blurb: string, at: string) => ({
  id, state: 'live', tier, children: [],
  user_mention: { id: `${id}:1`, turn_id: 1, seq: 0, event_id: `ev-${id}`, blurb, at },
}) as unknown as TreeNode
const roots = [
  node('coordinator-opus', 'opus', '…nd you one short message @user. It can already message y…', '2026-10-18T14:39:00Z'),
  node('skilltree-opus', 'opus', 'please make sure that the overnight build and the smoke tests are done before @user wakes up tomorrow…', '2026-10-18T13:55:00Z'),
]
window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.endsWith('/api/app/records'))
    return new Response(JSON.stringify({ detail: 'fixture uses the legacy engine' }), { status: 501 })
  const json = url.includes('/work-items') ? { items: [], archived: [], backlogged: [],
    counts: { attention: 0, active: 0, archived: 0, backlogged: 0 }, now: '2026-10-18T15:00:00Z' }
    : url.includes('/inbox') ? { pending: pending.slice(0, 2), delivered: [], sent: [] } : {}
  return new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } })
}

type View = 'inbox' | 'attention'
interface Mode { view: View; contrast: string; theme: string }
declare global { interface Window { __gallery?: { set: (m: Partial<Mode>) => void } } }

function Fixture() {
  const [mode, setMode] = useState<Mode>({ view: 'inbox', contrast: 'light', theme: 'orgtree' })
  useEffect(() => { window.__gallery = { set: (m) => setMode((old) => ({ ...old, ...m })) } }, [])
  useEffect(() => {
    // the app's own setters: one contrast class on the root, the theme's
    // inline accent and its data-visual-theme
    applyContrast(mode.contrast)
    applyTheme(mode.theme)
  }, [mode.contrast, mode.theme])
  useProvideAgentNav((id) => [{ label: `Desk of ${id}`, action: () => {} }], (id) => ({ title: `Agent ${id}` }))
  const tree = { slug: 'org', roots, asks: [] } as unknown as TreePayload
  return <div id="probe" data-view={mode.view} data-contrast={mode.contrast} data-theme={mode.theme}
    style={{ width: 960, height: 600, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, boxSizing: 'border-box' }}>
    {mode.view === 'inbox'
      ? <main className="settings wide" style={{ width: '100%', maxWidth: 'none', height: '100%', position: 'static', transform: 'none', margin: 0, boxSizing: 'border-box' }}>
          <h3>Your inbox</h3>
          <div className="gallery-fills" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px' }}>
            <button className="primary">Save</button>
            <span className="org-attn-badge">2</span>
            <span className="quickchat-count">5</span>
          </div>
          <div className="mailpane" style={{ height: 470 }}>
            <MailList pending={pending} delivered={delivered} waitLabel="unread" selectOldestUnread hideMailReplyKind />
          </div>
        </main>
      : <AttentionQueue slug="org" tree={tree} toast={() => {}} onFocusAgent={() => {}}
          treeStatus={{ loading: false, stale: false, unavailable: false }} />}
  </div>
}
createRoot(document.getElementById('root')!).render(<AgentNavProvider><Fixture /></AgentNavProvider>)
