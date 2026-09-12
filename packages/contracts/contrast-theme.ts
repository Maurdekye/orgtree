/** Surface lightness is independent of the visual theme's accent color. */
export const CONTRAST_THEMES = ['charcoal', 'light', 'solarized-light', 'obsidian-black'] as const
export type ContrastTheme = typeof CONTRAST_THEMES[number]
export const DEFAULT_CONTRAST: ContrastTheme = 'charcoal'
export const isContrastTheme = (value: unknown): value is ContrastTheme =>
  typeof value === 'string' && (CONTRAST_THEMES as readonly string[]).includes(value)
