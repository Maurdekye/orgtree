// mentionkinds.visual.tsx — the capture for USER 2026-10-27 m6d0cdc7a2be6 / m33e4a043b457 (every mention kind
// styled with its own icon on the left, like agent mentions) and m449dc0a35cbe (app and panel mentions): an
// agent desk whose transcript names an agent, a project, a docket item, a document, an app and a panel, in
// every visual theme and contrast. The desk, its transcript and its chips are the app's own; browser-only
// fixture data, no engine, bridge or live org.
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { CurrentOrg } from '../src/popout'
import { USER } from '../src/canvas/shared'
import { applyTheme, THEMES } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { CONTRAST_THEMES } from '../../../../packages/contracts/contrast-theme'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import '../src/styles.css'

const text = 'Plan for the release: @dev1 builds it and @crew ships it, tracked in @item:org/build-the-docs. '
  + 'The notes are in @doc:org/release-notes. Try the result in @app:org/notes, or in your own copy @panel:org/one.'
const message = { role: 'assistant', seq: 0, event_id: 'r-1', at: '2026-10-27T09:05:00.000Z', text }
const item = { slug: 'build-the-docs', title: 'Build the docs site from main', status: 'in_progress' }

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const u = new URL(p, 'http://fixture.invalid')
  const request = JSON.parse(u.searchParams.get('request') ?? '{}')
  const payload = /\/apps$/.test(u.pathname) && request.action === 'refs'
    ? { apps: (request.apps ?? []).includes('notes') ? [{ id: 'notes', name: 'Caption board', recent: 'Panel 2' }] : [],
      panels: (request.panels ?? []).includes('one') ? [{ id: 'one', app: 'notes', app_name: 'Caption board', label: 'Panel 1', open: false, running: false }] : [] }
    : /\/apps$/.test(u.pathname) ? { kind: 'apps', items: [], next_cursor: null, new_count: 0 }
    : /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false, last_error: null,
      messages: [message], live: [], draft_epoch: 'fixture:0', mail_pending: 0, pending_mail: [] }
    : /\/work-item-references/.test(p) ? { references: [{ ...item, parent: null, archived: false, rev: 1 }] }
    : /\/work-items\/[^/?]+$/.test(u.pathname) ? { item }
    : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
    : /\/documents\//.test(p) ? { id: 'release-notes', title: 'Release notes', format: 'markdown', body: '' }
    : /\/inbox/.test(p) ? { pending: [], delivered: [], sent: [] }
    : /\/transfers/.test(p) ? { transfers: [], next_cursor: null }
    : /\/history(?:\?|$)/.test(p) ? { items: [] } : { ok: true }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

const noop = () => {}
const op: OpFn = async () => ({}) as never
const node = (id: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, title: id, parent, tier: 'sonnet',
  state: 'live', generation: 0, busy: false, children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  turns: [], audiences_held: [], documents: [], ...extra }) as unknown as CanvasNode
const dev1 = node('dev1', 'boss', { tier: 'opus' })
const crew = node('crew', 'boss', { kind: 'project', tier: null })
const boss = node('boss', USER, { tier: 'sol', children: [dev1, crew],
  last_status: { status: 'working', summary: 'Coordinating the release.' } })
const eye = { id: USER, parent: null, tier: null, state: 'user', children: [boss] } as unknown as CanvasNode
const map = new Map<string, CanvasNode>()
const add = (n: CanvasNode) => { map.set(n.id, n); for (const c of n.children ?? []) add(c as CanvasNode) }
add(eye)

function AgentMenus() {
  useProvideAgentNav(() => [{ label: 'Focus', onSelect: noop }])
  return null
}

function Surface() {
  useEffect(() => {
    Object.assign(window, { mentionKindsVisual: {
      themes: Object.keys(THEMES), contrasts: [...CONTRAST_THEMES],
      labels: Object.fromEntries(Object.entries(THEMES).map(([id, t]) => [id, t.label])),
      apply: (visual: string, contrast: string) => { applyTheme(visual); applyContrast(contrast) },
    } })
  }, [])
  return <CurrentOrg.Provider value="org">
    <AgentNavProvider><ObjectNavProvider><AgentMenus />
      <ObjectNavHost org="org" dogs={[]} openDog={noop} openTicket={noop} openDocument={noop} toast={noop} />
      <ObjectMenuBoundary>
        <DeskHosts map={map} slug="org" treeSlug="org">
          <DeskDogsProvider value={{ dogs: [], slotLeases: [], open: noop }}>
            <div style={{ width: 760, height: 420, display: 'flex', padding: 8 }} data-fixture="agent-desk">
              <DeskSlot node={boss} map={map} slug="org" op={op} toast={noop} bare onJump={noop} onWorkLink={noop} onOpenDoc={noop} />
            </div>
          </DeskDogsProvider>
        </DeskHosts>
      </ObjectMenuBoundary>
    </ObjectNavProvider></AgentNavProvider>
  </CurrentOrg.Provider>
}
document.body.style.background = 'var(--bg)'
document.body.style.margin = '0'
createRoot(document.getElementById('root')!).render(<Surface />)
