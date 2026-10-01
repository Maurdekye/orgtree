// canvas/glwires.ts — the org view's wires and mail sparks, drawn with WebGL2.
//
// THE PROBLEM (G0 profile, 2026-09-23, docket `profile-the-private-v3-org-
// canvas-on-synthetic-d`): the SVG edge layer lives inside the zoomed `.space`,
// and every animation frame of a mail spark re-rendered the WHOLE OrgCanvas
// through `setFrame` just to move a 3px dot. On the 453-agent fixture that was
// ~3.4 of 4.7 ms of main-thread work per frame during a spark burst.
//
// THE SHAPE OF THE FIX (user ruling: WebGL2 inside Electron, org view only):
//  · OrgCanvas still decides WHICH wires exist, exactly as before, and hands
//    them over as a `Wire[]` list — the same list the SVG fallback renders.
//  · This layer uploads their geometry in WORLD units and applies the camera
//    with uniforms, so a pan or a zoom never re-tessellates anything.
//  · Sparks are drawn from OrgCanvas's own `sparksRef` by the frame loop that
//    already runs, with no React commit (OrgCanvas's `glDrawRef`).
//  · Cards, text, hit-testing and every control stay in the DOM, untouched.
//    The canvas has `pointer-events: none` and sits UNDER `.space`, which is
//    where the SVG layer painted too.
//
// ⚠ STYLE IS READ, NOT RESTATED. Colours, widths, dashes, opacity and the
// drop-shadow glows come from `getComputedStyle` of hidden probe elements that
// carry the real classes inside the real `svg.edges` (`readWireStyles`). Theme
// variables, the red-alert/killswitch ancestors and any later CSS change are
// therefore honoured without a second copy of styles.css living here. A value
// this file cannot parse DISABLES the layer rather than drawing a guess.
//
// ⚠ EVERY FAILURE FALLS BACK TO SVG, never to a blank view: no WebGL2 (jsdom,
// old drivers), a software/"major performance caveat" context, a shader that
// will not compile, an unparseable style, a lost context, the compact map, or
// the hidden kill flag `localStorage['orgtree-canvas-gl-wires'] = 'off'`.
// A lost context comes back only after `webglcontextrestored` AND a successful
// re-initialisation.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { segPoint, smooth } from './shared'
import type { Seg } from './shared'

export const GL_WIRES_FLAG_KEY = 'orgtree-canvas-gl-wires'

/** One wire, exactly as OrgCanvas would have drawn it in SVG. */
export interface Wire {
  key: string
  seg: Seg
  /** the SVG path's className, e.g. `edge faded` or `edge aud-line from-user` */
  cls: string
  /** audience draw-in/out: the VISIBLE fraction from the start of the path.
   *  SVG draws it with pathLength=1 and a dash offset; absent = whole path. */
  frac?: number
  /** kept in SVG even while WebGL draws the rest (CSS-keyframe-animated wires,
   *  whose per-element animation clock a style probe cannot reproduce) */
  svgOnly?: boolean
}

export interface SparkLike {
  id: number; segs: (Seg & { rev: boolean })[]; start: number; segDur: number
}
export interface CameraView { x: number; y: number; z: number }

/** Where a spark is at `now` — the SAME formula the SVG layer has always used,
 *  shared so the two renderers cannot drift apart. */
export function sparkPoint(sp: SparkLike, now: number): { x: number; y: number } {
  const el = (now - sp.start) / sp.segDur
  const i = Math.max(0, Math.min(sp.segs.length - 1, Math.floor(el)))
  const t = smooth(Math.max(0, Math.min(1, el - i)))
  const seg = sp.segs[i]! // nUIA: i clamped to 0..len-1 and segs is never empty (guarded at push)
  return segPoint(seg, seg.rev ? 1 - t : t)
}

// ------------------------------------------------------------ style parsing

export type RGBA = [number, number, number, number]   // straight alpha, 0..1

/** CSS computed colours: `rgb()`/`rgba()` in either syntax, and
 *  `color(srgb r g b / a)` (what a computed `color-mix(in srgb …)` becomes).
 *  Anything else is null — and null disables the layer. */
