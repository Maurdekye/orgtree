// canvas/projecttheme.tsx — drawing and choosing a project's theme
// (USER 2026-10-28 10:27:49Z m1c0bc6c121e9; data in src/projecttheme.ts).
// `ProjectMark` is the themed span.project-mark every React surface shares
// through canvas/identity.tsx; `ProjectThemeFields` is the settings pair:
// a searchable grid over the built-in icon set, and the colour row (preset
// swatches plus the custom colour field, as themes.tsx's own picker).
import { useState, useSyncExternalStore } from 'react'
import type { CSSProperties, HTMLAttributes } from 'react'
import {
  AppsIcon, BoltIcon, BookIcon, BriefcaseIcon, BugIcon,
  CameraIcon, CampaignIcon, CanvasIcon, CartIcon, ChipIcon, CloudIcon, CodeIcon,
  DataUsageIcon, DiamondIcon, DocIcon, DocketIcon, FlagIcon, FlaskIcon, FolderIcon,
  FrozenIcon, GamesIcon, GitHubIcon, HeartIcon, HomeIcon, HubIcon, KeyIcon, LabelIcon,
  LanIcon, LayersIcon, LightbulbIcon, ListenersIcon, LockIcon, MailIcon, MapIcon,
  MoneyIcon, MovieIcon, MusicIcon, NotificationsIcon, PaletteIcon, PawIcon, PsychologyIcon, PublicIcon,
  PuzzleIcon, RocketIcon, ScheduleIcon, SchoolIcon, ShieldIcon, ShowChartIcon,
  SparkIcon, StarIcon, StorageIcon, TeamIcon, TerminalIcon, TranslateIcon, TuneIcon,
  WrenchIcon,
} from '../icons'
import {
  PROJECT_ICONS, PROJECT_THEME_COLORS, projectIconId, projectThemeKeyOf,
  subscribeProjectThemes,
} from '../projecttheme'
import type { ProjectTheme } from '../projecttheme'
import { SetBlock, SetRow } from './settingskit'

type Glyph = typeof FolderIcon

const GLYPHS: Record<string, Glyph> = {
  folder: FolderIcon, apps: AppsIcon, bell: NotificationsIcon, bolt: BoltIcon,
  book: BookIcon, briefcase: BriefcaseIcon, bug: BugIcon, camera: CameraIcon,
  cart: CartIcon, chart: ShowChartIcon, chip: ChipIcon, clipboard: DocketIcon,
  clock: ScheduleIcon, cloud: CloudIcon, code: CodeIcon, data: DataUsageIcon,
  database: StorageIcon, diamond: DiamondIcon, document: DocIcon, flag: FlagIcon,
  flask: FlaskIcon, games: GamesIcon, github: GitHubIcon, globe: PublicIcon,
  heart: HeartIcon, home: HomeIcon, hub: HubIcon, key: KeyIcon, layers: LayersIcon,
  lightbulb: LightbulbIcon, lock: LockIcon, mail: MailIcon, map: MapIcon,
  megaphone: CampaignIcon, mind: PsychologyIcon, money: MoneyIcon, movie: MovieIcon,
  music: MusicIcon, network: LanIcon, palette: PaletteIcon, paw: PawIcon,
  puzzle: PuzzleIcon, rocket: RocketIcon, school: SchoolIcon, sensors: ListenersIcon,
  shield: ShieldIcon, sliders: TuneIcon, snowflake: FrozenIcon, sparkles: SparkIcon,
  star: StarIcon, tag: LabelIcon, team: TeamIcon, terminal: TerminalIcon,
  translate: TranslateIcon, tree: CanvasIcon, wrench: WrenchIcon,
}

/** The chosen icon's glyph alone (the mini node sizes its own span). */
export function ProjectIconGlyph({ theme }: { theme?: ProjectTheme | null }) {
  const Icon = GLYPHS[projectIconId(theme)] ?? FolderIcon
  return <Icon fontSize="inherit" />
}

