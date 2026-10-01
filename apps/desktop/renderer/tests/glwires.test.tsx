// glwires.test.tsx — WebGL2 wires and sparks for the org view (docket
// `render-private-v3-org-view-wires-with-webgl2`, user ruling: WebGL2 inside
// Electron, org view only, SVG fallback).
//
//   §1  the style parsers read computed CSS and refuse what they cannot draw
//   §2  a spark sits where the SVG layer always put it
//   §3  geometry: tessellation, culling cover, svgOnly, unknown classes
//   §4  jsdom has no WebGL2: the SVG layer draws everything, no canvas
//   §5  the kill flag forces SVG even where GL could run
//   §6  GL mode: the layer receives the SAME wires the SVG layer draws
//   §7  GL mode: a spark burst does NOT re-render the whole canvas per frame
//   §8  a lost context falls back to SVG; restore returns only on success
//   §9  a style the layer cannot parse is a permanent fallback, not a guess
//   §10 a theme change re-reads the styles without waiting for a canvas render
//   §11 the real layer asks for hardware only: software GL / no context -> SVG
//   §12 a wire list the layer refuses sends every wire back to SVG
//   §13 a spent watchdog wire stays in SVG, where its CSS fade runs
//   §14 the SVG fallback draws audience lines in AND out in the old direction
//   §15 the GL canvas is never a hit target (styles.css)
//
// ⚠ WHAT jsdom CANNOT DO: run a shader. §6–§9 drive OrgCanvas against a FAKE
// layer through `__setGlWiresFactory`; the real WebGL2 path (compile, draw,
// pixels, context loss, --disable-gpu) is exercised in real Electron by the
// profiling harness recorded on the docket item.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs glwires

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Profiler } from 'react'
import {
  __setGlWiresFactory, buildWireGeometry, createWebGL2Layer, GL_WIRES_FLAG_KEY, parseCssColor, parseDash,
  parseDropShadows, sameWires, sparkPoint, tessellate, VERT_FLOATS,
} from '../src/canvas/glwires'
import type { CameraView, GlWiresHooks, GlWiresLayer, SparkLike, Wire, WireStyles } from '../src/canvas/glwires'
import { segD, segPoint, smooth } from '../src/canvas/shared'
import type { Seg } from '../src/canvas/shared'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { forgetPins } from '../src/canvas/pins'
import { intersectsViewport, pathBounds, worldViewport } from '../src/canvas/viewport'
import type { TreePayload } from '../src/types'

// ------------------------------------------------------------------ §1
test('§1 the style parsers read computed CSS and refuse what they cannot draw', () => {
  assert.deepEqual(parseCssColor('rgb(255, 0, 51)'), [1, 0, 0.2, 1])
  assert.deepEqual(parseCssColor('rgba(169, 194, 216, 0.5)')!.map(v => +v.toFixed(3)), [0.663, 0.761, 0.847, 0.5])
  assert.deepEqual(parseCssColor('rgb(0 0 0 / 50%)'), [0, 0, 0, 0.5])
  assert.deepEqual(parseCssColor('color(srgb 1 0.5 0 / 0.95)'), [1, 0.5, 0, 0.95])
  assert.deepEqual(parseCssColor('transparent'), [0, 0, 0, 0])
  assert.equal(parseCssColor('lab(50% 20 30)'), null, 'an unknown colour space is refused, not guessed')
  assert.equal(parseCssColor(''), null)

  assert.deepEqual(parseDropShadows('none'), [])
  assert.deepEqual(parseDropShadows('drop-shadow(rgba(169, 194, 216, 0.5) 0px 0px 3px)'),
    [{ color: parseCssColor('rgba(169, 194, 216, 0.5)'), blur: 3 }])
  const two = parseDropShadows('drop-shadow(color(srgb 1 0.5 0 / 0.95) 0px 0px 4px) drop-shadow(color(srgb 1 0.5 0 / 0.5) 0px 0px 9px)')
  assert.equal(two?.length, 2)
  assert.deepEqual(two!.map(s => s.blur), [4, 9])
  assert.equal(parseDropShadows('drop-shadow(rgb(0, 0, 0) 2px 0px 3px)'), null, 'an offset shadow is refused')
  assert.equal(parseDropShadows('blur(2px)'), null, 'any other filter is refused')

  assert.deepEqual(parseDash('none'), [0, 0])
  assert.deepEqual(parseDash('4px, 4px'), [4, 4])
  assert.deepEqual(parseDash('2px 6px'), [2, 6])
  assert.deepEqual(parseDash('5px'), [5, 5], 'an odd list repeats, as SVG does')
  assert.equal(parseDash('1px, 2px, 3px, 4px'), null, 'a longer pattern is refused')
})

