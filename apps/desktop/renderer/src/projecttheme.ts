// projecttheme.ts — a project's theme colour and icon
// (USER 2026-10-28 10:27:49Z m1c0bc6c121e9): the data every surface shares.
// The engine stores both in the project's scope and sends them on its tree
// record (`theme_color` / `theme_icon`, null when unset); the user sets them
// in the project's settings (canvas/projecttheme.tsx, the `set_theme` op).
//
// The icon replaces the folder icon everywhere the one project mark is
// drawn (canvas/identity.tsx `TierChip`, its DOM twin for markdown links,
// and the canvas cards), in the chosen colour and nothing else — no border
// or header tint. Marks are drawn by NAME on most surfaces (a chip beside a
// name in a mail row holds no node), so this module keeps the current
// trees' themes by name: `hydrateTree` (archived.ts) notes every tree that
// arrives, in every window, and the mark subscribes. A name the store has
// never seen draws as the folder, which is also the unset answer.
import type { TreePayload } from './types'
import { getProjectIcon } from './api'
import { PROJECT_ICON_SVG } from './projecticonpaths'

export interface ProjectTheme {
  /** `#rrggbb`; absent = the default colour */
  color?: string
  /** a PROJECT_ICONS id; absent = the folder */
  icon?: string
  /** an uploaded icon's SHA-256 (@item:orgtree/project-themes-colour-the-
   *  whole-project-node-by-i): drawn in its own colours instead of `icon`
   *  once its image is read (projectIconImage); until then, `icon` */
  custom?: string
}

export interface ProjectIconMeta {
  id: string
  label: string
  /** extra words the settings search matches */
  keywords: string
}

/** The built-in set the picker offers: the app's own icons (icons.ts, MUI),
 *  folder first as the default. Keep ids in step with PROJECT_ICON_SVG
 *  (projecticonpaths.ts, generated) and canvas/projecttheme.tsx's glyphs. */
export const PROJECT_ICONS: ProjectIconMeta[] = [
  { id: 'folder', label: 'Folder', keywords: 'default files' },
  { id: 'apps', label: 'Apps', keywords: 'grid tiles' },
  { id: 'bell', label: 'Bell', keywords: 'alerts notifications' },
  { id: 'bolt', label: 'Bolt', keywords: 'fast energy lightning' },
  { id: 'book', label: 'Book', keywords: 'read docs manual' },
  { id: 'briefcase', label: 'Briefcase', keywords: 'work job office' },
  { id: 'bug', label: 'Bug', keywords: 'defect issue' },
  { id: 'camera', label: 'Camera', keywords: 'photo picture' },
  { id: 'cart', label: 'Cart', keywords: 'shop store buy' },
  { id: 'chart', label: 'Chart', keywords: 'graph growth stats' },
  { id: 'chip', label: 'Chip', keywords: 'cpu memory hardware' },
  { id: 'clipboard', label: 'Clipboard', keywords: 'task assignment list' },
  { id: 'clock', label: 'Clock', keywords: 'time schedule' },
  { id: 'cloud', label: 'Cloud', keywords: 'server sky' },
  { id: 'code', label: 'Code', keywords: 'developer programming' },
  { id: 'data', label: 'Data', keywords: 'usage circle' },
  { id: 'database', label: 'Database', keywords: 'storage disk' },
  { id: 'diamond', label: 'Diamond', keywords: 'gem premium' },
  { id: 'document', label: 'Document', keywords: 'file page description' },
  { id: 'flag', label: 'Flag', keywords: 'milestone marker' },
  { id: 'flask', label: 'Flask', keywords: 'science experiment lab research' },
  { id: 'games', label: 'Games', keywords: 'play controller esports' },
  { id: 'github', label: 'GitHub', keywords: 'git repo' },
  { id: 'globe', label: 'Globe', keywords: 'public world web' },
  { id: 'heart', label: 'Heart', keywords: 'favourite like love' },
  { id: 'home', label: 'Home', keywords: 'house' },
  { id: 'hub', label: 'Hub', keywords: 'nodes network' },
  { id: 'key', label: 'Key', keywords: 'access password vpn' },
  { id: 'layers', label: 'Layers', keywords: 'stack' },
  { id: 'lightbulb', label: 'Lightbulb', keywords: 'idea' },
  { id: 'lock', label: 'Lock', keywords: 'private secure' },
  { id: 'mail', label: 'Mail', keywords: 'inbox letter' },
  { id: 'map', label: 'Map', keywords: 'place location' },
  { id: 'megaphone', label: 'Megaphone', keywords: 'campaign announce broadcast' },
  { id: 'mind', label: 'Mind', keywords: 'psychology brain think' },
  { id: 'money', label: 'Money', keywords: 'cash finance dollar' },
  { id: 'movie', label: 'Movie', keywords: 'film video' },
  { id: 'music', label: 'Music', keywords: 'audio song note' },
  { id: 'network', label: 'Network', keywords: 'lan connections' },
  { id: 'palette', label: 'Palette', keywords: 'art design colour' },
  { id: 'paw', label: 'Paw', keywords: 'pets animal cat dog' },
  { id: 'puzzle', label: 'Puzzle', keywords: 'extension piece plugin' },
  { id: 'rocket', label: 'Rocket', keywords: 'launch ship space' },
  { id: 'school', label: 'School', keywords: 'learn class education' },
  { id: 'sensors', label: 'Sensors', keywords: 'listeners radio' },
  { id: 'shield', label: 'Shield', keywords: 'security safe protect' },
  { id: 'sliders', label: 'Sliders', keywords: 'tune settings adjust' },
  { id: 'snowflake', label: 'Snowflake', keywords: 'cold frozen winter' },
  { id: 'sparkles', label: 'Sparkles', keywords: 'magic awesome ai' },
  { id: 'star', label: 'Star', keywords: 'favourite' },
  { id: 'tag', label: 'Tag', keywords: 'label name' },
  { id: 'team', label: 'Team', keywords: 'groups people' },
  { id: 'terminal', label: 'Terminal', keywords: 'console shell command' },
  { id: 'translate', label: 'Translate', keywords: 'language' },
  { id: 'tree', label: 'Tree', keywords: 'account hierarchy branches' },
  { id: 'wrench', label: 'Wrench', keywords: 'build tools fix' },
]

