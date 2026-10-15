// EPIC Mode visual fixture (browser bundle) for tools/rig/epic-mode-visual.mjs.
//
// ?scene=switch — the REAL App settings panel on its Developer tab, against a
//   synthetic preference bridge and fetch stub, so the capture shows the
//   secret switch exactly as the app draws it (off, hovered, on).
// ?scene=stage — a small synthetic org chart drawn with the app's own card classes,
//   and the real EPIC director on top of it (silent: no AudioContext), so the
//   capture can cue each effect at a card and photograph it mid-flight.
// ?scene=typing&z=…&tx=…&ty=… — desks with the app's composer classes for the
//   caret check (docket epic-mode-typing-effects-desync-in-canvas-desks): two
//   on the canvas, nested the way the app nests them, and one pinned to
//   screen space. Every effect the director places at a caret is recorded
//   with where the caret really is and where its sparks were drawn.
// No engine, no live data, no network: every request is answered here.
import '../src/styles.css'
import '../src/shell.css'
import type { CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { AccountsPanel } from '../src/canvas/accounts'
import { startEpic } from '../src/epic/director'
import type { EpicShow, Kind } from '../src/epic/director'
import { Stage } from '../src/epic/stage'

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
// every word the stage paints, so a capture can say what was on screen
const drawn: string[] = []
;(window as unknown as { __drawn: string[] }).__drawn = drawn
const fillText = CanvasRenderingContext2D.prototype.fillText
CanvasRenderingContext2D.prototype.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, max?: number) {
  if (!drawn.includes(text)) drawn.push(text)
  return max === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, max)
}
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

/** .desk-inner's own scale: `scale(calc(0.13333 * var(--desk-dpi, 1)))` */
const DESK_SCALE = 0.13333
/** two desks on the canvas, bob's at a larger text size (--desk-dpi), and
 *  carol's pinned: each composer says how many screen px a px of it is */
const TYPING_DESKS = [{ id: 'alice', x: 0, dpi: 1 }, { id: 'bob', x: 130, dpi: 1.5 }]

