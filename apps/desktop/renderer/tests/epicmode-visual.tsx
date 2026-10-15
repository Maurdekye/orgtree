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
// ?scene=wheel — the REAL canvas (OrgCanvas) with cto's desk pinned to screen
//   space and the agents list open, for real wheel input (docket
//   epic-mode-scrolling-a-pinned-window-on-the-canva): every wheel the page
//   receives is recorded with whether the canvas took it, the camera's zoom
//   and the scroll offsets before and after, and the effects the director
//   played for it. A filler after the pinned chat and the modal panels
//   stands in for a long conversation and a long docket, so they can scroll.
// No engine, no live data, no network: every request is answered here.
import '../src/styles.css'
import '../src/shell.css'
import type { CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { AccountsPanel } from '../src/canvas/accounts'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { addPin } from '../src/canvas/pins'
import { startEpic } from '../src/epic/director'
import type { EpicShow, Kind } from '../src/epic/director'
import { Stage } from '../src/epic/stage'
import type { TreePayload } from '../src/types'

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
  // a desk's conversation (the wheel scene's pinned desk): an idle agent with no messages yet
  if (/\/nodes\/[^/]+\/chat$/.test(p) && method === 'GET') return answer({ busy: false, responding: false, queued: 0, last_error: null,
    occupancy: null, messages: [], live: [], draft_epoch: 0, mail_pending: 0, pending_mail: [] })
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
      {/* the inbox bell, where mail to the user (and urgent mail) points */}
      <button className="ask-bell" style={{ position: 'absolute', right: 24, top: 18, width: 34, height: 34 }}>✉</button>
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

/* ── the wheel scene: the real canvas ─────────────────────────────────── */

/** a lead, five reports and four under each: enough rows that the agents list scrolls */
function wheelNode(id: string, children: unknown[] = []): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children, lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}
const WHEEL_TEAMS = ['cto', 'qa', 'ops', 'dev', 'ux']
const wheelTree = (): TreePayload => ({
  slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots: [wheelNode('ceo', WHEEL_TEAMS.map(t => wheelNode(t, [1, 2, 3, 4].map(i => wheelNode(`${t}-${i}`)))))],
  cost_usd_total: 0,
  audit: { live_nodes: 26, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true,
  audience_requests: [], org_inbox: null, net: null,
} as unknown as TreePayload)

function WheelOrg() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <OrgCanvas tree={wheelTree()} slug="mine" op={() => Promise.resolve({} as never)}
        toast={() => {}} mailEvt={null} />
    </div>
  )
}

interface WheelSeen {
  /** the event's time (the page's clock) */
  t: number
  deltaY: number
  deltaX: number
  target: string
  /** whether anything took the wheel (preventDefault): the canvas zooming */
  taken: boolean | null
  zoomBefore: number | null
  zoomAfter: number | null
  /** every element from the target up whose scroll offset moved, by 400 ms after */
  scrolled: { el: string; from: number; to: number }[]
}
interface WheelEffect { kind: Kind; n?: number; t: number }
const wheels: WheelSeen[] = []
const wheelEffects: WheelEffect[] = []
const WHEEL_KINDS: ReadonlySet<Kind> = new Set<Kind>(['zoomIn', 'zoomOut', 'scroll'])

const describe = (el: Element | null): string => !el ? '' : el.tagName.toLowerCase()
  + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map(c => '.' + c).join('')
const cameraZoom = (): number | null => {
  const m = /scale\(\s*([\d.e+-]+)\s*\)/.exec(document.querySelector<HTMLElement>('.viewport .space')?.style.transform ?? '')
  return m ? Number(m[1]) : null
}
const WHEEL_SCROLLERS = { chat: '.pinwin[data-id="cto"] .msgs', tray: '.tray', panel: '.overlay .settings' } as const
type WheelScroller = keyof typeof WHEEL_SCROLLERS

/** every wheel the page receives, and what it moved — measured here, apart
 *  from the director */
function recordWheels(): void {
  window.addEventListener('wheel', e => {
    const target = e.target instanceof Element ? e.target : null
    const chain: [Element, number, number][] = []
    for (let el = target; el; el = el.parentElement) chain.push([el, el.scrollTop, el.scrollLeft])
    const seen: WheelSeen = { t: e.timeStamp, deltaY: e.deltaY, deltaX: e.deltaX, target: describe(target),
      taken: null, zoomBefore: cameraZoom(), zoomAfter: null, scrolled: [] }
    wheels.push(seen)
    setTimeout(() => { seen.taken = e.defaultPrevented }, 0)
    setTimeout(() => {
      seen.zoomAfter = cameraZoom()
      seen.scrolled = chain.filter(([el, top, left]) => el.scrollTop !== top || el.scrollLeft !== left)
        .map(([el, top]) => ({ el: describe(el), from: top, to: el.scrollTop }))
    }, 400)
  }, { capture: true, passive: true })
}
/** every wheel effect the director plays */
function recordWheelEffects(show: EpicShow): void {
  const cue = show.cue.bind(show)
  show.cue = (kind, ev = {}) => {
    if (WHEEL_KINDS.has(kind)) wheelEffects.push(ev.n === undefined ? { kind, t: performance.now() } : { kind, n: ev.n, t: performance.now() })
    return cue(kind, ev)
  }
}