export function parseCssColor(s: string | null | undefined): RGBA | null {
  if (!s) return null
  const t = s.trim().toLowerCase()
  if (t === 'transparent') return [0, 0, 0, 0]
  let m = /^rgba?\(\s*([^)]*)\)$/.exec(t)
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const ch = parts.slice(0, 3).map(p => p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p))
    const a = parts[3] === undefined ? 1 : parts[3]!.endsWith('%') ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!)
    if (![...ch, a].every(Number.isFinite)) return null
    return [ch[0]! / 255, ch[1]! / 255, ch[2]! / 255, a]
  }
  m = /^color\(\s*srgb\s+([^)]*)\)$/.exec(t)
  if (m) {
    const parts = m[1]!.split(/[\s/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const ch = parts.slice(0, 3).map(p => p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p))
    const a = parts[3] === undefined ? 1 : parts[3]!.endsWith('%') ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!)
    if (![...ch, a].every(Number.isFinite)) return null
    return [ch[0]!, ch[1]!, ch[2]!, a]
  }
  return null
}

export interface Shadow { color: RGBA; blur: number }
/** `filter` computed value → its drop-shadows (offsets are always 0 in this
 *  layer's CSS; a non-zero offset or any other filter function is refused). */
export function parseDropShadows(s: string | null | undefined): Shadow[] | null {
  if (!s || s.trim() === 'none') return []
  const out: Shadow[] = []
  let rest = s.trim()
  while (rest) {
    const m = /^drop-shadow\(/.exec(rest)
    if (!m) return null
    // find the matching close paren (colours carry their own parens)
    let depth = 0, end = -1
    for (let i = 'drop-shadow'.length; i < rest.length; i++) {
      if (rest[i] === '(') depth++
      else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) return null
    const body = rest.slice('drop-shadow('.length, end).trim()
    rest = rest.slice(end + 1).trim()
    // split the colour (possibly with parens) from the lengths
    let color: RGBA | null = null, lengths: number[] = []
    const cm = /(rgba?\([^)]*\)|color\([^)]*\))/.exec(body)
    if (cm) {
      color = parseCssColor(cm[1])
      lengths = body.replace(cm[1]!, ' ').trim().split(/\s+/).filter(Boolean).map(v => parseFloat(v))
    } else return null
    if (!color || lengths.some(v => !Number.isFinite(v))) return null
    const [dx = 0, dy = 0, blur = 0] = lengths
    if (dx !== 0 || dy !== 0) return null
    out.push({ color, blur })
  }
  return out
}

/** `stroke-dasharray` → [dash, gap] in user units, [0, 0] for solid. */
export function parseDash(s: string | null | undefined): [number, number] | null {
  if (!s || s.trim() === 'none') return [0, 0]
  const v = s.split(/[\s,]+/).filter(Boolean).map(x => parseFloat(x))
  if (!v.length || v.some(x => !Number.isFinite(x) || x < 0)) return null
  const even = v.length % 2 ? [...v, ...v] : v
  // this layer draws one dash/gap pair; a longer pattern is refused, not guessed
  for (let i = 2; i < even.length; i += 2) if (even[i] !== even[0] || even[i + 1] !== even[1]) return null
  return [even[0]!, even[1]!]
}

export interface WireStyle {
  color: RGBA; width: number; opacity: number; dash: [number, number]; glow: Shadow | null
}
export interface SparkStyle { fill: RGBA; glows: Shadow[] }
export interface WireStyles { byClass: Map<string, WireStyle>; spark: SparkStyle }

/** Reads every probe in `root` (`[data-glprobe]`). Null = something could not
 *  be parsed; the caller must then stay on SVG. */
