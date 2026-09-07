import { DraftScopeModal } from '../src/canvas/modals'
import type { DraftState } from '../src/canvas/shared'
import { preserveRemovedDrafts } from '../src/draftstore'
import { AdvancedOrgModal } from '../src/App'
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ModalOverPins, PinFrame } from '../src/canvas/modalpin'
import { ConfirmModal } from '../src/canvas/modals'
import { FolderPickerHost, pickFolder } from '../src/picker'
import { CurrentOrg, foreignSurfaceEvent, RestartNotice, useOrgTransition } from '../src/popout'
import { getChat } from '../src/api'
import { backendRestart, openSurfaces } from '../src/windowlife'
import { DeskHosts } from '../src/canvas/deskhosts'
import { DeskChat } from '../src/canvas/desk'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import type { TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
let mounts = 0
function Draft() {
  const [text, setText] = useState('')
  const [sends, setSends] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [folder, setFolder] = useState('')
  useEffect(() => { mounts++; return () => { mounts-- } }, [])
  return <><input aria-label="Uncontrolled" defaultValue="kept" />
    <textarea aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />
    <button onClick={() => setSends((v) => v + 1)}>Send fixture</button>
    <output data-sends>{sends}</output><div data-scroll style={{ height: 90, overflow: 'auto' }}>
      <div style={{ height: 1200 }}>scroll content</div></div>
    <button onClick={() => setConfirm(true)}>Confirm fixture</button>
    <button onClick={() => { void pickFolder().then((r) => setFolder(r.path ?? 'cancelled')) }}>Pick fixture folder</button>
    <output data-folder>{folder}</output>
    <div className="md"><img alt="Fixture image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style={{ width: 30, height: 30 }} /></div>
    {confirm && <ModalOverPins><ConfirmModal title="Fixture confirmation" body="Keep the draft" close={() => setConfirm(false)}
      confirmLabel="Confirm once" onConfirm={() => { setSends((v) => v + 1); setConfirm(false) }} /></ModalOverPins>}
  </>
}
function Fixture() {
  const [bubble, setBubble] = useState(0)
  const [capture, setCapture] = useState(0)
  const [open, setOpen] = useState(true)
  return <div onClick={() => setBubble((v) => v + 1)}
    onPointerDownCapture={(e) => { if (!foreignSurfaceEvent(e)) setCapture((v) => v + 1) }}>
    <output data-bubble>{bubble}</output><output data-capture>{capture}</output>
    {open && <PinFrame kind="fixture" title="Fixture" panel="settings" close={() => setOpen(false)}><Draft /></PinFrame>}
    <FolderPickerHost />
  </div>
}
let serverInstance = 'first'
const requests: string[] = []
Object.assign(window, { probe: { mounts: () => mounts, surfaces: openSurfaces, restart: backendRestart,
  api: () => getChat('fixture', 'builder'), apiRestart: () => { serverInstance = 'second'; return getChat('fixture', 'builder') }, requests } })
function TransitionFixture() {
  const [slug, setSlug] = useState<string | null>('fixture')
  const transition = useOrgTransition(slug, setSlug, '')
  useEffect(() => {
    const pop = () => transition.request(location.pathname.split('/o/')[1] ?? null)
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [transition.request])
  return <CurrentOrg.Provider value={slug}>
    <output data-org>{slug}</output><button onClick={() => transition.request('other')}>Other organization</button>
    {transition.prompt}<RestartNotice /><Fixture />
  </CurrentOrg.Provider>
}
function DeskFixture() {
  const [shown, setShown] = useState(true)
  const [gone, setGone] = useState(false)
  const [generation, setGeneration] = useState(4)
  const node = React.useMemo(() => ({ id: 'builder', title: 'builder', tier: 'haiku', model_id: 'haiku',
    state: location.search.includes('retired') ? 'archived' : 'live', parent: 'user', seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0,
    occupancy: null, context_window: null, charter: null, mail_pending: 0,
    limit_locked: false, last_status: null, prev_status: null, inflight_at: null,
    last_denials: [], turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: location.search.includes('missinggen') ? undefined : generation, children: [], lineage: [], scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }) as unknown as CanvasNode, [generation])
  const map = React.useMemo(() => gone ? new Map<string, CanvasNode>() : new Map([['builder', node]]), [node, gone])
  Object.assign(window, { deskProbe: { remove: () => { setGone(true); setShown(false); preserveRemovedDrafts('fixture', new Map()) }, namesake: () => { setGone(false); setShown(true) }, navigate: () => setShown(false), return: () => setShown(true), generation: () => setGeneration((v) => v + 1) } })
  return <DeskHosts map={map} slug="fixture"><div style={{ height: 700, width: 850 }}>
    {shown && <DeskChat bare node={node} map={map} slug="fixture" pub={location.search.includes('public')}
      toast={() => {}} op={async () => ({})} onJump={() => setShown(true)} />}
  </div></DeskHosts>
}
function CanvasFixture() {
  const [activeSlug, setActiveSlug] = useState('fixture')
  const [focusAgent, setFocusAgent] = useState<string | null>('builder')
  const [tree, setTree] = useState(() => ({
    slug: 'fixture', name: 'Fixture', roots: [{ id: 'builder', title: 'builder', tier: 'haiku', model_id: 'haiku',
      state: 'live', session_id: 'stable-canvas-session', seat: 1, grant: 5, free: 5, generation: 4, children: [], lineage: [],
      scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
      audiences_held: [], bearer_state: null, cost_usd: 0, turns: [], last_denials: [],
      last_status: null, prev_status: null, occupancy: null, context_window: null, frozen: null }],
    tiers: { haiku: 1 }, audience_requests: [], credit_requests: [], audiences: [],
    workspace: null, dirs: [], audit: { live_nodes: 1, top_level_holds: 6, no_overdraft: true, problems: [] },
    max_top_grant: 100, default_top_grant: 5, compact_at: 0, cost_usd_total: 0,
    user_inbox_count: 0, org_inbox: null, net: null,
  }) as unknown as TreePayload)
  Object.assign(window, { canvasProbe: { beginOrg: () => setActiveSlug('other'), finishOrg: () => { setTree({ ...tree, slug: 'other', roots: [{ ...tree.roots[0]!, id: 'new-agent', title: 'new-agent', generation: 7, session_id: 'other-session' }] }); setFocusAgent('new-agent') }, payloadRename: (to: string) => setTree({ ...tree, roots: [{ ...tree.roots[0]!, id: to, title: to }] }), rename: (to: string) => {
    const from = tree.roots[0]!.id
    window.dispatchEvent(new CustomEvent('orgtree:rename', { detail: { slug: 'fixture', renames: { [from]: to } } }))
    setTree({ ...tree, roots: [{ ...tree.roots[0]!, id: to, title: to }] })
  } } })
  return <CurrentOrg.Provider value={activeSlug}><div style={{ height: '100vh', display: 'flex' }}>
    <OrgCanvas tree={tree} slug={activeSlug} mailEvt={null} op={async () => ({})} toast={() => {}}
      focusAgent={focusAgent} onFocusAgentHandled={() => setFocusAgent(null)} />
  </div></CurrentOrg.Provider>
}
window.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    const data = url.includes('/chat') ? { messages: [], total: 0, busy: false, pending_mail: [], session_id: 'fixture', node: 'builder' }
      : url.includes('work-items') ? { items: [], counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
        : url.includes('/upload') ? { path: 'uploads/fixture.txt', bytes: 7 }
          : url.includes('/files') ? { files: [] }
          : url.includes('/api/fs') ? { path: 'C:/fixture', dirs: [], parent: null, home: 'C:/' } : {}
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'X-Orgtree-Instance': serverInstance } })
  }) as typeof fetch
createRoot(document.getElementById('root')!).render(location.search.includes('advanced')
  ? <AdvancedOrgModal title="New organization" close={() => {}}><Draft /></AdvancedOrgModal>
  : location.search.includes('scope') ? <div style={{ transform: 'scale(0.4)', width: 900 }}><DraftScopeModal
    draft={{ parent: null, tier: 'haiku' } as DraftState} map={new Map()} tree={{ dirs: [] } as unknown as TreePayload}
    scope={null} onSave={() => {}} close={() => {}} /></div>
  : location.search.includes('desk') ? <DeskFixture />
  : location.search.includes('canvas') ? <CanvasFixture />
    : location.search.includes('transition') ? <TransitionFixture /> : <Fixture />)
