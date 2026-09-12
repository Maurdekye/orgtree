/** Appearance only: never use these values as provider or route identities. */
export const VISUAL_THEMES = ['orgtree', 'claude', 'codex', 'antigravity', 'openrouter'] as const
export type PresetVisualTheme = typeof VISUAL_THEMES[number]
export type VisualTheme = PresetVisualTheme | `custom:#${string}`
export const isCustomTheme = (value: unknown): value is `custom:#${string}` =>
  typeof value === 'string' && /^custom:#[0-9a-f]{6}$/i.test(value)
export function isVisualTheme(value: unknown): value is VisualTheme {
  return typeof value === 'string' && ((VISUAL_THEMES as readonly string[]).includes(value) || isCustomTheme(value))
}

export const THEME_ACCENTS: Record<PresetVisualTheme, string> = {
  orgtree: '#b6bdc8',
  claude: '#d97757',
  codex: '#22c4bd',
  antigravity: '#75a5ff',
  openrouter: '#b69afa',
}

export function themeAccent(theme?: VisualTheme | string | null): string {
  if (typeof theme === 'string') {
    if (isCustomTheme(theme)) return theme.slice(7)
    if (theme in THEME_ACCENTS) return THEME_ACCENTS[theme as PresetVisualTheme]
  }
  return THEME_ACCENTS.claude
}