// ------------------------------------------------------------------ §2
test('§2 a spark sits where the SVG layer always put it', () => {
  const seg: Seg & { rev: boolean } = { kind: 'c', rev: false,
    pts: [{ x: 0, y: 0 }, { x: 0, y: 52 }, { x: 100, y: 148 }, { x: 100, y: 200 }] }
  const back = { ...seg, rev: true }
  const sp: SparkLike = { id: 1, segs: [seg, back], start: 1000, segDur: 420 }
  // the formula OrgCanvas used inline before the extraction, term for term
  const old = (now: number) => {
    const el = (now - sp.start) / sp.segDur
    const i = Math.max(0, Math.min(sp.segs.length - 1, Math.floor(el)))
    const t = smooth(Math.max(0, Math.min(1, el - i)))
    const s = sp.segs[i]!
    return segPoint(s, s.rev ? 1 - t : t)
  }
  for (const now of [900, 1000, 1123, 1419, 1420, 1600, 1839, 2500]) {
    assert.deepEqual(sparkPoint(sp, now), old(now), `at ${now}`)
  }
})

// ------------------------------------------------------------------ §3
const line = (x0: number, y0: number, x1: number, y1: number): Seg => ({ kind: 'l', pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] })
test('§3 geometry: tessellation, culling cover, svgOnly, unknown classes', () => {
  const curve: Seg = { kind: 'c', pts: [{ x: 0, y: 0 }, { x: 0, y: 52 }, { x: 300, y: 148 }, { x: 300, y: 200 }] }
  const pts = tessellate(curve, 10)
  assert.deepEqual(pts[0], { x: 0, y: 0 }, 'a curve starts exactly on its first point')
  assert.deepEqual(pts[pts.length - 1], { x: 300, y: 200 }, 'and ends exactly on its last')
  assert.ok(pts.length > tessellate(curve, 40).length, 'a finer step gives more points')
  assert.equal(tessellate(line(0, 0, 50, 0), 1).length, 2, 'a straight line needs no subdivision')

  const idx = new Map([['edge', 0], ['edge peer', 1]])
  const one = buildWireGeometry([{ key: 'a', seg: line(0, 0, 100, 0), cls: 'edge' }], idx, 10, null)!
  assert.equal(one.verts.length, 2 * 2 * VERT_FLOATS, 'two points, two sides each')
  assert.equal(one.index.length, 6, 'one quad')
  assert.equal(one.verts[VERT_FLOATS - 1], 0, 'the style index rides every vertex')

  const far = buildWireGeometry([
    { key: 'near', seg: line(0, 0, 10, 0), cls: 'edge' },
    { key: 'far', seg: line(5000, 5000, 5010, 5000), cls: 'edge peer' },
    { key: 'spent', seg: line(0, 0, 10, 0), cls: 'edge tether wd spent', svgOnly: true },
  ], idx, 10, { x: -100, y: -100, w: 300, h: 300 })!
  assert.equal(far.drawn, 1, 'outside the cover is not uploaded, and svgOnly is never uploaded')

  assert.equal(buildWireGeometry([{ key: 'x', seg: line(0, 0, 1, 1), cls: 'edge mystery' }], idx, 10, null), null,
    'a class with no parsed style refuses the whole build rather than drawing it unstyled')

  const w1: Wire[] = [{ key: 'a', seg: line(0, 0, 1, 1), cls: 'edge' }]
  assert.ok(sameWires(w1, [{ key: 'a', seg: line(0, 0, 1, 1), cls: 'edge' }]))
  assert.ok(!sameWires(w1, [{ key: 'a', seg: line(0, 0, 1, 2), cls: 'edge' }]), 'a moved point is a change')
  assert.ok(!sameWires(w1, [{ key: 'a', seg: line(0, 0, 1, 1), cls: 'edge', frac: 0.5 }]), 'a draw-in fraction is a change')
})