/** a free point on the canvas: on the world, off every card, panel and control */
function canvasPoint(): { x: number; y: number } | null {
  const vp = document.querySelector('.viewport')
  if (!vp) return null
  let best: { x: number; y: number; d: number } | null = null
  for (let y = 30; y < innerHeight - 20; y += 20) {
    for (let x = 30; x < innerWidth - 20; x += 20) {
      const hit = document.elementFromPoint(x, y)
      if (!hit || !vp.contains(hit)) continue
      if (hit.closest('.sq, .tray-wrap, .tray-panel, .pinwin, .pinwin-resize-frame, .overlay, .modalpin-over, button, a, input, textarea, [role="button"], .edge-jumps, .ctxmenu')) continue
      const d = Math.hypot(x - innerWidth * 0.5, y - innerHeight * 0.8)
      if (!best || d < best.d) best = { x, y, d }
    }
  }
  return best && { x: best.x, y: best.y }
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
    __wheel?: {
      /** the canvas, cto's pinned chat and the open agents list are all drawn */
      ready(): boolean
      zoom(): number | null
      /** a scroller's offset and range, or null when it is not on screen */
      scroller(which: WheelScroller): { top: number; max: number } | null
      setTop(which: WheelScroller, top: number): boolean
      /** where to wheel: a free point on the canvas, or the middle of a scroller */
      point(which: 'canvas' | WheelScroller): { x: number; y: number; hit: string } | null
      /** open cto's docket from its row in the agents list (the row menu's Open docket) */
      openDocket(): Promise<boolean>
      /** the wheels and effects recorded since the last take */
      take(): { wheels: WheelSeen[]; effects: WheelEffect[] }
    }
  }
}

if (scene === 'switch') {
  root.render(<AccountsPanel toast={() => {}} close={() => {}} initialTab="developer" />)
} else {
  const params = new URLSearchParams(location.search)
  const typing = scene === 'typing'
  const wheel = scene === 'wheel'
  const camera = { z: Number(params.get('z') || 1), tx: Number(params.get('tx') || 0), ty: Number(params.get('ty') || 0) }
  if (wheel) {
    // a long conversation and a long docket: room to scroll
    const filler = document.createElement('style')
    filler.textContent = `${WHEEL_SCROLLERS.chat}::after, ${WHEEL_SCROLLERS.panel}::after { content: ''; display: block; flex: none; height: 1400px; }`
    document.head.append(filler)
    addPin('mine', 'cto', { x: 560, y: 60, w: 410, h: 470 })
    recordWheels()
  }
  root.render(typing ? <TypingOrg {...camera} /> : wheel ? <WheelOrg /> : <FakeOrg />)
  const api: NonNullable<Window['__epic']> = {
    show: null,
    ready: false,
    start(greet = 'none') {
      api.show?.stop()
      api.show = startEpic({ audio: null, greet })
      if (typing) recordCarets(api.show)
      if (wheel) recordWheelEffects(api.show)
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
  if (wheel) {
    const el = (which: WheelScroller) => document.querySelector<HTMLElement>(WHEEL_SCROLLERS[which])
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    window.__wheel = {
      ready() {
        const toggle = document.querySelector<HTMLElement>('.tray-toggle')
        if (toggle && !document.querySelector('.tray')) toggle.click()
        return cameraZoom() !== null && !!el('chat') && !!el('tray')
      },
      zoom: cameraZoom,
      scroller(which) {
        const s = el(which)
        return s ? { top: s.scrollTop, max: s.scrollHeight - s.clientHeight } : null
      },
      setTop(which, top) {
        const s = el(which)
        if (s) s.scrollTop = top
        return !!s
      },
      point(which) {
        if (which === 'canvas') {
          const p = canvasPoint()
          return p && { ...p, hit: describe(document.elementFromPoint(p.x, p.y)) }
        }
        const s = el(which)
        if (!s) return null
        // over a row in the middle of the list, or inside the scroller's
        // visible box where nothing covers it (a desk's "jump to bottom"
        // badge floats over the top of its chat)
        const rows = which === 'tray' ? [...s.querySelectorAll('.tray-row')] : []
        const r = (rows[Math.floor(rows.length / 2)] ?? s).getBoundingClientRect()
        const b = s.getBoundingClientRect()
        const left = Math.max(r.left, b.left), right = Math.min(r.right, b.right)
        const top = Math.max(r.top, b.top), bottom = Math.min(r.bottom, b.bottom)
        for (const fy of [0.5, 0.75, 0.9, 0.3]) {
          for (const fx of [0.5, 0.25, 0.75]) {
            const x = Math.round(left + (right - left) * fx), y = Math.round(top + (bottom - top) * fy)
            const hit = document.elementFromPoint(x, y)
            if (hit && s.contains(hit)) return { x, y, hit: describe(hit) }
          }
        }
        return null
      },
      async openDocket() {
        const row = [...document.querySelectorAll('.tray-row')].find(r => r.querySelector('.tray-name')?.textContent === 'cto')
        if (!row) return false
        const box = row.getBoundingClientRect()
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 20, clientY: box.top + 8 }))
        await sleep(80)
        const item = () => [...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')].find(b => b.textContent === 'Open docket')
        // the entry may sit one level down, in a submenu that opens on hover
        for (const branch of document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch')) {
          if (item()) break
          branch.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          await sleep(60)
          if (!item()) branch.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
        }
        const open = item()
        if (!open) return false
        open.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        open.click()
        await sleep(300)
        return !!el('panel')
      },
      take: () => ({ wheels: wheels.splice(0), effects: wheelEffects.splice(0) }),
    }
  }
  requestAnimationFrame(() => { api.ready = true })
}
