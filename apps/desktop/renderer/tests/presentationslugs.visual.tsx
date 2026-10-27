// presentationslugs.visual.tsx — the capture for presentations identified by a readable slug (USER 2026-10-27
// m4efbc12ac94e) and its two companions: a presentation mention shows the presentation's current title
// (m7bb9eb904138), also for an old generic id, and the composer's @ list offers presentations by title with the
// document icon (mb21c096e5dc4). An agent desk whose transcript mentions a presentation by its slug and another by
// its old id; its composer then completes "@weekly". The desk, its transcript, chips and composer are the app's
// own; browser-only fixture data, no engine, bridge or live org.
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
import type { CanvasNode, OpFn } from '../src/canvas/shared'
import '../src/styles.css'

const text = 'The launch plan is in @doc:org/launch-plan, and last week\'s numbers in @doc:org/d00000000c001 '
  + '(a link written before presentations had slugs).'
const message = { role: 'assistant', seq: 0, event_id: 'r-1', at: '2026-10-27T09:05:00.000Z', text }
/** the gallery after migration 0073: slugs, and the old ids they had */
const docs = [
  { id: 'weekly-status-2', title: 'Weekly status, week 44', format: 'markdown', node: 'boss' },
  { id: 'launch-plan', title: 'Launch plan for the 4.5.0 release', format: 'html', node: 'boss' },
  { id: 'weekly-status', title: 'Weekly status, week 43', format: 'markdown', node: 'boss' },
]
const old: Record<string, string> = { d00000000c001: 'weekly-status' }
const lookups: string[] = []

window.fetch = (async (url: RequestInfo | URL) => {
  const p = String(url)
  const u = new URL(p, 'http://fixture.invalid')
  lookups.push(u.pathname + u.search)
  const refs = u.searchParams.get('refs'), search = u.searchParams.get('search')
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const payload = /\/documents$/.test(u.pathname) && refs !== null
    ? { refs: refs.split(',').flatMap(ref => docs.filter(d => d.id === (old[ref] ?? ref)).map(d => ({ ref, id: d.id, title: d.title, format: d.format }))) }
    : /\/documents$/.test(u.pathname) && search !== null
      ? { documents: docs.filter(d => words.every(w => `${d.title} ${d.id}`.toLowerCase().includes(w))) }
      : /\/chat(?:\?|$)/.test(p) ? { busy: false, queued: 0, responding: false, last_error: null,
        messages: [message], live: [], draft_epoch: 'fixture:0', mail_pending: 0, pending_mail: [] }
        : /\/work-items-page/.test(p) ? { format: 'orgtree.work-page/v1', rows: [], total: 0, next_offset: null, revision: 'r0', at: '2026-10-27T09:00:00Z' }
          : /\/work-items/.test(p) ? { items: [], archived: [], backlogged: [], references: [], attention: [],
            counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } }
            : /\/apps$/.test(u.pathname) ? { kind: 'apps', items: [], next_cursor: null, new_count: 0 }
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
const boss = node('boss', USER, { tier: 'sol', children: [dev1],
  last_status: { status: 'working', summary: 'Preparing the release notes.' } })
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
    Object.assign(window, { presentationSlugsVisual: {
      themes: Object.keys(THEMES).slice(0, 2),
      labels: Object.fromEntries(Object.entries(THEMES).map(([id, t]) => [id, t.label])),
      apply: (visual: string) => { applyTheme(visual) },
      lookups: () => [...lookups],
      /** type into the desk composer as a person would: the value, then the caret at its end */
      type: (value: string) => {
        const box = document.querySelector<HTMLTextAreaElement>('[data-fixture="agent-desk"] textarea[data-first-use-chat]')!
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
        box.dispatchEvent(new Event('input', { bubbles: true }))
        box.focus()
        box.setSelectionRange(value.length, value.length)
        box.dispatchEvent(new Event('select', { bubbles: true }))
        return true
      },
      press: (key: string) => {
        const box = document.querySelector<HTMLTextAreaElement>('[data-fixture="agent-desk"] textarea[data-first-use-chat]')!
        box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        return box.value
      },
    } })
  }, [])
  return <CurrentOrg.Provider value="org">
    <AgentNavProvider><ObjectNavProvider><AgentMenus />
      <ObjectNavHost org="org" dogs={[]} openDog={noop} openTicket={noop} openDocument={noop} toast={noop} />
      <ObjectMenuBoundary>
        <DeskHosts map={map} slug="org" treeSlug="org">
          <DeskDogsProvider value={{ dogs: [], slotLeases: [], open: noop }}>
            <div style={{ width: 760, height: 480, display: 'flex', padding: 8 }} data-fixture="agent-desk">
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
