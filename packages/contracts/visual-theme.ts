/** Appearance only: never use these values as provider or route identities. */
export const VISUAL_THEMES = ['orgtree', 'claude', 'codex', 'antigravity', 'openrouter'] as const
export type PresetVisualTheme = typeof VISUAL_THEMES[number]
export type VisualTheme = PresetVisualTheme | `custom:#${string}`
export const isCustomTheme = (value: unknown): value is `custom:#${string}` =>
  typeof value === 'string' && /^custom:#[0-9a-f]{6}$/i.test(value)
export function isVisualTheme(value: unknown): value is VisualTheme {
  return typeof value === 'string' && ((VISUAL_THEMES as readonly string[]).includes(value) || isCustomTheme(value))
}
