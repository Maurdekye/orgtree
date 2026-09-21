/** WHERE EACH ORGANIZATION'S MAIN WINDOW WAS, so reopening the organization
 *  puts it back.
 *
 *  ⚠ WHY window-placement.ts IS NOT ENOUGH. It stores ONE `{ bounds,
 *  maximized }` record, because v2 had one main window. v3 has one per
 *  organization, plus a Homepage, and each has its own position. One record
 *  cannot express that, so the file gains a schema — and the existing file is
 *  migrated rather than discarded, so nobody's window jumps to the middle of
 *  the screen the first time they run a v3 build.
 *
 *  ⚠ NO NEW PLACEMENT ALGORITHM. `fitWindow` from window-placement.ts is
 *  reused verbatim for every restore, so a saved rectangle on a monitor that
 *  has gone away is recovered exactly the way it is today. This module decides
 *  WHICH rectangle to look up, never how to fit one.
 *
 *  ⚠ MAIN WINDOWS ONLY — POPOUTS ARE THE RENDERER'S (agreed with the shell
 *  owner, 2026-09-21). A popout's position and the set of panels open for an
 *  organization are already stored by the renderer, in a store keyed by
 *  [org, kind] and shared across every window of this origin, and the
 *  renderer is what opens them. Keeping a second native copy would mean two
 *  writers for one fact, which is how the two disagree about which panels were
 *  open. Native keeps what only native can know: the OS geometry of the main
 *  windows. It still owns popout LIFETIME — closing an organization's window
 *  closes the popouts it owns — but not where they were. */
import fs from 'node:fs'
import path from 'node:path'
import { fitWindow, type Bounds, type Placement } from './window-placement'
import type { OrgWindowIdentity } from '../../../packages/contracts/desktop-window'

/** One saved main window. `key` is `homepage` or `org:<slug>`; a Create window
 *  is never saved, because creation drafts are deliberately not persisted. */
export interface SavedWindowPlacement { key: string; placement: Placement }

export interface OrgPlacementFile {
  version: 2
  /** The v2-era single placement, kept as the starting geometry for a window
   *  that has no record of its own. Without it the very first v3 launch would
   *  throw away a position the user had already chosen. */
  default?: Placement
  /** In restore order. */
  windows: SavedWindowPlacement[]
}

export const HOMEPAGE_KEY = 'homepage'
export function placementKey(identity: Pick<OrgWindowIdentity, 'kind' | 'org'>): string | undefined {
  if (identity.kind === 'org' && identity.org) return `org:${identity.org}`
  if (identity.kind === 'homepage') return HOMEPAGE_KEY
  // A Create window has no saved geometry: it is never restored, because its
  // only content is a draft that is deliberately not persisted.
  return undefined
}
export function orgOfKey(key: string): string | undefined {
  return key.startsWith('org:') ? key.slice(4) : undefined
}

function validBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') return false
  const b = value as Bounds
  return [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0
}
function validPlacement(value: unknown): value is Placement {
  return !!value && typeof value === 'object'
    && validBounds((value as Placement).bounds) && typeof (value as Placement).maximized === 'boolean'
}

/** ⚠ A FUNCTION, NOT A SHARED CONSTANT. A frozen-looking `const EMPTY = {...}`
 *  spread with the object-spread operator copies the object but ALIASES the
 *  array inside it, so every store that started from a missing or damaged file
 *  would push into the SAME `windows` — one profile's saved geometry appearing
 *  in another's file. Caught by the per-org tests. */
const empty = (): OrgPlacementFile => ({ version: 2, windows: [] })

/** READ WHATEVER IS ON DISK AND ANSWER WITH SOMETHING USABLE.
 *
 *  Three shapes arrive here: a v2-era `{ bounds, maximized }`, a v3 file, and
 *  garbage. The first is migrated into `default`; the third produces an empty
 *  file rather than an exception, exactly as WindowPlacement's constructor
 *  already treats a damaged state — a window that cannot be placed from memory
 *  is a default-sized window, never a failure to start.
 *
 *  Pure and exported so the migration is testable without touching a disk. */
export function migratePlacementFile(raw: unknown): OrgPlacementFile {
  if (!raw || typeof raw !== 'object') return empty()
  const value = raw as Partial<OrgPlacementFile> & Partial<Placement>
  if (value.version !== 2) {
    // The v2-era file, or anything else with a usable rectangle in it.
    return validPlacement(raw) ? { version: 2, default: raw as Placement, windows: [] } : empty()
  }
  const windows = Array.isArray(value.windows)
    ? value.windows.filter((entry): entry is SavedWindowPlacement =>
      !!entry && typeof entry === 'object' && typeof (entry as SavedWindowPlacement).key === 'string'
      && !!(entry as SavedWindowPlacement).key && validPlacement((entry as SavedWindowPlacement).placement))
    : []
  return { version: 2, ...(validPlacement(value.default) ? { default: value.default } : {}), windows }
}

export interface PlacementCaptureWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  getNormalBounds(): Bounds
}

export class OrgPlacement {
  private value: OrgPlacementFile
  constructor(private file: string) {
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { raw = undefined }
    this.value = migratePlacementFile(raw)
  }

  /** The saved main windows, in restore order. */
  savedWindows(): readonly SavedWindowPlacement[] { return this.value.windows }

  restoreWindow(key: string, areas: Bounds[]): Placement | undefined {
    const saved = this.value.windows.find(entry => entry.key === key)?.placement ?? this.value.default
    return saved && { bounds: fitWindow(saved.bounds, areas), maximized: saved.maximized }
  }

  captureWindow(key: string, window: PlacementCaptureWindow): void {
    const placement = readPlacement(window)
    if (!placement) return
    const existing = this.value.windows.find(entry => entry.key === key)
    if (existing) {
      if (samePlacement(existing.placement, placement)) return
      existing.placement = placement
    } else this.value.windows.push({ key, placement })
    this.write()
  }
  /** An organization is gone. Nothing about it should be restored again. */
  forgetOrg(org: string): void {
    const before = JSON.stringify(this.value)
    this.value.windows = this.value.windows.filter(entry => orgOfKey(entry.key) !== org)
    if (JSON.stringify(this.value) !== before) this.write()
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(this.value), { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }
}

/** Minimized window coordinates are not the user's desired next view — the
 *  same rule WindowPlacement.capture applies, for the same reason. */
function readPlacement(window: PlacementCaptureWindow): Placement | undefined {
  if (window.isDestroyed() || window.isMinimized()) return undefined
  const bounds = window.getNormalBounds()
  if (!validBounds(bounds)) return undefined
  return { bounds, maximized: window.isMaximized() }
}
function samePlacement(a: Placement, b: Placement): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