function TypingOrg({ z, tx, ty }: { z: number; tx: number; ty: number }) {
  return (
    <div className="viewport" data-pin-org="acme" style={{ position: 'fixed', inset: 0, borderRadius: 0 }}>
      <div className="canvas-bg" />
      <div className="space" style={{ transform: `translate(${tx}px, ${ty}px) scale(${z})` }}>
        {TYPING_DESKS.map(d => (
          <div key={d.id} className="sq desk live tier-opus prov-claude" data-first-use-agent={d.id}
            style={{ transform: `translate(${d.x}px, 0px)`, width: 124, height: 124 }}>
            <div className="desk-over">
              <div className="desk-inner desk-body" style={{ '--desk-dpi': String(d.dpi) } as CSSProperties}>
                <div className="cc-composer">
                  <textarea rows={2} data-first-use-chat={d.id} data-scale={String(z * DESK_SCALE * d.dpi)} />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="pinwin prov-openai" data-id="carol" style={{ left: 500, top: 450, width: 460, height: 240 }}>
        <div className="pinwin-title">carol</div>
        <div className="pinwin-body">
          <div className="desk-body eye-chat">
            <div className="cc-composer"><textarea rows={2} data-first-use-chat="carol" data-scale="1" /></div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface CaretRecord {
  kind: Kind
  desk: string | null
  value: string
  caret: number
  /** where the director put the effect */
  x: number
  y: number
  /** where the caret really is */
  tx: number
  ty: number
  /** where the effect's sparks were drawn */
  drawn: { x: number; y: number }[]
  /** when it was cued (ms, the page's clock) */
  t: number
}

/** Where the caret really is: the text before it laid out by the browser in
 *  the field's own font, in an unscaled probe, carried onto the screen by the
 *  scale the fixture itself applied (data-scale), never by anything measured
 *  from the field's transformed box — independent of how the director
 *  estimates it. */
function trueCaret(field: HTMLTextAreaElement): { x: number; y: number } {
  const s = Number(field.dataset.scale)
  const style = getComputedStyle(field)
  const lines = field.value.slice(0, field.selectionStart ?? field.value.length).split('\n')
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre'
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
    'fontKerning', 'fontFeatureSettings', 'letterSpacing', 'wordSpacing'] as const) probe.style[p] = style[p]
  probe.textContent = lines[lines.length - 1] ?? ''
  document.body.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  const box = field.getBoundingClientRect()
  return {
    x: box.left + s * (field.clientLeft + parseFloat(style.paddingLeft) + width - field.scrollLeft),
    y: box.top + s * (field.clientTop + parseFloat(style.paddingTop) + (lines.length - 0.5) * parseFloat(style.lineHeight) - field.scrollTop),
  }
}

const CARET_KINDS: ReadonlySet<Kind> = new Set<Kind>(['type', 'enter', 'erase'])
const carets: CaretRecord[] = []
let drawing: CaretRecord | null = null
const burst = Stage.prototype.burst
Stage.prototype.burst = function (this: Stage, ...args: Parameters<Stage['burst']>) {
  drawing?.drawn.push({ x: args[0], y: args[1] })
  return burst.apply(this, args)
}
/** record every effect the director places at a caret */
function recordCarets(show: EpicShow): void {
  const cue = show.cue.bind(show)
  show.cue = (kind, ev = {}) => {
    const field = ev.spot?.el
    if (!CARET_KINDS.has(kind) || !ev.spot || !(field instanceof HTMLTextAreaElement)) return cue(kind, ev)
    const truth = trueCaret(field)
    const record: CaretRecord = { kind, desk: field.getAttribute('data-first-use-chat'), value: field.value,
      caret: field.selectionStart ?? -1, x: ev.spot.x, y: ev.spot.y, tx: truth.x, ty: truth.y, drawn: [], t: performance.now() }
    carets.push(record)
    drawing = record
    try { cue(kind, ev) } finally { drawing = null }
  }
}

declare global {
  interface Window {
    __epic?: {
      show: EpicShow | null
      start(greet?: 'enable' | 'launch' | 'none'): void
      cue(kind: Kind, ev?: Parameters<EpicShow['cue']>[1]): void
      stop(farewell?: boolean): void
      ready: boolean
    }
    __typing?: {
      carets: CaretRecord[]
      /** pan the camera by (dx, dy) screen px, the way a drag moves `.space` */
      pan(dx: number, dy: number): void
      /** the stage canvas's box: it must be the window's */
      stageBox(): { left: number; top: number; width: number; height: number } | null
    }
  }
}

if (scene === 'switch') {
  root.render(<AccountsPanel toast={() => {}} close={() => {}} initialTab="developer" />)
} else {
  const params = new URLSearchParams(location.search)
  const typing = scene === 'typing'
  const camera = { z: Number(params.get('z') || 1), tx: Number(params.get('tx') || 0), ty: Number(params.get('ty') || 0) }
  root.render(typing ? <TypingOrg {...camera} /> : <FakeOrg />)
  const api: NonNullable<Window['__epic']> = {
    show: null,
    ready: false,
    start(greet = 'none') {
      api.show?.stop()
      api.show = startEpic({ audio: null, greet })
      if (typing) recordCarets(api.show)
    },
    cue(kind, ev = {}) { api.show?.cue(kind, ev) },
    stop(farewell = false) { api.show?.stop({ farewell }); api.show = null },
  }
  window.__epic = api
  if (typing) {
    window.__typing = {
      carets,
      pan(dx, dy) {
        camera.tx += dx
        camera.ty += dy
        document.querySelector<HTMLElement>('.space')!.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.z})`
      },
      stageBox() {
        const r = document.querySelector('canvas.epic-stage')?.getBoundingClientRect()
        return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
      },
    }
  }
  requestAnimationFrame(() => { api.ready = true })
}
