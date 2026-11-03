// canvas/projecttheme.tsx — drawing and choosing a project's theme
// (USER 2026-10-28 10:27:49Z m1c0bc6c121e9; data in src/projecttheme.ts).
// `ProjectMark` is the themed span.project-mark every React surface shares
// through canvas/identity.tsx; `ProjectThemeFields` is the settings pair:
// a searchable grid over the built-in icon set, and the colour row (preset
// swatches plus the custom colour field, as themes.tsx's own picker).
import { useRef, useState, useSyncExternalStore } from 'react'
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
  PROJECT_ICONS, PROJECT_THEME_COLORS, projectIconId, projectIconImage, projectThemeKeyOf,
  subscribeProjectIcons, subscribeProjectThemes, themeOfKey,
} from '../projecttheme'
import type { ProjectTheme } from '../projecttheme'
import { SetBlock, SetRow } from './settingskit'

type Glyph = typeof FolderIcon

/** What the Upload icon… field takes; the engine re-checks the bytes. */
export const PROJECT_ICON_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
export const PROJECT_ICON_MAX_BYTES = 2 * 1024 * 1024
const FORMATS_MESSAGE = 'Choose a PNG, JPEG, WebP or SVG image up to 2 MB.'

/** Check a picked file and turn it into the base64 the engine takes: PNG,
 *  JPEG and WebP as they are (the engine decodes and normalises them), an
 *  SVG rasterised here to a 256 PNG through an <img> (which runs no script
 *  and loads nothing external), so no markup ever leaves the renderer.
 *  Rejects with the message to show. */
export async function projectIconUpload(file: File): Promise<string> {
  const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : '')
  if (!PROJECT_ICON_UPLOAD_TYPES.includes(type)) throw new Error(FORMATS_MESSAGE)
  if (file.size > PROJECT_ICON_MAX_BYTES) throw new Error('That file is over 2 MB. ' + FORMATS_MESSAGE)
  if (type === 'image/svg+xml') return rasterise(file)
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) }
  catch { throw new Error('That file could not be read.') }
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function rasterise(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => fail(new Error('That SVG could not be drawn. ' + FORMATS_MESSAGE))
      i.src = url
    })
    const side = 256
    const w = img.naturalWidth || side, h = img.naturalHeight || side
    const scale = Math.min(side / w, side / h)
    const canvas = document.createElement('canvas')
    canvas.width = side; canvas.height = side
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('That SVG could not be drawn. ' + FORMATS_MESSAGE)
    ctx.drawImage(img, (side - w * scale) / 2, (side - h * scale) / 2, w * scale, h * scale)
    const png = canvas.toDataURL('image/png')
    return png.slice(png.indexOf(',') + 1)
  } finally { URL.revokeObjectURL(url) }
}

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

/** An uploaded icon's image, live: re-renders once its read lands. */
export function useProjectIconImage(sha?: string | null): string | undefined {
  return useSyncExternalStore(subscribeProjectIcons, () => projectIconImage(sha))
}

/** The chosen icon's glyph alone (the mini node sizes its own span): an
 *  uploaded icon as a PNG image in its own colours (never tinted, never
 *  markup), else the built-in glyph, which also stands in while it loads. */
export function ProjectIconGlyph({ theme }: { theme?: ProjectTheme | null }) {
  const src = useProjectIconImage(theme?.custom)
  if (src) return <img className="project-icon-img" src={src} alt="" draggable={false} />
  const Icon = GLYPHS[projectIconId(theme)] ?? FolderIcon
  return <Icon fontSize="inherit" />
}

/** One name's theme, live: re-renders when a tree carrying it arrives. */
export function useProjectTheme(name?: string | null): ProjectTheme | undefined {
  const key = useSyncExternalStore(subscribeProjectThemes, () => projectThemeKeyOf(name))
  return themeOfKey(key)
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
export function ProjectThemeFields({ icon, color, custom = null, busy = false, uploadError = null,
  onIcon, onColor, onUpload, onRemoveUpload }: {
  icon: string | null
  color: string | null
  /** the uploaded icon's hash while it is the chosen icon */
  custom?: string | null
  busy?: boolean
  /** why the last upload was refused, shown under the grid */
  uploadError?: string | null
  onIcon: (icon: string | null) => void
  onColor: (color: string | null) => void
  onUpload?: (file: File) => void
  onRemoveUpload?: () => void
}) {
  const [query, setQuery] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const shown = PROJECT_ICONS.filter((i) =>
    !q || i.label.toLowerCase().includes(q) || i.id.includes(q) || i.keywords.includes(q))
  const chosen = custom ? null : icon ?? 'folder'
  return <>
    <SetBlock label="Icon" hint="Replaces the folder icon on the mini node, in the corner of the normal node and the desk, and next to its link. An uploaded PNG, JPEG, WebP or SVG (up to 2 MB) shows in its own colours.">
      <span className="project-icon-picker">
        <span className="project-icon-actions">
          <input type="search" aria-label="Search icons" placeholder="Search icons" value={query}
            disabled={busy} onChange={(e) => setQuery(e.target.value)} />
          {onUpload && <button type="button" aria-label="Upload icon…" disabled={busy}
            onClick={() => fileRef.current?.click()}>Upload icon…</button>}
          {onRemoveUpload && custom && <button type="button" aria-label="Remove uploaded icon" disabled={busy}
            onClick={onRemoveUpload}>Remove upload</button>}
          {onUpload && <input ref={fileRef} type="file" hidden aria-label="Upload icon file"
            accept={PROJECT_ICON_UPLOAD_TYPES.join(',')}
            onChange={(e) => { const file = e.currentTarget.files?.[0]; if (file) onUpload(file); e.currentTarget.value = '' }} />}
        </span>
        {uploadError && <span className="project-icon-error" role="alert">{uploadError}</span>}
        <span className="project-icon-grid" role="group" aria-label="Project icon"
          style={color ? { color } : undefined}>
          {custom && <button type="button" key="uploaded" className="project-icon-pick on"
            aria-label="Icon: Uploaded" aria-pressed title="Uploaded icon" disabled={busy}>
            <ProjectIconGlyph theme={{ custom }} />
          </button>}
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
    <SetRow label="Theme colour" hint="Colours this project's node, as an agent node wears its accent, and its built-in icon wherever it appears.">
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
