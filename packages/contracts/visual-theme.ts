/** Appearance only: never use these values as provider or route identities. */
export const VISUAL_THEMES = ['orgtree', 'claude', 'codex', 'antigravity', 'openrouter'] as const
export type VisualTheme = typeof VISUAL_THEMES[number]
export function isVisualTheme(value: unknown): value is VisualTheme {
  return typeof value === 'string' && (VISUAL_THEMES as readonly string[]).includes(value)
}
