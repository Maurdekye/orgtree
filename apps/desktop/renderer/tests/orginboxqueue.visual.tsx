// orginboxqueue.visual.tsx — captures for projects holding the org mailbox
// (docket org-inbox-project-queue-outside-mail-queued-in-a; spec rev 2 §4 R2-R5).
// Real components, browser-only data: no engine, bridge, network or clipboard.
// API: window.oiVisual.show(scene, light)   scene = 'holders' | 'replace-project' | 'replace-agent'
//   holders:         AudienceHolderRows (an agent AND a project), the project desk header's "org mailbox" chip with its
//                    revoke, and a real MailRowView (project mail) carrying the "follow-up to <job>" chip
//   panel:           the REAL OrgInboxModal with both holders and its helper copy ("drag an agent or a project onto the mailbox")
//   replace-project: the drop-replace confirm when a PROJECT replaces an AGENT holder
//   replace-agent:   the same confirm when an AGENT replaces a PROJECT holder
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HeldAudienceChips } from '../src/canvas/desk'
import { AudienceHolderRows, MailRowView, OrgInboxModal } from '../src/canvas/mail'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import type { OrgInboxEntry } from '../src/types'
import { InboxReplaceConfirm } from '../src/canvas/inboxreplace'
import { CurrentOrg } from '../src/popout'
import { EXTERN, type CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

// no network, no clipboard
const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
;(window as unknown as { WebSocket: unknown }).WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
const ENTRY = { id: 'in-1', dir: 'in', peer: '@net:alice.fixture', at: '2026-11-03T12:00:00Z', body: 'Hello org, a short outside message.' } as OrgInboxEntry
window.fetch = (async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/org_inbox')
  ? { entries: [ENTRY], total: 1, unread: 0 } : String(url).endsWith('/phone') ? { hubchat_pc: true } : { transfers: [] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

const noop = () => {}
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, tier: 'haiku', state: 'live', children: [],
  scope: { tools: {}, add_dirs: [] }, turns: [], documents: [], ...extra }) as unknown as CanvasNode
const intake = node('intake', { kind: 'project', tier: 'project', audiences_held: [EXTERN], audiences_explicit: [EXTERN] })
const triage = node('triage', { tier: 'opus' })
const map = new Map<string, CanvasNode>([['intake', intake], ['triage', triage]])

function Panel() {
  useProvideAgentNav((id) => [{ label: `Desk of ${id}`, action: () => {} }], (id) => ({ title: `Agent ${id}` }))
  return <OrgInboxModal slug="org" inbox={{ entries: [ENTRY], total: 1, unread: 0, visible: true, holders: ['triage', 'intake'],
    holder_projects: ['intake'], multi_holder_enabled: true } as never} map={map} onFocusAgent={noop} toast={noop} close={noop} />
}

function Scenes() {
  const [state, set] = useState({ scene: 'holders', light: false })
  Object.assign(window, { oiVisual: { show: (scene: string, light: boolean) => {
    document.documentElement.classList.toggle('contrast-light', light)
    document.documentElement.classList.toggle('contrast-charcoal', !light)
    set({ scene, light })
  } } })
  return <CurrentOrg.Provider value="org">
    <div style={{ padding: 24, width: 900, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {state.scene === 'holders' && <>
        <div data-fixture="holders">
          <AudienceHolderRows ids={['triage', 'intake']} nodes={map} onRemove={noop} audienceTarget={EXTERN}
            label="org mailbox audience holders" alert />
        </div>
        <div data-fixture="chip"><HeldAudienceChips slug="org" toast={noop} map={map} node={intake} /></div>
        <div data-fixture="followup" style={{ width: 640 }}>
          <MailRowView projectMail m={{ id: 'm-follow', from: '@net:alice.fixture', kind: 'message', at: '2026-11-03T12:05:00Z',
            body: 'Actually, one more detail about my order.', queue: { follow_up_to: 'u0123456789ab' } } as never}
            view={null} selected={false} party="alice.fixture" onClick={noop} />
        </div>
      </>}
      {state.scene === 'panel' && <div data-fixture="panel"><AgentNavProvider><Panel /></AgentNavProvider></div>}
      {state.scene === 'replace-project' && <div data-fixture="replace"><InboxReplaceConfirm id="intake" current="triage" onConfirm={noop} close={noop} /></div>}
      {state.scene === 'replace-agent' && <div data-fixture="replace"><InboxReplaceConfirm id="triage" current="intake" onConfirm={noop} close={noop} /></div>}
    </div>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Scenes />)