export function readWireStyles(root: Element | null): WireStyles | null {
  if (!root || typeof getComputedStyle !== 'function') return null
  const byClass = new Map<string, WireStyle>()
  let spark: SparkStyle | null = null
  for (const el of root.querySelectorAll('[data-glprobe]')) {
    const cs = getComputedStyle(el)
    const which = el.getAttribute('data-glprobe')!
    const shadows = parseDropShadows(cs.filter)
    if (!shadows) return null
    if (which === '@spark') {
      const fill = parseCssColor(cs.fill)
      if (!fill) return null
      spark = { fill, glows: shadows }
      continue
    }
    const color = parseCssColor(cs.stroke)
    const width = parseFloat(cs.strokeWidth)
    const opacity = parseFloat(cs.opacity)
    const dash = parseDash(cs.strokeDasharray)
    if (!color || !dash || !Number.isFinite(width) || !Number.isFinite(opacity)) return null
    if (shadows.length > 1) return null
    byClass.set(which, { color, width, opacity, dash, glow: shadows[0] ?? null })
  }
  if (!spark) return null
  return { byClass, spark }
}

// ------------------------------------------------------------- tessellation

export interface WorldRect { x: number; y: number; w: number; h: number }

export const segBounds = (s: Seg): WorldRect => {
  const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
const meets = (a: WorldRect, b: WorldRect) =>
  a.x + a.w >= b.x && a.y + a.h >= b.y && a.x <= b.x + b.w && a.y <= b.y + b.h

/** Points along a segment, finely enough for `maxStep` world units per step. */
export function tessellate(s: Seg, maxStep: number): { x: number; y: number }[] {
  if (s.kind === 'l') return [s.pts[0], s.pts[1]]
  const [p0, p1, p2, p3] = s.pts
  const hull = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y)
    + Math.hypot(p3.x - p2.x, p3.y - p2.y)
  const n = Math.max(2, Math.min(96, Math.ceil(hull / Math.max(1e-3, maxStep))))
  const out: { x: number; y: number }[] = []
  for (let i = 0; i <= n; i++) out.push(segPoint(s, i / n))
  return out
}

/** Floats per vertex: pos(2) normal(2) side along total frac style */
export const VERT_FLOATS = 9

/** Builds the triangle geometry for `wires` (in list order — painter's order
 *  is preserved because one indexed draw rasterises primitives in order).
 *  Returns null when a wire's class has no parsed style. */
export function buildWireGeometry(wires: Wire[], styleIndex: Map<string, number>, maxStep: number,
  cover: WorldRect | null): { verts: Float32Array; index: Uint32Array; drawn: number } | null {
  const vs: number[] = [], ix: number[] = []
  let drawn = 0
  for (const w of wires) {
    if (w.svgOnly) continue
    const si = styleIndex.get(w.cls)
    if (si === undefined) return null
    if (cover && !meets(segBounds(w.seg), cover)) continue
    const pts = tessellate(w.seg, maxStep)
    // drop coincident points - a zero-length step has no normal
    const p: { x: number; y: number }[] = [pts[0]!]
    for (const q of pts.slice(1)) { const l = p[p.length - 1]!; if (Math.hypot(q.x - l.x, q.y - l.y) > 1e-6) p.push(q) }
    if (p.length < 2) continue
    const along = [0]
    for (let i = 1; i < p.length; i++) along.push(along[i - 1]! + Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y))
    const total = along[along.length - 1]!
    const frac = w.frac === undefined ? 1 : Math.max(0, Math.min(1, w.frac))
    const base = vs.length / VERT_FLOATS
    for (let i = 0; i < p.length; i++) {
      // miter normal: the average of the adjoining segments' normals, scaled
      // so the stroke keeps its width through the bend (capped for spikes)
      const a = p[Math.max(0, i - 1)]!, b = p[i]!, c = p[Math.min(p.length - 1, i + 1)]!
      const n1 = norm(i > 0 ? b.x - a.x : c.x - b.x, i > 0 ? b.y - a.y : c.y - b.y)
      const n2 = norm(i < p.length - 1 ? c.x - b.x : b.x - a.x, i < p.length - 1 ? c.y - b.y : b.y - a.y)
      let mx = n1[0] + n2[0], my = n1[1] + n2[1]
      const ml = Math.hypot(mx, my) || 1
      mx /= ml; my /= ml
      const cos = mx * n1[0] + my * n1[1]
      const scale = Math.min(2, 1 / Math.max(0.5, cos))
      for (const side of [-1, 1]) vs.push(b.x, b.y, mx * scale, my * scale, side, along[i]!, total, frac, si)
    }
    for (let i = 0; i < p.length - 1; i++) {
      const v = base + i * 2
      ix.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
    }
    drawn++
  }
  return { verts: new Float32Array(vs), index: new Uint32Array(ix), drawn }
}
/** the LEFT-hand unit normal of a direction */
function norm(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy) || 1
  return [-dy / l, dx / l]
}

