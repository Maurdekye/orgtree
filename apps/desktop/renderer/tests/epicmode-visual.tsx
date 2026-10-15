// EPIC Mode visual fixture (browser bundle) for tools/rig/epic-mode-visual.mjs.
//
// ?scene=switch — the REAL App settings panel on its Developer tab, against a
//   synthetic preference bridge and fetch stub, so the capture shows the
//   secret switch exactly as the app draws it (off, hovered, on).
// ?scene=stage — a small synthetic org chart drawn with the app's own card classes,
//   and the real EPIC director on top of it (silent: no AudioContext), so the
//   capture can cue each effect at a card and photograph it mid-flight.
// No engine, no live data, no network: every request is answered here.
import '../src/styles.css'
import '../src/shell.css'
import { createRoot } from 'react-dom/client'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { AccountsPanel } from '../src/canvas/accounts'
import { startEpic } from '../src/epic/director'
import type { EpicShow, Kind } from '../src/epic/director'
import type { EpicEvent } from '../src/epic/diff'

type Prefs = Record<string, unknown>
let saved: Prefs = { visualTheme: 'orgtree', visualThemeExplicit: true, contrastTheme: 'charcoal', agentColorSource: 'provider' }
const listeners = new Set<(e: { type: string; data: unknown }) => void>()
;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
  getPreferences: async () => saved,
  setPreferences: async (patch: Prefs) => {
    saved = { ...saved, ...patch }
    for (const fn of [...listeners]) fn({ type: 'preferences', data: saved })
    return saved
  },
  onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}

const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
const unknown: string[] = []
;(window as unknown as { __unknown: string[] }).__unknown = unknown
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const p = new URL(String(input), location.href).pathname
  const is = (route: string) => p === route || p.endsWith(route)
  const method = init?.method ?? 'GET'
  if (is('/api/app/records')) return answer({ detail: 'fixture' }, 501)
  if (is('/api/accounts')) return answer({ version: 2, primary: null, keys: [], assignments: {}, accounts: [] })
  if (is('/api/providers')) return answer({ providers: [] })
  if (is('/api/app-settings/runtime') && method === 'GET') return answer({ warming_enabled: true, verbose_logging: false, verbose_logging_pinned: false })
  unknown.push(`${method} ${p}`)
  return answer({ detail: 'not in the fixture' }, 404)
}) as typeof fetch
/** a contrast theme set the way the app sets it: stored, then applied, so the
 *  app's own contrast sync keeps it through every later preference broadcast */
;(window as unknown as { __contrast: (t: string) => void }).__contrast = (theme: string) => {
  saved = { ...saved, contrastTheme: theme }
  applyContrast(theme)
}

applyTheme('orgtree')
// ?scene=… rather than #…: a hash change is a same-document navigation and
// would never re-run this bundle
const scene = new URLSearchParams(location.search).get('scene') || 'switch'
const root = createRoot(document.getElementById('root')!)

const CARDS: { id: string; x: number; y: number; tier: string; prov: string; status: string }[] = [
  { id: 'boss', x: 438, y: 70, tier: 'opus', prov: 'claude', status: 'working' },
  { id: 'alice', x: 170, y: 290, tier: 'sonnet', prov: 'claude', status: 'idle' },
  { id: 'bob', x: 438, y: 290, tier: 'sol', prov: 'openai', status: 'working' },
  { id: 'carol', x: 706, y: 290, tier: 'haiku', prov: 'claude', status: 'idle' },
  { id: 'dave', x: 304, y: 500, tier: 'wonder', prov: 'muse', status: 'new' },
  { id: 'erin', x: 572, y: 500, tier: 'argon', prov: 'google', status: 'idle' },
]

function FakeOrg() {
  const wire = (a: string, b: string) => {
    const p = CARDS.find(c => c.id === a)!, q = CARDS.find(c => c.id === b)!
    return <path key={a + b} d={`M${p.x + 62},${p.y + 124} C${p.x + 62},${p.y + 170} ${q.x + 62},${q.y - 46} ${q.x + 62},${q.y}`}
      stroke="var(--line)" strokeWidth="2" fill="none" />
  }
  return (
    <div className="viewport" data-pin-org="acme" style={{ position: 'fixed', inset: 0, borderRadius: 0 }}>
      <div className="canvas-bg" />
      <div className="space" style={{ transform: 'translate(0px, 0px) scale(1)' }}>
        <svg className="edges" width="1000" height="700" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
          {wire('boss', 'alice')}{wire('boss', 'bob')}{wire('boss', 'carol')}{wire('alice', 'dave')}{wire('carol', 'erin')}
        </svg>
        {CARDS.map(c => (
          <div key={c.id} className={`sq live norm proc-warm tier-${c.tier} prov-${c.prov}`} data-first-use-agent={c.id}
            style={{ transform: `translate(${c.x}px, ${c.y}px)`, width: 124, height: 124 }}>
            <b style={{ color: 'var(--ink-strong)', fontSize: 14 }}>{c.id}</b>
            <span style={{ color: 'var(--dim)', fontSize: 11 }}>{c.tier} · {c.prov}</span>
            <span style={{ color: 'var(--provider-accent)', fontSize: 11, marginTop: 'auto' }}>{c.status}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

declare global {
  interface Window {
    __epic?: {
      show: EpicShow | null
      start(greet?: 'enable' | 'launch' | 'none'): void
      cue(kind: Kind, ev?: Partial<EpicEvent>): void
      stop(farewell?: boolean): void
      ready: boolean
    }
  }
}

if (scene === 'switch') {
  root.render(<AccountsPanel toast={() => {}} close={() => {}} initialTab="developer" />)
} else {
  root.render(<FakeOrg />)
  const api: NonNullable<Window['__epic']> = {
    show: null,
    ready: false,
    start(greet = 'none') { api.show?.stop(); api.show = startEpic({ audio: null, greet }) },
    cue(kind, ev = {}) { api.show?.cue(kind, ev) },
    stop(farewell = false) { api.show?.stop({ farewell }); api.show = null },
  }
  window.__epic = api
  requestAnimationFrame(() => { api.ready = true })
}