// ---------------------------------------------------------- the real canvas
const agent = (id: string, children: unknown[] = [], state = 'live') => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state, seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children, lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
const SLUG = 'glwires'
const tree = (over: Partial<TreePayload> = {}): TreePayload => ({ slug: SLUG, name: SLUG, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [], tiers: { haiku: 1 },
  audiences: [{ grantor: 'a1', grantee: 'a3' }],
  roots: [agent('a1', [agent('a2'), agent('a3'), agent('a4', [], 'archived')])], cost_usd_total: 0,
  audit: { live_nodes: 4, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, spend_frozen: false,
  storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [], ...over } as unknown as TreePayload)

/** a fake layer that records what OrgCanvas hands it */
function fakeLayer(opts: { refuseWires?: boolean } = {}) {
  const log = { created: 0, wires: [] as Wire[], styles: null as WireStyles | null, draws: 0,
    lastView: null as CameraView | null, lastSparks: 0, hooks: null as GlWiresHooks | null, destroyed: 0 }
  __setGlWiresFactory((_canvas, hooks) => {
    log.created++; log.hooks = hooks
    const layer: GlWiresLayer = {
      setWires(w, s) { log.wires = w; log.styles = s; return !opts.refuseWires },
      draw(view, sparks) { log.draws++; log.lastView = view; log.lastSparks = sparks.length },
      resize() {},
      destroy() { log.destroyed++ },
    }
    return layer
  })
  return log
}

/** jsdom does not cascade styles.css into SVG, so the probes are answered
 *  here with what Chromium serialises for the real rules */
function stubProbeStyles(stroke = 'rgb(58, 64, 74)') {
  const g = globalThis as unknown as { getComputedStyle: (el: Element) => CSSStyleDeclaration; window: { getComputedStyle: unknown } }
  const real = g.getComputedStyle
  const fake = (el: Element) => {
    if (!el.hasAttribute?.('data-glprobe')) return real(el)
    const spark = el.getAttribute('data-glprobe') === '@spark'
    return { stroke, fill: spark ? 'rgb(255, 217, 168)' : 'none', strokeWidth: '1.6px', opacity: '0.8',
      strokeDasharray: 'none', filter: spark ? 'drop-shadow(rgba(255, 128, 0, 0.95) 0px 0px 4px)' : 'none' } as unknown as CSSStyleDeclaration
  }
  g.getComputedStyle = fake
  g.window.getComputedStyle = fake
  return () => { g.getComputedStyle = real; g.window.getComputedStyle = real }
}

/** mount with a MEASURED viewport (same technique as canvasanchor.test.tsx) */
const canvasEl = (tr: TreePayload, onCommit?: () => void) => (
  <Profiler id="c" onRender={() => onCommit?.()}>
    <OrgCanvas tree={tr} op={() => Promise.resolve({} as never)} slug={SLUG}
      toast={() => {}} mailEvt={null} />
  </Profiler>)
async function canvas(t: { after: (fn: () => void | Promise<void>) => void }, onCommit?: () => void, tr = tree()) {
  forgetPins(SLUG)
  const proto = HTMLElement.prototype
  const real = proto.getBoundingClientRect
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains('viewport')) {
      return { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON() {} } as DOMRect
    }
    return real.call(this)
  }
  const view = await mountView(canvasEl(tr, onCommit), el => el)
  t.after(async () => { proto.getBoundingClientRect = real; await view.unmount(); forgetPins(SLUG) })
  await inAct(async () => { await flush(10) })
  return view
}
const visiblePaths = (el: HTMLElement) =>
  [...el.querySelectorAll('svg.edges path')].filter(p => !p.hasAttribute('data-glprobe'))