/** Structural equality of two wire lists (keys, classes, fractions, points). */
export function sameWires(a: Wire[] | null, b: Wire[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = b[i]!
    if (p.key !== q.key || p.cls !== q.cls || p.frac !== q.frac || p.svgOnly !== q.svgOnly
      || p.seg.kind !== q.seg.kind) return false
    for (let j = 0; j < p.seg.pts.length; j++) {
      if (p.seg.pts[j]!.x !== q.seg.pts[j]!.x || p.seg.pts[j]!.y !== q.seg.pts[j]!.y) return false
    }
  }
  return true
}

// ------------------------------------------------------------- the GL layer

/** What OrgCanvas drives. The real one is WebGL2; tests install a fake. */
export interface GlWiresLayer {
  /** hand over the committed wire list and styles (cheap when unchanged) */
  setWires(wires: Wire[], styles: WireStyles): boolean
  /** draw wires + sparks for this committed camera */
  draw(view: CameraView, sparks: readonly SparkLike[], now: number): void
  resize(cssW: number, cssH: number, dpr: number): void
  destroy(): void
}
export interface GlWiresHooks { onLost(): void; onRestored(ok: boolean): void }
export type GlWiresFactory = (canvas: HTMLCanvasElement, hooks: GlWiresHooks) => GlWiresLayer | null

