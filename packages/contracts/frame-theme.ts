/** Orgtree's current colors as HTML presentations and app panels receive them
 *  (USER 2026-10-27 m4e1fae02a0ca "feed the current theme coloring into html
 *  presentations and apps"; m164909566caf "both the main visual theme color and
 *  the contrast theme colors"). Pages opt in: each color is a CSS custom
 *  property `--orgtree-<kebab name>` with zero specificity, so a page's own
 *  colors and `:root` rules always win. Names describe their use, not the
 *  app's internal tokens; the renderer maps them (frametheme.ts). */
export const FRAME_THEME_COLORS = [
  // the main visual theme: its accent family
  'accent', 'accentHover', 'accentSoft', 'accentText',
  // the contrast theme: surfaces, text, borders and status colors
  'bg', 'sidebar', 'card', 'hover', 'input',
  'text', 'textStrong', 'textDim', 'border', 'borderSoft',
  'success', 'danger', 'warning',
] as const
export type FrameThemeColor = typeof FRAME_THEME_COLORS[number]
export interface FrameTheme {
  /** `light` on the Light and Solarized Light contrast themes, else `dark`. */
  colorScheme: 'dark' | 'light'
  /** Concrete sRGB colors: `#rrggbb`, or `rgba(r, g, b, a)` when translucent.
   *  A color the app cannot resolve is absent, so the page's fallback applies. */
  colors: Partial<Record<FrameThemeColor, string>>
}

export const frameThemeProperty = (name: FrameThemeColor) =>
  '--orgtree-' + name.replace(/[A-Z]/g, c => '-' + c.toLowerCase())

const OPAQUE = /^#[0-9a-f]{6}$/
const TRANSLUCENT = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|0\.\d{1,3})\)$/

export function isFrameColor(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (OPAQUE.test(value)) return true
  const m = TRANSLUCENT.exec(value)
  return !!m && [m[1], m[2], m[3]].every(c => Number(c) <= 255)
}

export function isFrameTheme(value: unknown): value is FrameTheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const theme = value as Record<string, unknown>
  if (Object.keys(theme).some(key => key !== 'colorScheme' && key !== 'colors')) return false
  if (theme.colorScheme !== 'dark' && theme.colorScheme !== 'light') return false
  const colors = theme.colors
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return false
  return Object.entries(colors).every(([name, color]) =>
    (FRAME_THEME_COLORS as readonly string[]).includes(name) && isFrameColor(color))
}

/** The page stylesheet: one zero-specificity root rule of our names only. */
export function frameThemeCss(theme: FrameTheme): string {
  const vars = FRAME_THEME_COLORS.flatMap(name => {
    const color = theme.colors[name]
    return isFrameColor(color) ? [`${frameThemeProperty(name)}:${color}`] : []
  })
  return `:where(:root){${[...vars, `--orgtree-color-scheme:${theme.colorScheme === 'light' ? 'light' : 'dark'}`].join(';')}}`
}

/** A computed CSS color (`rgb()`, `rgba()` or `color(srgb ...)`, as browsers
 *  serialize them) as a FrameTheme color, or null for anything else. */
export function frameColor(computed: string): string | null {
  const text = computed.trim()
  let rgb: number[], alpha: string | undefined
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(text)
  if (m) rgb = [m[1]!, m[2]!, m[3]!].map(Number)
  else if ((m = /^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(text))) {
    rgb = [m[1]!, m[2]!, m[3]!].map(v => Number(v) * 255)
  } else return null
  alpha = m[4]
  let a = alpha === undefined ? 1 : alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha)
  if (![...rgb, a].every(Number.isFinite)) return null
  const [r, g, b] = rgb.map(v => Math.min(255, Math.max(0, Math.round(v))))
  a = Math.min(1, Math.max(0, Math.round(a * 1000) / 1000))
  if (a >= 1) return '#' + [r!, g!, b!].map(v => v.toString(16).padStart(2, '0')).join('')
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
