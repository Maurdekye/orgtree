import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { draftKey } from '../src/draftstore'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'

// The project desk's message box with and without the inbox note
// (tests/projectinboxwarning-capture.cjs): `?case=none|attached|listened&theme=dark|light`.
// none: nobody listens on the inbox; attached: the same with a staged
// attachment and a draft, so the note rides between them and the box;
// listened: an armed fair_queue listener, so no note.
const noop = () => {}
const answer = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
window.fetch = ((input: RequestInfo | URL) => {
  const p = new URL(String(input), location.href).pathname
  if (p.endsWith('/inbox')) return answer({ pending: [], delivered: [], sent: [], next_cursor: null })
  return answer({})
}) as typeof fetch

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live', parent: 'website', seat: 1, grant: 0, free: 0,
  children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 0, last_status: null, busy: false, ...extra,
})
const website = {
  ...agent('website', { kind: 'project', tier: 'project', model_id: '', seat: 0, parent: 'boss' }),
  charter: '# The website\n\nDeploy from **main** only.', children: [agent('dev1'), agent('dev2')],
} as unknown as CanvasNode
const listener = { id: 'dev1/inbox', owner: 'dev1', name: 'inbox', kind: 'fair_queue', target: 'website', interval_s: 5,
  state: 'armed', at: '2026-10-20T11:00:00.000Z', fired: 0, once: false, spent: false }

const params = new URLSearchParams(location.search)
const which = params.get('case') ?? 'none'
document.documentElement.classList.toggle('contrast-light', params.get('theme') === 'light')
const key = draftKey('org', 'project:website', 0)
localStorage.clear()
if (which === 'attached') {
  localStorage.setItem(key, 'Please take the release notes.')
  localStorage.setItem(`${key}-attachments`, JSON.stringify([{ name: 'release-notes.md', path: 'C:/fixture/u0123456789ab-release-notes.md', bytes: 2048 }]))
}
const tree = { slug: 'org', roots: [], slot_leases: [], watchdogs: which === 'listened' ? [listener] : [] } as unknown as TreePayload
const map = new Map<string, CanvasNode>([[website.id, website], ...(website.children ?? []).map((c) => [c.id, c] as [string, CanvasNode])])
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(
  <main style={{ position: 'relative', width: 1000, height: 700, background: 'var(--bg)' }} data-case={which}>
    {/* a pinned window's body: the frame a bare project desk fills */}
    <div id="desk" className="pinwin-body"
      style={{ position: 'absolute', left: 20, top: 20, width: 620, height: 660, border: '1px solid var(--line)', boxSizing: 'border-box' }}>
      <ProjectDesk bare node={website} slug="org" tree={tree} map={map} op={() => Promise.resolve({} as OpResult)}
        toast={noop} refs={{ world: { org: 'org' }, onOpen: noop } as never} onJump={noop} onConfig={noop} />
    </div>
  </main>,
))
document.body.dataset.ready = 'true'
