// orginboxqueue.visual.tsx — captures for projects holding the org inbox
// (docket org-inbox-project-queue-outside-mail-queued-in-a; spec rev 2 §4 R2-R5).
// Real components, browser-only data: no engine, bridge, network or clipboard.
// API: window.oiVisual.show(scene, light)   scene = 'holders' | 'replace-project' | 'replace-agent'
//   holders:         the org inbox panel's holder row (an agent AND a project), the project desk header's
//                    "org inbox" chip with its revoke, and a project Mail tab follow-up row chip
//   replace-project: the drop-replace confirm when a PROJECT replaces an AGENT holder
//   replace-agent:   the same confirm when an AGENT replaces a PROJECT holder
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HeldAudienceChips } from '../src/canvas/desk'
import { AudienceHolderRows, QueueChip } from '../src/canvas/mail'
import { InboxReplaceConfirm } from '../src/canvas/inboxreplace'
import { CurrentOrg } from '../src/popout'
import { EXTERN, type CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'

// no network, no clipboard
const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })
;(window as unknown as { WebSocket: unknown }).WebSocket = class { onclose: (() => void) | null = null; close() { this.onclose?.() } }
window.fetch = (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

const noop = () => {}
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, tier: 'haiku', state: 'live', children: [],
  scope: { tools: {}, add_dirs: [] }, turns: [], documents: [], ...extra }) as unknown as CanvasNode
const intake = node('intake', { kind: 'project', tier: 'project', audiences_held: [EXTERN], audiences_explicit: [EXTERN] })
const triage = node('triage', { tier: 'opus' })
const map = new Map<string, CanvasNode>([['intake', intake], ['triage', triage]])

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
            label="org inbox audience holders" alert />
        </div>
        <div data-fixture="chip"><HeldAudienceChips slug="org" toast={noop} map={map} node={intake} /></div>
        <div data-fixture="followup"><QueueChip q={{ follow_up_to: 'u0123456789ab' }} /></div>
      </>}
      {state.scene === 'replace-project' && <div data-fixture="replace"><InboxReplaceConfirm id="intake" current="triage" onConfirm={noop} close={noop} /></div>}
      {state.scene === 'replace-agent' && <div data-fixture="replace"><InboxReplaceConfirm id="triage" current="intake" onConfirm={noop} close={noop} /></div>}
    </div>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
createRoot(document.getElementById('root')!).render(<Scenes />)