const reset = () => { __setGlWiresFactory(null); localStorage.clear() }

test('§4 jsdom has no WebGL2: the SVG layer draws everything, no canvas', async (t) => {
  reset(); t.after(reset)
  const v = await canvas(t)
  assert.equal(v.el.querySelector('canvas.glwires'), null, 'no WebGL2 here, so no canvas is even mounted')
  const paths = visiblePaths(v.el)
  const classes = paths.map(p => p.getAttribute('class'))
  assert.ok(classes.includes('edge'), 'tree edges are drawn in SVG')
  assert.ok(classes.includes('edge faded'), 'the archived child keeps its faded class')
  assert.ok(classes.includes('edge aud-line'), 'and the audience line')
  assert.equal(v.el.querySelectorAll('[data-glprobe]').length, 0, 'no style probes outside GL mode')
})

test('§5 the kill flag forces SVG even where GL could run', async (t) => {
  reset(); t.after(reset)
  const log = fakeLayer()
  localStorage.setItem(GL_WIRES_FLAG_KEY, 'off')
  const v = await canvas(t)
  assert.equal(log.created, 0, 'the layer is never created')
  assert.equal(v.el.querySelector('canvas.glwires'), null)
  assert.ok(visiblePaths(v.el).length > 0, 'and the SVG layer draws')
})

test('§6 GL mode: the layer receives the SAME wires the SVG layer draws', async (t) => {
  reset(); t.after(reset)
  // what the SVG layer draws, as (d, class)
  const svgView = await canvas(t)
  const svgSet = visiblePaths(svgView.el).map(p => `${p.getAttribute('class')}|${p.getAttribute('d')}`).sort()
  await svgView.unmount()

  const log = fakeLayer()
  const restore = stubProbeStyles(); t.after(restore)
  const v = await canvas(t)
  assert.ok(v.el.querySelector('canvas.glwires'), 'the GL canvas is mounted')
  assert.equal(log.created, 1)
  assert.equal(visiblePaths(v.el).length, 0, 'no wire is drawn twice: SVG holds only the probes now')
  // The GL layer gets the UNCULLED list (the GPU clips; its own cover decides
  // uploads), the SVG layer culls with ViewportPath. So: every SVG path is in
  // the GL list, identically, and every GL-only wire is one SVG culled.
  const glAll = log.wires.filter(w => !w.svgOnly).map(w => ({ id: `${w.cls}|${segD(w.seg)}`, d: segD(w.seg) }))
  const vp = worldViewport(log.lastView!, 1000, 800)
  const glVisible = glAll.filter(w => { const b = pathBounds(w.d); return !b || intersectsViewport(b, vp) }).map(w => w.id).sort()
  assert.deepEqual(glVisible, svgSet, 'identical classes and identical geometry, wire for wire, for what is on screen')
  assert.ok(glAll.some(w => w.id.startsWith('edge peer|')), 'and the peer line SVG culled off-screen is still handed over')
  assert.ok(log.draws > 0, 'and it was drawn')
  assert.ok(log.lastView && log.lastView.z > 0, 'with the committed camera')
  const probes = [...v.el.querySelectorAll('[data-glprobe]')].map(p => p.getAttribute('data-glprobe'))
  assert.ok(probes.includes('@spark') && probes.includes('edge peer'), 'one probe per class in use, plus the spark')
  // the canvas never takes a press meant for a card or the pan
  const cv = v.el.querySelector('canvas.glwires')!
  assert.equal(cv.getAttribute('aria-hidden'), 'true')
  assert.ok(cv.nextElementSibling?.classList.contains('space'), 'it sits right under `.space`, where the SVG layer painted')
})