/** One name's theme, live: re-renders when a tree carrying it arrives. */
export function useProjectTheme(name?: string | null): ProjectTheme | undefined {
  const key = useSyncExternalStore(subscribeProjectThemes, () => projectThemeKeyOf(name))
  if (!key) return undefined
  const [color, icon] = key.split('|')
  const theme: ProjectTheme = {}
  if (color) theme.color = color
  if (icon) theme.icon = icon
  return theme
}

export interface ProjectMarkProps extends HTMLAttributes<HTMLSpanElement> {
  /** whose mark, for the by-name store; omit with an explicit theme */
  name?: string
  /** an explicit theme wins over the store (a card's own node, a preview) */
  theme?: ProjectTheme | null
}

/** THE project mark: span.project-mark wearing the project's icon in its
 *  colour (inline colour, so it wins over each surface's accent rule), or
 *  the folder in the surface's own colour when unset. */
export function ProjectMark({ name, theme, className, style, ...rest }: ProjectMarkProps) {
  const stored = useProjectTheme(theme === undefined ? name : null)
  const shown = theme === undefined ? stored : theme
  const tint: CSSProperties | undefined = shown?.color ? { color: shown.color, ...style } : style
  return (
    <span {...rest} className={'project-mark' + (className ? ' ' + className : '')} style={tint}>
      <ProjectIconGlyph theme={shown} />
    </span>
  )
}

/** The settings pair (modals.tsx ProjectConfig): fully controlled, values
 *  are the edited picks; null icon = the folder, null colour = default. */
export function ProjectThemeFields({ icon, color, busy = false, onIcon, onColor }: {
  icon: string | null
  color: string | null
  busy?: boolean
  onIcon: (icon: string | null) => void
  onColor: (color: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = PROJECT_ICONS.filter((i) =>
    !q || i.label.toLowerCase().includes(q) || i.id.includes(q) || i.keywords.includes(q))
  const chosen = icon ?? 'folder'
  return <>
    <SetBlock label="Icon" hint="Replaces the folder icon on the mini node, in the corner of the normal node and the desk, and next to its link.">
      <span className="project-icon-picker">
        <input type="search" aria-label="Search icons" placeholder="Search icons" value={query}
          disabled={busy} onChange={(e) => setQuery(e.target.value)} />
        <span className="project-icon-grid" role="group" aria-label="Project icon"
          style={color ? { color } : undefined}>
          {shown.map((i) => {
            const Glyph = GLYPHS[i.id] ?? FolderIcon
            return <button type="button" key={i.id}
              className={'project-icon-pick' + (chosen === i.id ? ' on' : '')}
              aria-label={`Icon: ${i.label}${i.id === 'folder' ? ' (default)' : ''}`}
              aria-pressed={chosen === i.id} title={i.label} disabled={busy}
              onClick={() => onIcon(i.id === 'folder' ? null : i.id)}>
              <Glyph fontSize="inherit" />
            </button>
          })}
          {shown.length === 0 && <span className="dim">No icons match.</span>}
        </span>
      </span>
    </SetBlock>
    <SetRow label="Theme colour" hint="Tints this project's icon wherever it appears, and nothing else.">
      <span className="project-colour-row">
        <button type="button" className={'project-swatch default' + (!color ? ' on' : '')}
          aria-label="Colour: Default" aria-pressed={!color} title="Default colour" disabled={busy}
          onClick={() => onColor(null)} />
        {PROJECT_THEME_COLORS.map((c) => (
          <button type="button" key={c.value}
            className={'project-swatch' + (color === c.value ? ' on' : '')}
            aria-label={`Colour: ${c.name}`} aria-pressed={color === c.value}
            title={`${c.name} ${c.value}`} disabled={busy}
            style={{ background: c.value }} onClick={() => onColor(c.value)} />
        ))}
        <input type="color" aria-label="Custom theme colour" value={color ?? '#e11d48'}
          disabled={busy} onChange={(e) => onColor(e.target.value)} />
        <span className="project-colour-value">{color ?? 'Default'}</span>
      </span>
    </SetRow>
  </>
}
