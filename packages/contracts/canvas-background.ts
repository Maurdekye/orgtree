/** Canvas background themes (user 2026-10-15 15:52Z and 15:57Z; rulings
 *  2026-10-15 18:20Z): the organization canvas's backdrop is selectable in
 *  App settings > Display. `dots` is the original dot grid and stays the
 *  default; the grids and tiles pan and zoom with the canvas like a floor;
 *  every theme carries one intensity (0..1) and draws in the current visual
 *  theme's colours — there are no per-theme colour pickers. The whole
 *  preference is optional: absent reads as `dots` at full strength, exactly
 *  the shipped behaviour. */
export const CANVAS_BACKGROUNDS = [
  'dots', 'ascii', 'line-grid', 'hex-dots', 'hex-lines',
  'square-tiles', 'triangle-tiles', 'hex-tiles',
] as const
export type CanvasBackgroundTheme = typeof CANVAS_BACKGROUNDS[number]

/** Picker order is CANVAS_BACKGROUNDS order: the current background first,
 *  then the flowing ASCII the user asked for, then grids, then tiles. */
export const CANVAS_BACKGROUND_LABELS: Record<CanvasBackgroundTheme, string> = {
  dots: 'Dot grid',
  ascii: 'Flowing ASCII',
  'line-grid': 'Line grid',
  'hex-dots': 'Hex dot grid',
  'hex-lines': 'Hex line grid',
  'square-tiles': 'Square tiles',
  'triangle-tiles': 'Triangular tiles',
  'hex-tiles': 'Hexagonal tiles',
}

export interface CanvasBackgroundPreference {
  theme: CanvasBackgroundTheme
  /** Per-theme intensities the user has moved; absent entries use the
   *  defaults below. Stored sparsely so a fresh choice of theme writes one
   *  small object, and a default change can still reach untouched themes. */
  intensities?: Partial<Record<CanvasBackgroundTheme, number>>
}

export interface ResolvedCanvasBackground {
  theme: CanvasBackgroundTheme
  intensities: Record<CanvasBackgroundTheme, number>
}

/** Tuned so each theme at its default reads about as strong as the dot grid
 *  it replaces: filled tiles and dense outlines sit lower than hairlines.
 *  `dots` is 1 — untouched, it is pixel-identical to the shipped grid. */
export const DEFAULT_CANVAS_INTENSITIES: Record<CanvasBackgroundTheme, number> = {
  dots: 1,
  ascii: 0.6,
  'line-grid': 0.55,
  'hex-dots': 0.85,
  'hex-lines': 0.5,
  'square-tiles': 0.5,
  'triangle-tiles': 0.45,
  'hex-tiles': 0.45,
}

export function isCanvasBackgroundTheme(value: unknown): value is CanvasBackgroundTheme {
  return typeof value === 'string' && (CANVAS_BACKGROUNDS as readonly string[]).includes(value)
}

const isIntensity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** The stored shape, rebuilt from known fields only — the native preference
 *  validator (main/policy.ts) stores the result and refuses null, and the
 *  renderer resolves through the same check, so a corrupt or foreign value
 *  can never reach the canvas as anything but the dot grid. */
export function sanitizeCanvasBackground(value: unknown): CanvasBackgroundPreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as { theme?: unknown; intensities?: unknown }
  if (!isCanvasBackgroundTheme(v.theme)) return null
  const out: CanvasBackgroundPreference = { theme: v.theme }
  if (v.intensities !== undefined) {
    if (!v.intensities || typeof v.intensities !== 'object' || Array.isArray(v.intensities)) return null
    const intensities: Partial<Record<CanvasBackgroundTheme, number>> = {}
    for (const [key, val] of Object.entries(v.intensities)) {
      if (!isCanvasBackgroundTheme(key) || !isIntensity(val)) return null
      intensities[key] = val
    }
    out.intensities = intensities
  }
  return out
}

/** What the canvas draws: the stored preference with every intensity filled
 *  in. Anything unusable resolves to the original dot grid. */
export function resolveCanvasBackground(value: unknown): ResolvedCanvasBackground {
  const pref = sanitizeCanvasBackground(value)
  if (!pref) return { theme: 'dots', intensities: { ...DEFAULT_CANVAS_INTENSITIES } }
  return { theme: pref.theme, intensities: { ...DEFAULT_CANVAS_INTENSITIES, ...pref.intensities } }
}

/** The resolved background inside a whole preferences object. */
export const canvasBackgroundOf = (prefs: unknown): ResolvedCanvasBackground =>
  resolveCanvasBackground(
    prefs && typeof prefs === 'object'
      ? (prefs as { canvasBackground?: unknown }).canvasBackground
      : undefined)