const ICON_IDS = new Set(PROJECT_ICONS.map((i) => i.id))

/** The preset colours beside the custom field; each reads on the light and
 *  dark themes alike. The first few are the app's own theme accents
 *  (themes.tsx), so a project can wear the colour its org already uses. */
export const PROJECT_THEME_COLORS: { name: string; value: string }[] = [
  { name: 'Rose', value: '#e11d48' },
  { name: 'Terracotta', value: '#d97757' },
  { name: 'Amber', value: '#d97706' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Teal', value: '#0f766e' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Pink', value: '#db2777' },
]

export const isProjectThemeColor = (v: unknown): v is string =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)

export const isProjectThemeIcon = (v: unknown): v is string =>
  typeof v === 'string' && ICON_IDS.has(v)

export const isProjectIconHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

/** The icon id to draw: the chosen one, or the folder when unset or one
 *  this build does not know (a newer engine's pick, say). */
export const projectIconId = (theme?: ProjectTheme | null): string =>
  theme && isProjectThemeIcon(theme.icon) ? theme.icon : 'folder'

/** The DOM twin's drawing of an icon (generated inner SVG markup). */
export const projectIconSvg = (theme?: ProjectTheme | null): string =>
  PROJECT_ICON_SVG[projectIconId(theme)] ?? PROJECT_ICON_SVG['folder']!

/** Structural on purpose, as archived.ts's Summarisable: the canvas passes
 *  CanvasNode, the tree walk TreeNode, and only these fields are read. */
type ThemedNode = {
  id: string
  kind?: string | null
  theme_color?: unknown
  theme_icon?: unknown
  theme_icon_custom?: unknown
  configured_scope?: unknown
} &
  { children?: ThemedNode[] }

/** A node's own theme, from its tree fields (older payloads may carry them
 *  only in `configured_scope`). Malformed values read as unset, as the
 *  engine reads them. */