const MAX_STYLES = 32
const SPARK_R = 3.4   // world units - the SVG circle's r

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_nrm;
layout(location=2) in float a_side;
layout(location=3) in float a_along;
layout(location=4) in float a_total;
layout(location=5) in float a_frac;
layout(location=6) in float a_style;
uniform vec3 u_view;      // camera: screen = world * z + (x, y)
uniform vec2 u_size;      // canvas size in CSS px
uniform float u_dpr;
uniform vec4 u_params[${MAX_STYLES}];   // width, dash, gap, glow blur (world units)
out float v_across; out float v_halfW; out float v_cov; out float v_along; out float v_visLen; out float v_coreHalf;
flat out int v_style;
void main() {
  int si = int(a_style + 0.5);
  vec4 pr = u_params[si];
  float z = u_view.z;
  float coreW = pr.x * z;                         // stroke width on screen
  float px = 1.0 / u_dpr;
  float drawW = max(coreW, px);                   // never thinner than a device pixel...
  float glow = pr.w * z;                          // CSS blur radius on screen
  float ext = drawW * 0.5 + glow * 1.5 + px;
  vec2 p = a_pos * z + u_view.xy + a_nrm * a_side * ext;
  v_across = a_side * ext;
  v_halfW = drawW * 0.5;
  v_cov = coreW / drawW;                          // ...with its coverage kept in alpha
  v_coreHalf = coreW * 0.5;                       // the TRUE width casts the shadow
  v_along = a_along;
  v_visLen = a_frac * a_total;
  v_style = si;
  vec2 ndc = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`
const LINE_FS = `#version 300 es
precision highp float;
// Abramowitz-Stegun 7.1.26, |error| < 1.5e-7 - plenty for 8-bit alpha
float erf_(float x) {
  float s = sign(x), a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}
uniform vec4 u_color[${MAX_STYLES}];     // stroke, straight alpha
uniform vec4 u_glowc[${MAX_STYLES}];     // glow colour, straight alpha
uniform vec4 u_params[${MAX_STYLES}];
uniform float u_opacity[${MAX_STYLES}];
uniform vec3 u_view;
uniform float u_dpr;
in float v_across; in float v_halfW; in float v_cov; in float v_along; in float v_visLen; in float v_coreHalf;
flat in int v_style;
out vec4 o;
void main() {
  vec4 pr = u_params[v_style];
  if (v_along > v_visLen + 1e-4) discard;
  if (pr.y > 0.0) { if (mod(v_along, pr.y + pr.z) > pr.y) discard; }
  float d = abs(v_across);
  float aa = 0.5 / u_dpr;
  float core = clamp((v_halfW + aa - d) / (2.0 * aa), 0.0, 1.0) * v_cov;
  vec4 c = u_color[v_style];
  vec3 rgb = c.rgb * c.a * core;
  float a = c.a * core;
  float blur = pr.w * u_view.z;
  if (blur > 0.0) {
    // CSS drop-shadow = the stroke's own shape blurred by a gaussian with
    // sigma = blur / 2: across a stroke of width w that is a box convolved
    // with a gaussian, i.e. a difference of two error functions
    float sigma = blur * 0.5;
    float k = 1.0 / (sigma * 1.41421356);
    float g = 0.5 * (erf_((d + v_coreHalf) * k) - erf_((d - v_coreHalf) * k));
    vec4 gc = u_glowc[v_style];
    float ga = gc.a * g * (1.0 - a);
    rgb += gc.rgb * ga; a += ga;
  }
  float op = u_opacity[v_style];
  o = vec4(rgb * op, a * op);                    // premultiplied
}`
const SPARK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;             // -1..1 quad
layout(location=1) in vec2 a_center;             // world, per instance
uniform vec3 u_view; uniform vec2 u_size; uniform float u_ext;
out vec2 v_off;
void main() {
  vec2 c = a_center * u_view.z + u_view.xy;
  vec2 p = c + a_corner * u_ext;
  v_off = a_corner * u_ext;
  vec2 ndc = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`
const SPARK_FS = `#version 300 es
precision highp float;
// Abramowitz-Stegun 7.1.26, |error| < 1.5e-7 - plenty for 8-bit alpha
float erf_(float x) {
  float s = sign(x), a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}
// a disc of radius r centred at the origin, blurred by a gaussian of sigma s,
// evaluated at distance d: midpoint rule over 8 rings x 16 spokes
float discBlur(float d, float r, float s) {
  float acc = 0.0, k = 1.0 / (2.0 * s * s);
  for (int i = 0; i < 8; i++) {
    float rr = (float(i) + 0.5) / 8.0 * r;
    for (int j = 0; j < 16; j++) {
      float th = (float(j) + 0.5) / 16.0 * 6.28318531;
      vec2 q = vec2(rr * cos(th), rr * sin(th));
      float dx = d - q.x, dy = q.y;
      acc += rr * exp(-(dx * dx + dy * dy) * k);
    }
  }
  // sum * dr * dtheta, over the gaussian's normaliser 2 pi s^2
  return acc * (r / 8.0) * (6.28318531 / 16.0) / (6.28318531 * s * s);
}
uniform vec4 u_fill; uniform vec4 u_g1; uniform vec4 u_g2;
uniform float u_r; uniform float u_b1; uniform float u_b2; uniform float u_dpr;
in vec2 v_off; out vec4 o;
void main() {
  float d = length(v_off);
  float aa = 0.5 / u_dpr;
  float core = clamp((u_r + aa - d) / (2.0 * aa), 0.0, 1.0);
  vec3 rgb = u_fill.rgb * u_fill.a * core; float a = u_fill.a * core;
  // each drop-shadow is the disc blurred by a 2D gaussian (sigma = blur / 2),
  // integrated numerically over the disc: a spark is a few pixels across, so
  // the 1D edge approximation that is exact for a stroke overstates its halo
  if (u_b1 > 0.0) { float g = discBlur(d, u_r, u_b1 * 0.5) * u_g1.a * (1.0 - a); rgb += u_g1.rgb * g; a += g; }
  if (u_b2 > 0.0) { float g = discBlur(d, u_r, u_b2 * 0.5) * u_g2.a * (1.0 - a); rgb += u_g2.rgb * g; a += g; }
  o = vec4(rgb, a);
}`

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src); gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null }
    return s
  }
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs)
  if (!v || !f) return null
  const p = gl.createProgram()
  if (!p) return null
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p)
  gl.deleteShader(v); gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { gl.deleteProgram(p); return null }
  return p
}