test('§7 GL mode: a spark burst does NOT re-render the whole canvas per frame', async (t) => {
  reset(); t.after(reset)
  const burst = async (onCommit: () => void) => {
    const v = await canvas(t, onCommit)
    const spark = (window as unknown as { __spark?: (a: string, b: string) => void }).__spark
    assert.ok(spark, 'the dev spark hook is installed')
    return { v, fire: async () => {
      await inAct(async () => { for (let i = 0; i < 6; i++) spark!('a1', i % 2 ? 'a2' : 'a3') })
      // real frames, one act() each: rAF is a 16ms timer in this harness, and
      // a single act() around the whole wait would batch every frame's
      // setFrame into ONE commit and hide exactly what is being measured
      for (let f = 0; f < 30; f++) await inAct(async () => { await new Promise(r => setTimeout(r, 17)) })
      await inAct(async () => { await flush(3) })
    } }
  }
  // SVG baseline: every animation frame is a commit
  let svgCommits = 0
  const svg = await burst(() => { svgCommits++ })
  const svgBefore = svgCommits
  await svg.fire()
  const svgDuring = svgCommits - svgBefore
  await svg.v.unmount()

  const log = fakeLayer()
  const restore = stubProbeStyles(); t.after(restore)
  let glCommits = 0
  const gl = await burst(() => { glCommits++ })
  const glBefore = glCommits, drawsBefore = log.draws
  await gl.fire()
  const glDuring = glCommits - glBefore
  const glDraws = log.draws - drawsBefore
  assert.ok(svgDuring >= 10, `POSITIVE CONTROL: under SVG a 500ms burst commits every frame (${svgDuring} commits)`)
  assert.ok(glDuring <= 2, `under WebGL2 the burst commits at most once or twice, not per frame (${glDuring} vs ${svgDuring})`)
  assert.ok(glDraws >= 10, `while the layer is drawn every frame straight from the loop (${glDraws} draws)`)
  assert.equal(log.lastSparks, 0, 'and the frame after the last spark expires clears it')
})

test('§8 a lost context falls back to SVG; restore returns only on success', async (t) => {
  reset(); t.after(reset)
  const log = fakeLayer()
  const restore = stubProbeStyles(); t.after(restore)
  const v = await canvas(t)
  assert.equal(visiblePaths(v.el).length, 0, 'GL is drawing')
  await inAct(async () => { log.hooks!.onLost(); await flush(3) })
  assert.ok(visiblePaths(v.el).length > 0, 'a lost context puts every wire back in SVG at once - never a blank view')
  await inAct(async () => { log.hooks!.onRestored(true); await flush(3) })
  assert.equal(visiblePaths(v.el).length, 0, 'a successful restore hands the wires back to GL')
  await inAct(async () => { log.hooks!.onLost(); await flush(3) })
  await inAct(async () => { log.hooks!.onRestored(false); await flush(3) })
  assert.ok(visiblePaths(v.el).length > 0, 'a restore that fails to re-initialise stays on SVG')
  assert.equal(v.el.querySelector('canvas.glwires'), null, 'and the canvas is retired for this mount')
})

test('§10 a theme change re-reads the styles without waiting for a canvas render', async (t) => {
  reset(); t.after(reset)
  // the harness exposes jsdom's window but not its MutationObserver as a
  // global; the hook (correctly) skips observing without one, so lend it
  const G = globalThis as unknown as { MutationObserver?: unknown; window: { MutationObserver: unknown } }
  const hadMO = 'MutationObserver' in G, prevMO = G.MutationObserver
  G.MutationObserver = G.window.MutationObserver
  t.after(() => { if (hadMO) G.MutationObserver = prevMO; else delete G.MutationObserver })
  const log = fakeLayer()
  let stroke = 'rgb(58, 64, 74)'
  const g = globalThis as unknown as { getComputedStyle: (el: Element) => CSSStyleDeclaration; window: { getComputedStyle: unknown } }
  const real = g.getComputedStyle
  const fake = (el: Element) => {
    if (!el.hasAttribute?.('data-glprobe')) return real(el)
    const spark = el.getAttribute('data-glprobe') === '@spark'
    return { stroke, fill: spark ? 'rgb(255, 217, 168)' : 'none', strokeWidth: '1.6px', opacity: '0.8',
      strokeDasharray: 'none', filter: 'none' } as unknown as CSSStyleDeclaration
  }
  g.getComputedStyle = fake; g.window.getComputedStyle = fake
  t.after(() => { g.getComputedStyle = real; g.window.getComputedStyle = real; document.documentElement.removeAttribute('style') })
  await canvas(t)
  assert.deepEqual(log.styles!.byClass.get('edge')!.color.slice(0, 3).map(v => Math.round(v * 255)), [58, 64, 74])
  // a theme sync rewrites CSS variables on <html>; nothing about OrgCanvas's
  // own props or state changes
  stroke = 'rgb(200, 10, 10)'
  await inAct(async () => { document.documentElement.setAttribute('style', '--line: #c80a0a'); await flush(5) })
  assert.deepEqual(log.styles!.byClass.get('edge')!.color.slice(0, 3).map(v => Math.round(v * 255)), [200, 10, 10],
    'the new wire colour reaches the GL layer')
})

