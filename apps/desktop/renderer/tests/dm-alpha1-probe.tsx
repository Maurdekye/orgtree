// The page dm-alpha1-visual.mjs captures: the user's chats over a synthetic
// organization built for the points of the 4.7.0-alpha.1 feedback (USER
// 2026-11-24 m15c78be3a1db and after). Beside the panel it can show the two
// things the chats must match, each the app's own component: the desk's
// message box (`DeskChat`) and the canvas's agents list (`AgentTray` in its
// `.tray-panel`). Every engine request goes to the driver's fake engine.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { UserMailbox } from '../src/App'
import { CurrentOrg } from '../src/popout'
import { applyContrast } from '../src/contrast'
import { syncFastModes } from '../src/canvas/fastmode'
import { DeskChat } from '../src/canvas/desk'
import { AgentTray, trayRows } from '../src/canvas/agenttray'
import { dmNodes } from '../src/dm/model'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const node = (id: string, tier: string, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id, title: id, tier, model_id: tier, state: 'live', seat: 2, grant: 4, free: 2, ui_order: 0, cost_usd: 0,
  occupancy: 0.31, context_window: 200000, charter: `${id} keeps its part of the synthetic organization.`,
  mail_pending: 0, limit_locked: false, last_status: { status: 'idle', summary: `${id} finished its last piece and is standing by`, at: new Date().toISOString() },
  prev_status: null, inflight_at: null, last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 1, busy: false, children, lineage: [],
  scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team', effort: 'medium' },
  configured_scope: { tools: {}, add_dirs: [] }, ...extra,
})
const own = { audiences_held: ['@user'], audiences_explicit: ['@user'] }

/** names as long as a real organization's, nested as deep */
const tree = (): TreePayload => ({
  slug: 'mine', name: 'Synthetic', tiers: { opus: { name: 'Opus' }, sonnet: { name: 'Sonnet' }, haiku: { name: 'Haiku' } },
  roots: [
    node('interim-coordinator', 'sonnet', [
      node('liaison-opus', 'opus', [
        node('coordinator-opus', 'opus', [
          node('build-slot', 'opus', [node('build-sol', 'sonnet'), node('rig-sol-b', 'sonnet'), node('hubchat-web-fable', 'haiku')], { kind: 'project', tier: null }),
          node('quoter', 'opus', [], own),
          node('worker', 'sonnet', [], own),
          node('sparse', 'haiku', [], own),
          node('retired-one', 'haiku', [], { state: 'archived' }),
        ]),
      ]),
    ]),
  ],
  asks: [], asks_open: 0, user_inbox_count: 0, urgent_unread: 0,
  default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full', max_top_grant: 100, compact_at: 0.8,
}) as unknown as TreePayload

declare global {
  interface Window {
    __dm: {
      toasts: string[]; focused: string[]; closed: number; opened: unknown[]; confirms: number
      /** show the desk's own message box beside the panel */
      deskBox(on: boolean): void
      /** show the canvas's agents list beside the panel */
      canvasList(on: boolean): void
      theme(id: string): void
    }
  }
}

function Probe() {
  const [desk, setDesk] = useState(false)
  const [list, setList] = useState(false)
  const [t] = useState(tree)
  useEffect(() => { window.__dm.deskBox = setDesk; window.__dm.canvasList = setList }, [])
  const map = dmNodes(t) as unknown as Map<string, CanvasNode>
  const quoter = map.get('quoter')!
  return (
    <CurrentOrg.Provider value="mine">
      <UserMailbox slug="mine" tree={t} toast={lines => { window.__dm.toasts.push(...lines) }}
        close={() => { window.__dm.closed++ }} jumpTo={null} jumpSeq={null} openChat={null}
        onFocusAgent={id => { window.__dm.focused.push(id) }}
        onOpenMail={r => { window.__dm.opened.push(r) }} />
      {/* the desk's message box, alone: the rest of the desk is hidden so the two boxes can be read side by side */}
      {desk && <div className="alpha1-desk" data-alpha1="desk">
        <style>{`
          .alpha1-desk *:not(:has(.cc-composer)):not(.cc-composer):not(.cc-composer *):not(style):not(.alpha1-cap) { display: none !important; }
          .alpha1-desk *:has(.cc-composer) { display: block !important; height: auto !important; min-height: 0 !important; padding: 0 !important; margin: 0 !important; }
        `}</style>
        <div className="alpha1-cap">the desk's message box (canvas/desk.tsx)</div>
        <DeskChat node={quoter} map={map} slug="mine" bare op={async () => ({})} toast={() => {}} />
      </div>}
      {list && <div className="alpha1-list" data-alpha1="list">
        <div className="alpha1-cap">the canvas's agents list</div>
        <div className="tray-panel"><AgentTray map={map} rows={trayRows(map, {})} query="" onQuery={() => {}}
          archived={false} onArchived={() => {}} onPick={() => {}} compactAt={t.compact_at} showQueuedModelBadge={false} /></div>
      </div>}
    </CurrentOrg.Provider>
  )
}

window.__dm = { toasts: [], focused: [], closed: 0, opened: [], confirms: 0, deskBox() {}, canvasList() {}, theme: id => applyContrast(id) }
syncFastModes([{ tiers: [{ tier: 'opus', fast_mode: true }, { tier: 'sonnet', fast_mode: true }] }] as unknown as Parameters<typeof syncFastModes>[0])
window.confirm = () => { window.__dm.confirms++; return true }
createRoot(document.getElementById('root')!).render(<Probe />)