export function projectThemeFromNode(node?: ThemedNode | null): ProjectTheme | undefined {
  if (!node || node.kind !== 'project') return undefined
  const scope = (node.configured_scope ?? {}) as { theme_color?: unknown; theme_icon?: unknown; theme_icon_custom?: unknown }
  const color = node.theme_color ?? scope.theme_color
  const icon = node.theme_icon ?? scope.theme_icon
  const custom = node.theme_icon_custom ?? scope.theme_icon_custom
  const theme: ProjectTheme = {}
  if (isProjectThemeColor(color)) theme.color = color.toLowerCase()
  if (isProjectThemeIcon(icon)) theme.icon = icon
  if (isProjectIconHash(custom)) theme.custom = custom
  return theme.color || theme.icon || theme.custom ? theme : undefined
}

/* ── the by-name store the marks read ──────────────────────────────────── */

const byOrg = new Map<string, Map<string, string>>()
let currentOrg = ''
const listeners = new Set<() => void>()

const themeKey = (t: ProjectTheme): string => `${t.color ?? ''}|${t.icon ?? ''}|${t.custom ?? ''}`

/** Parse a store key back (useProjectTheme shares it). */
export function themeOfKey(key: string): ProjectTheme | undefined {
  if (!key) return undefined
  const [color, icon, custom] = key.split('|')
  const theme: ProjectTheme = {}
  if (color) theme.color = color
  if (icon) theme.icon = icon
  if (custom) theme.custom = custom
  return theme
}

/** Note one tree's project themes (called from `hydrateTree`, so every
 *  tree in every window feeds it). A rename or clear replaces the org's
 *  whole map, so a stale name never outlives the tree that dropped it. */
export function noteProjectThemes(tree: TreePayload): void {
  const next = new Map<string, string>()
  const walk = (n: ThemedNode) => {
    const theme = projectThemeFromNode(n)
    if (theme) next.set(n.id, themeKey(theme))
    if (theme?.custom) iconSources.set(theme.custom, { org: tree.slug ?? '', name: n.id })
    for (const child of n.children ?? []) walk(child)
  }
  for (const root of tree.roots ?? []) walk(root as ThemedNode)
  const org = tree.slug ?? ''
  const before = byOrg.get(org)
  currentOrg = org
  const same = before && before.size === next.size &&
    [...next].every(([k, v]) => before.get(k) === v)
  if (same) return
  byOrg.set(org, next)
  for (const fn of listeners) fn()
}

export function subscribeProjectThemes(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** The stable snapshot string for one name (`''` = no theme). The current
 *  org answers first; another org's same-named project is the fallback a
 *  cross-org surface gets, as with tier lookups by name. */
export function projectThemeKeyOf(name?: string | null): string {
  if (!name) return ''
  const here = byOrg.get(currentOrg)?.get(name)
  if (here) return here
  for (const [org, map] of byOrg) {
    if (org === currentOrg) continue
    const found = map.get(name)
    if (found) return found
  }
  return ''
}

export function projectThemeOf(name?: string | null): ProjectTheme | undefined {
  return themeOfKey(projectThemeKeyOf(name))
}

/* ── uploaded icons: read once per hash, by their own route ─────────────── */

/** where each hash can be read (the org and project whose tree named it) */
const iconSources = new Map<string, { org: string; name: string }>()
/** hash → PNG data URL, or null while reading / after a failed read */
const iconImages = new Map<string, string | null>()
const imageListeners = new Set<() => void>()

export function subscribeProjectIcons(fn: () => void): () => void {
  imageListeners.add(fn)
  return () => { imageListeners.delete(fn) }
}

/** The uploaded image for a hash as a PNG data URL, or undefined until it
 *  has been read (the first ask starts the read; the mark then draws its
 *  built-in icon meanwhile). Only a picture whose engine-verified hash is
 *  the one asked for is kept, and only ever as a PNG data URL. */
export function projectIconImage(sha?: string | null): string | undefined {
  if (!sha) return undefined
  const known = iconImages.get(sha)
  if (known !== undefined) return known ?? undefined
  const source = iconSources.get(sha)
  if (!source?.org) return undefined
  iconImages.set(sha, null)
  getProjectIcon(source.org, source.name).then((r) => {
    const p = r?.picture
    if (p?.data && p.sha256 === sha) {
      iconImages.set(sha, 'data:image/png;base64,' + p.data)
      for (const fn of imageListeners) fn()
    } else iconImages.delete(sha)
  }, () => { iconImages.delete(sha) })
  return undefined
}