test('§9 a style the layer cannot parse is a permanent fallback, not a guess', async (t) => {
  reset(); t.after(reset)
  const log = fakeLayer()
  const restore = stubProbeStyles('lab(50% 20 30)'); t.after(restore)
  const v = await canvas(t)
  assert.equal(log.created, 1, 'GL was tried')
  assert.ok(visiblePaths(v.el).length > 0, 'but an unreadable stroke colour sends every wire back to SVG')
  assert.equal(v.el.querySelector('canvas.glwires'), null)
})

// ------------------------------------------------------------------ §11
test('§11 the real layer asks for hardware only: software GL / no context -> SVG', async (t) => {
  reset(); t.after(reset)
  // unit: the context request itself
  const asked: { type: string; opts: WebGLContextAttributes | undefined }[] = []
  const bare = { getContext: (type: string, opts?: WebGLContextAttributes) => { asked.push({ type, opts }); return null },
    addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement
  assert.equal(createWebGL2Layer(bare, { onLost() {}, onRestored() {} }), null, 'no context, no layer')
  assert.equal(asked.length, 1)
  assert.equal(asked[0]!.type, 'webgl2')
  assert.equal(asked[0]!.opts?.failIfMajorPerformanceCaveat, true,
    'a software (major-performance-caveat) context is refused by the browser, never accepted')

  // end to end: the REAL factory in OrgCanvas, where WebGL2 "exists" but the
  // context request comes back empty (what Chromium does for software GL
  // under failIfMajorPerformanceCaveat)
  const W = window as unknown as { WebGL2RenderingContext?: unknown; HTMLCanvasElement: { prototype: { getContext: unknown } } }
  const hadCtor = 'WebGL2RenderingContext' in W
  W.WebGL2RenderingContext = function WebGL2RenderingContext() {}
  const proto = W.HTMLCanvasElement.prototype
  const realGet = proto.getContext
  const calls: { type: string; opts: WebGLContextAttributes | undefined }[] = []
  proto.getContext = function (type: string, opts?: WebGLContextAttributes) { calls.push({ type, opts }); return null }
  t.after(() => { proto.getContext = realGet; if (!hadCtor) delete W.WebGL2RenderingContext })
  const v = await canvas(t)
  const gl = calls.filter(c => c.type === 'webgl2')
  assert.equal(gl.length, 1, 'POSITIVE CONTROL: OrgCanvas really asked the real factory for WebGL2')
  assert.equal(gl[0]!.opts?.failIfMajorPerformanceCaveat, true, 'with the hardware-only attribute')
  assert.equal(v.el.querySelector('canvas.glwires'), null, 'the refused canvas is retired')
  assert.ok(visiblePaths(v.el).some(p => p.getAttribute('class') === 'edge'), 'and the SVG layer draws the wires')
})

// ------------------------------------------------------------------ §12
test('§12 a wire list the layer refuses sends every wire back to SVG', async (t) => {
  reset(); t.after(reset)
  const log = fakeLayer({ refuseWires: true })
  const restore = stubProbeStyles(); t.after(restore)
  const v = await canvas(t)
  assert.equal(log.created, 1, 'GL was tried')
  assert.ok(log.wires.length > 0, 'POSITIVE CONTROL: the layer was handed the wires and refused them')
  assert.ok(visiblePaths(v.el).some(p => p.getAttribute('class') === 'edge'), 'so the SVG layer draws them instead')
  assert.equal(v.el.querySelector('canvas.glwires'), null, 'and the canvas is retired for this mount')
})

// ------------------------------------------------------------------ §13
const dog = (id: string, owner: string, spent: boolean) => ({ id, owner, name: id, kind: 'file', target: 'x.log',
  interval_s: 5, state: spent ? 'spent' : 'armed', at: '2026-09-23T00:00:00Z', fired: spent ? 1 : 0, once: spent, spent })
test('§13 a spent watchdog wire stays in SVG, where its CSS fade runs', async (t) => {
  reset(); t.after(reset)
  const log = fakeLayer()
  const restore = stubProbeStyles(); t.after(restore)
  const v = await canvas(t, undefined, tree({ watchdogs: [dog('d1', 'a1', true), dog('d2', 'a1', false)] } as Partial<TreePayload>))
  const live = log.wires.find(w => w.key === 'wd2'), spent = log.wires.find(w => w.key === 'wd1')
  assert.ok(live && !live.svgOnly, 'POSITIVE CONTROL: a live watchdog wire is drawn by GL')
  assert.ok(spent?.svgOnly, 'the spent one is handed over marked svgOnly, so GL never uploads it')
  const svg = visiblePaths(v.el).map(p => p.getAttribute('class'))
  assert.deepEqual(svg, ['edge tether wd oneshot spent'], 'and SVG draws exactly it, with the classes its keyframe fade keys on')
})

// ------------------------------------------------------------------ §14
test('§14 the SVG fallback draws audience lines in AND out in the old direction', async (t) => {
  reset(); t.after(reset)
  // a controlled clock for the draw-in bookkeeping (it reads performance.now)
  let clock = 1000
  const perf = globalThis.performance as { now: () => number }
  const realNow = perf.now
  perf.now = () => clock
  t.after(() => { perf.now = realNow })
  const frame = () => inAct(async () => { await new Promise(r => setTimeout(r, 20)); await flush(3) })
  const offset = (el: HTMLElement) => {
    const p = visiblePaths(el).filter(x => x.getAttribute('class') === 'edge aud-line')
    assert.equal(p.length, 1, 'one audience line on screen')
    const m = /stroke-dashoffset:\s*([\d.]+)/.exec(p[0]!.getAttribute('style') ?? '')
    assert.ok(m, `the line is mid-animation (style="${p[0]!.getAttribute('style')}")`)
    return Number(m![1])
  }
  const q = smooth(0.25)   // 105ms into the 420ms draw
  const v = await canvas(t, undefined, tree({ audiences: [] }))
  // grant: draws IN, grantor -> grantee: offset 1 - smooth(t)
  clock = 2000
  await v.render(canvasEl(tree()))
  clock = 2105; await frame()
  assert.ok(Math.abs(offset(v.el) - (1 - q)) < 1e-9, `a new grant draws in: offset ${1 - q}`)
  clock = 3000; await frame(); await frame()   // finish the draw-in
  const done = visiblePaths(v.el).find(x => x.getAttribute('class') === 'edge aud-line')
  assert.ok(done && !/stroke-dash/.test(done.getAttribute('style') ?? ''), 'a finished draw-in is a plain line again')
  // revoke: retracts the same way: frac 1 - smooth(t), offset smooth(t)
  await v.render(canvasEl(tree({ audiences: [] })))
  clock = 3105; await frame()
  assert.ok(Math.abs(offset(v.el) - q) < 1e-9, `a revoked grant retracts: offset ${q}`)
})

// ------------------------------------------------------------------ §15
declare const __SRC_DIR__: string
test('§15 the GL canvas is never a hit target (styles.css)', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const m = /(?:^|\})\s*\.glwires\s*\{([^}]*)\}/m.exec(css)
  assert.ok(m, 'no ".glwires" rule found in styles.css')
  assert.match(m![1]!, /pointer-events:\s*none/, 'every press belongs to the card or the pan beneath')
})