/** The real layer. Null when WebGL2 is unavailable, software-only, or broken. */
export const createWebGL2Layer: GlWiresFactory = (canvas, hooks) => {
  let gl: WebGL2RenderingContext | null = null
  const ctxOpts: WebGLContextAttributes = {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true, powerPreference: 'default',
  }
  try { gl = canvas.getContext('webgl2', ctxOpts) as WebGL2RenderingContext | null } catch { gl = null }
  if (!gl) return null

  type Res = { line: WebGLProgram; spark: WebGLProgram; lineVao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer;
    sparkVao: WebGLVertexArrayObject; quad: WebGLBuffer; inst: WebGLBuffer }
  let res: Res | null = null
  const init = (): boolean => {
    const g = gl!
    const line = program(g, LINE_VS, LINE_FS), spark = program(g, SPARK_VS, SPARK_FS)
    const lineVao = g.createVertexArray(), vbo = g.createBuffer(), ibo = g.createBuffer()
    const sparkVao = g.createVertexArray(), quad = g.createBuffer(), inst = g.createBuffer()
    if (!line || !spark || !lineVao || !vbo || !ibo || !sparkVao || !quad || !inst) return false
    g.bindVertexArray(lineVao)
    g.bindBuffer(g.ARRAY_BUFFER, vbo)
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibo)
    const stride = VERT_FLOATS * 4
    const attr = (loc: number, size: number, off: number) => {
      g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, size, g.FLOAT, false, stride, off * 4)
    }
    attr(0, 2, 0); attr(1, 2, 2); attr(2, 1, 4); attr(3, 1, 5); attr(4, 1, 6); attr(5, 1, 7); attr(6, 1, 8)
    g.bindVertexArray(sparkVao)
    g.bindBuffer(g.ARRAY_BUFFER, quad)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW)
    g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 8, 0)
    g.bindBuffer(g.ARRAY_BUFFER, inst)
    g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 2, g.FLOAT, false, 8, 0)
    g.vertexAttribDivisor(1, 1)
    g.bindVertexArray(null)
    res = { line, spark, lineVao, vbo, ibo, sparkVao, quad, inst }
    uploaded = null
    return true
  }
  // geometry state
  let wires: Wire[] | null = null
  let styles: WireStyles | null = null
  let styleIndex = new Map<string, number>()
  let uploaded: { wires: Wire[]; styles: WireStyles; cover: WorldRect; z: number; count: number } | null = null
  let cssW = 0, cssH = 0, dpr = 1
  let lost = false

  const onLost = (e: Event) => { e.preventDefault(); lost = true; res = null; uploaded = null; hooks.onLost() }
  const onRestored = () => { lost = false; let ok = false; try { ok = init() } catch { ok = false } hooks.onRestored(ok) }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  let ok = false
  try { ok = init() } catch { ok = false }
  if (!ok) {
    canvas.removeEventListener('webglcontextlost', onLost)
    canvas.removeEventListener('webglcontextrestored', onRestored)
    return null
  }

  const ensureGeometry = (view: CameraView): number => {
    const g = gl!
    if (!res || !wires || !styles) return 0
    // the uploaded COVER is the visible world rect widened by a viewport on
    // every side, so a steady pan redraws with uniforms alone and only
    // re-uploads when it leaves the cover or the wires/zoom changed
    const vis = { x: -view.x / view.z, y: -view.y / view.z, w: cssW / view.z, h: cssH / view.z }
    const inside = uploaded && uploaded.wires === wires && uploaded.styles === styles
      && vis.x >= uploaded.cover.x && vis.y >= uploaded.cover.y
      && vis.x + vis.w <= uploaded.cover.x + uploaded.cover.w && vis.y + vis.h <= uploaded.cover.y + uploaded.cover.h
      && view.z / uploaded.z < 2 && view.z / uploaded.z > 0.5
    if (inside) return uploaded!.count
    const cover = { x: vis.x - vis.w, y: vis.y - vis.h, w: vis.w * 3, h: vis.h * 3 }
    // about 6 screen px per straight step at the tessellation zoom
    const geo = buildWireGeometry(wires, styleIndex, 6 / Math.max(1e-3, view.z), cover)
    if (!geo) return 0
    g.bindBuffer(g.ARRAY_BUFFER, res.vbo)
    g.bufferData(g.ARRAY_BUFFER, geo.verts, g.DYNAMIC_DRAW)
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, res.ibo)
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, geo.index, g.DYNAMIC_DRAW)
    uploaded = { wires, styles, cover, z: view.z, count: geo.index.length }
    return geo.index.length
  }

  const styleUniforms = () => {
    const g = gl!, p = res!.line, st = styles!
    const color = new Float32Array(MAX_STYLES * 4), glowc = new Float32Array(MAX_STYLES * 4)
    const params = new Float32Array(MAX_STYLES * 4), opacity = new Float32Array(MAX_STYLES)
    for (const [cls, i] of styleIndex) {
      const s = st.byClass.get(cls)!
      color.set(s.color, i * 4)
      if (s.glow) glowc.set(s.glow.color, i * 4)
      params.set([s.width, s.dash[0], s.dash[1], s.glow ? s.glow.blur : 0], i * 4)
      opacity[i] = s.opacity
    }
    g.uniform4fv(g.getUniformLocation(p, 'u_color'), color)
    g.uniform4fv(g.getUniformLocation(p, 'u_glowc'), glowc)
    g.uniform4fv(g.getUniformLocation(p, 'u_params'), params)
    g.uniform1fv(g.getUniformLocation(p, 'u_opacity'), opacity)
  }

  return {
    setWires(next, nextStyles) {
      if (nextStyles !== styles) {
        const idx = new Map<string, number>()
        for (const cls of nextStyles.byClass.keys()) idx.set(cls, idx.size)
        if (idx.size > MAX_STYLES) return false
        styleIndex = idx
        styles = nextStyles
        uploaded = null
      }
      if (!sameWires(wires, next)) { wires = next; uploaded = null }
      for (const w of next) if (!w.svgOnly && !styleIndex.has(w.cls)) return false
      return true
    },
    draw(view, sparks, now) {
      const g = gl
      if (!g || lost || !res || !styles || !(cssW > 0 && cssH > 0) || !(view.z > 0)) return
      g.viewport(0, 0, canvas.width, canvas.height)
      g.clearColor(0, 0, 0, 0)
      g.clear(g.COLOR_BUFFER_BIT)
      g.enable(g.BLEND)
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA)
      const count = ensureGeometry(view)
      if (count) {
        g.useProgram(res.line)
        g.uniform3f(g.getUniformLocation(res.line, 'u_view'), view.x, view.y, view.z)
        g.uniform2f(g.getUniformLocation(res.line, 'u_size'), cssW, cssH)
        g.uniform1f(g.getUniformLocation(res.line, 'u_dpr'), dpr)
        styleUniforms()
        g.bindVertexArray(res.lineVao)
        g.drawElements(g.TRIANGLES, count, g.UNSIGNED_INT, 0)
      }
      if (sparks.length) {
        const pts = new Float32Array(sparks.length * 2)
        sparks.forEach((sp, i) => { const p = sparkPoint(sp, now); pts[i * 2] = p.x; pts[i * 2 + 1] = p.y })
        const sp = styles.spark
        const r = SPARK_R * view.z
        const b1 = (sp.glows[0]?.blur ?? 0) * view.z, b2 = (sp.glows[1]?.blur ?? 0) * view.z
        g.useProgram(res.spark)
        const u = (n: string) => g.getUniformLocation(res!.spark, n)
        g.uniform3f(u('u_view'), view.x, view.y, view.z)
        g.uniform2f(u('u_size'), cssW, cssH)
        g.uniform1f(u('u_dpr'), dpr)
        g.uniform1f(u('u_r'), r)
        g.uniform1f(u('u_ext'), r + Math.max(b1, b2) * 1.5 + 1)
        g.uniform4fv(u('u_fill'), sp.fill)
        g.uniform4fv(u('u_g1'), sp.glows[0]?.color ?? [0, 0, 0, 0])
        g.uniform4fv(u('u_g2'), sp.glows[1]?.color ?? [0, 0, 0, 0])
        g.uniform1f(u('u_b1'), b1); g.uniform1f(u('u_b2'), b2)
        g.bindVertexArray(res.sparkVao)
        g.bindBuffer(g.ARRAY_BUFFER, res.inst)
        g.bufferData(g.ARRAY_BUFFER, pts, g.DYNAMIC_DRAW)
        g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, sparks.length)
      }
      g.bindVertexArray(null)
    },
    resize(w, h, d) {
      cssW = w; cssH = h; dpr = d
      const bw = Math.max(1, Math.round(w * d)), bh = Math.max(1, Math.round(h * d))
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
    },
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      const g = gl
      if (g && res && !lost) {
        g.deleteProgram(res.line); g.deleteProgram(res.spark)
        g.deleteBuffer(res.vbo); g.deleteBuffer(res.ibo); g.deleteBuffer(res.quad); g.deleteBuffer(res.inst)
        g.deleteVertexArray(res.lineVao); g.deleteVertexArray(res.sparkVao)
      }
      res = null; gl = null
    },
  }
}

