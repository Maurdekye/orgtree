/* The flowing-ASCII background's field — pure math, no DOM, so the tests
 * can hold it to bounds and determinism without a canvas.
 *
 * Modelled on the Claude Desktop "New session" backdrop the user pointed at
 * (researched 2026-10-15, model-research-sol; screenshot and measurements in
 * D:/orgtree-work/model-research/claude-code-ascii): a tight monospace grid
 * of mixed-case letters and digits — roughly 190 columns across a window,
 * cell aspect about 1:2 — whose brightness follows broad, rounded, lobed
 * regions with large dark negative space between them. The glyphs are
 * seeded per world cell and never change; only the intensity field moves.
 * No public recording of the original's motion was found, so the slow
 * drift below is an interpretation, tuned to stay ambient; every constant
 * that shapes the look lives in this file so matching a better reference
 * later is a constants change, not a rewrite. */

/** The glyph pool: mixed-case Latin letters and digits, as observed. */
export const ASCII_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** World-space cell size at zoom 1. The reference packs about 190 columns
 *  across a full window with rows about twice the column pitch. */
export const ASCII_CELL_W = 10
export const ASCII_CELL_H = 19

/** Below this on-screen cell width the layer draws every Nth world cell
 *  instead: zooming out coarsens the sampling rather than multiplying the
 *  glyph count (the field still pans 1:1 at every zoom). */
export const ASCII_MIN_SCREEN_W = 7

/** Hard ceiling on cells per frame, whatever the window size: the paint is
 *  O(viewport) and independent of how large the organization is. */
export const ASCII_MAX_CELLS = 16000

/** Brightness buckets the painter pre-renders; bucket -1 means "too faint
 *  to draw", which is what makes the negative space free. */
export const ASCII_BUCKETS = 5

function hash2(i: number, j: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** The glyph anchored at world cell (i, j): stable under pan and zoom, so
 *  the soup reads as a floor the canvas moves over, not as noise. */
export const asciiGlyphAt = (i: number, j: number): number => hash2(i, j) % ASCII_GLYPHS.length

/** Field intensity at world point (x, y) and time t (seconds), in 0..1.
 *  Two sine octaves: broad lobes (~900 world px features) carrying curving
 *  bands (~280 px), soft-thresholded so approaching half the plane sits at
 *  exactly 0 — the reference's dark negative space. Drift is a few tens of
 *  world pixels per second: present, never busy. */
export function asciiField(x: number, y: number, t: number): number {
  const lobe = Math.sin(x * 0.0016 + t * 0.080 + 1.9 * Math.sin(y * 0.0011 - t * 0.059))
    + Math.sin(y * 0.0013 - t * 0.067 + 1.6 * Math.sin(x * 0.0009 + t * 0.046))
    + Math.sin((x + y) * 0.0007 + t * 0.037)
  const band = Math.sin(x * 0.0045 - t * 0.096 + 1.2 * Math.sin(y * 0.0031 + t * 0.072))
    + Math.sin(y * 0.0052 + t * 0.083)
  const v = (lobe / 3) * 0.72 + (band / 2) * 0.28
  const u0 = v * 0.5 + 0.5
  const cut = 0.52
  if (u0 <= cut) return 0
  const u = (u0 - cut) / (1 - cut)
  return u * u * (3 - 2 * u)
}

/** Brightness bucket for a field value, or -1 to skip the cell entirely. */
export const asciiBucket = (v: number): number =>
  v <= 0.02 ? -1 : Math.min(ASCII_BUCKETS - 1, Math.floor(v * ASCII_BUCKETS))

/** World-cell step for the current zoom and viewport: 1 while cells stay
 *  legible and under the frame budget, coarser beyond that. */
export function asciiStep(z: number, cssW: number, cssH: number): number {
  if (!(z > 0) || !Number.isFinite(z) || !(cssW > 0) || !(cssH > 0)) return 1
  let step = Math.max(1, Math.ceil(ASCII_MIN_SCREEN_W / (ASCII_CELL_W * z)))
  while (step < 64) {
    const cols = cssW / (ASCII_CELL_W * step * z)
    const rows = cssH / (ASCII_CELL_H * step * z)
    if (cols * rows <= ASCII_MAX_CELLS) break
    step++
  }
  return step
}