// ------------------------------------------------------------ React binding

let factory: GlWiresFactory = createWebGL2Layer
/** test seam: install a fake layer factory (null restores WebGL2) */
export const __setGlWiresFactory = (f: GlWiresFactory | null): void => { factory = f ?? createWebGL2Layer }

/** Whether this environment should even TRY WebGL2 wires. */
export function glWiresAllowed(): boolean {
  try { if (localStorage.getItem(GL_WIRES_FLAG_KEY) === 'off') return false } catch { /* private mode */ }
  if (factory !== createWebGL2Layer) return true
  return typeof window !== 'undefined'
    && typeof (window as unknown as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext !== 'undefined'
}

/**
 * Owns the canvas's layer across mounts, losses and restores.
 * `active` is the ONLY signal OrgCanvas uses to choose GL over SVG: it is
 * true from a successful init until a loss, a failure or `wanted` going false.
 */
export function useGlWires(wanted: boolean) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const layerRef = useRef<GlWiresLayer | null>(null)
  const [active, setActive] = useState(false)
  const [failed, setFailed] = useState(false)
  useLayoutEffect(() => {
    if (!wanted || !canvas || failed) return
    let layer: GlWiresLayer | null = null
    try {
      layer = factory(canvas, {
        onLost: () => setActive(false),
        onRestored: (ok) => { if (ok) setActive(true); else setFailed(true) },
      })
    } catch { layer = null }
    if (!layer) { setFailed(true); return }
    layerRef.current = layer
    setActive(true)
    return () => { layer!.destroy(); if (layerRef.current === layer) layerRef.current = null; setActive(false) }
  }, [wanted, canvas, failed])
  // a style this layer cannot draw faithfully (or too many classes) is a
  // permanent fallback for this mount, not a retry loop
  const fail = useCallback(() => setFailed(true), [])
  // theme changes rewrite CSS variables without necessarily re-rendering
  // OrgCanvas; the caller's redraw re-reads the probes when this bumps
  const [themeRev, setThemeRev] = useState(0)
  // the canvas's own CSS box (inset 0 inside the viewport's border), which is
  // what the backing store must match - not the viewport's outer rect
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    if (!canvas) return
    const measure = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      setSize(p => (p.w === w && p.h === h ? p : { w, h }))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [canvas])
  useEffect(() => {
    if (!wanted || typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => setThemeRev(r => r + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => mo.disconnect()
  }, [wanted])
  return {
    /** render the <canvas> at all (GL wanted and not permanently failed) */
    mount: wanted && !failed,
    active: wanted && active && !failed,
    canvasRef: setCanvas,
    layerRef,
    fail,
    themeRev,
    size,
  }
}
