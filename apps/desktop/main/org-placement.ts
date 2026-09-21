/** WHERE EACH ORGANIZATION'S WINDOW AND PANELS WERE, so reopening an
 *  organization puts them back.
 *
 *  ⚠ WHY window-placement.ts IS NOT ENOUGH. It stores ONE `{ bounds,
 *  maximized }` record, because v2 had one main window. v3 has one per
 *  organization plus its own popped-out desks and panels, and the settled
 *  behavior is that reopening an organization restores ONLY that
 *  organization's previously open popouts in their saved positions. One record
 *  cannot express that, so the file gains a schema — and the existing file is
 *  migrated rather than discarded, so nobody's window jumps to the middle of
 *  the screen the first time they run a v3 build.
 *
 *  ⚠ NO NEW PLACEMENT ALGORITHM. `fitWindow` from window-placement.ts is
 *  reused verbatim for every restore, so a saved rectangle on a monitor that
 *  has gone away is recovered exactly the way it is today. This module decides
 *  WHICH rectangle to look up, never how to fit one.
 *
 *  ⚠ THE POPOUT RECORD IS THE OPEN SET, NOT A POSITION CACHE. Closing an
 *  individual popout deletes its record, because the settled behavior says a
 *  popout the user closed must not come back when the organization is
 *  reopened. The cost is that a deliberately closed popout also forgets where
 *  it was, which is the right trade: resurrecting a window somebody closed is
 *  a bug, and remembering the position of one they will reopen from scratch is
 *  a nicety. */
import fs from 'node:fs'
import path from 'node:path'
import { fitWindow, type Bounds, type Placement } from './window-placement'
import type { OrgWindowIdentity } from '../../../packages/contracts/desktop-window'

/** One saved main window. `key` is `homepage` or `org:<slug>`; a Create window
 *  is never saved, because creation drafts are deliberately not persisted. */
export interface SavedWindowPlacement { key: string; placement: Placement }
export interface SavedPopoutPlacement { org: string; name: string; placement: Placement }

export interface OrgPlacementFile {
  version: 2
  /** The v2-era single placement, kept as the starting geometry for a window
   *  that has no record of its own. Without it the very first v3 launch would
   *  throw away a position the user had already chosen. */
  default?: Placement
  /** In restore order. */
  windows: SavedWindowPlacement[]
  popouts: SavedPopoutPlacement[]
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
 *  spread with the object-spread operator copies the object but ALIASES its
 *  two arrays, so
 *  every store that started from a missing or damaged file would push into the
 *  same `windows` and `popouts` — one organization's saved geometry appearing
 *  in another profile's file. Caught by the per-org tests. */
const empty = (): OrgPlacementFile => ({ version: 2, windows: [], popouts: [] })

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
    return validPlacement(raw) ? { version: 2, default: raw as Placement, windows: [], popouts: [] } : empty()
  }
  const windows = Array.isArray(value.windows)
    ? value.windows.filter((entry): entry is SavedWindowPlacement =>
      !!entry && typeof entry === 'object' && typeof (entry as SavedWindowPlacement).key === 'string'
      && !!(entry as SavedWindowPlacement).key && validPlacement((entry as SavedWindowPlacement).placement))
    : []
  const popouts = Array.isArray(value.popouts)
    ? value.popouts.filter((entry): entry is SavedPopoutPlacement =>
      !!entry && typeof entry === 'object' && typeof (entry as SavedPopoutPlacement).org === 'string'
      && !!(entry as SavedPopoutPlacement).org && typeof (entry as SavedPopoutPlacement).name === 'string'
      && !!(entry as SavedPopoutPlacement).name && validPlacement((entry as SavedPopoutPlacement).placement))
    : []
  return { version: 2, ...(validPlacement(value.default) ? { default: value.default } : {}), windows, popouts }
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
  /** Which popouts that organization had open when it was last saved. */
  savedPopouts(org: string): string[] {
    return this.value.popouts.filter(entry => entry.org === org).map(entry => entry.name)
  }

  restoreWindow(key: string, areas: Bounds[]): Placement | undefined {
    const saved = this.value.windows.find(entry => entry.key === key)?.placement ?? this.value.default
    return saved && { bounds: fitWindow(saved.bounds, areas), maximized: saved.maximized }
  }
  restorePopout(org: string, name: string, areas: Bounds[]): Placement | undefined {
    const saved = this.value.popouts.find(entry => entry.org === org && entry.name === name)?.placement
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
  capturePopout(org: string, name: string, window: PlacementCaptureWindow): void {
    const placement = readPlacement(window)
    if (!placement) return
    const existing = this.value.popouts.find(entry => entry.org === org && entry.name === name)
    if (existing) {
      if (samePlacement(existing.placement, placement)) return
      existing.placement = placement
    } else this.value.popouts.push({ org, name, placement })
    this.write()
  }

  /** The user closed this popout deliberately. Forgetting it is what stops it
   *  reappearing the next time the organization is opened. */
  forgetPopout(org: string, name: string): void {
    const before = this.value.popouts.length
    this.value.popouts = this.value.popouts.filter(entry => !(entry.org === org && entry.name === name))
    if (this.value.popouts.length !== before) this.write()
  }
  /** The organization's window was closed: its own popouts went with it, and
   *  the set that was open is what should come back. Called with the names
   *  that were open at closing time, so a popout the user had already closed
   *  stays closed. */
  rememberOpenPopouts(org: string, names: readonly string[]): void {
    const keep = new Set(names)
    const before = JSON.stringify(this.value.popouts)
    this.value.popouts = this.value.popouts.filter(entry => entry.org !== org || keep.has(entry.name))
    if (JSON.stringify(this.value.popouts) !== before) this.write()
  }
  /** An organization is gone. Nothing about it should be restored again. */
  forgetOrg(org: string): void {
    const before = JSON.stringify(this.value)
    this.value.windows = this.value.windows.filter(entry => orgOfKey(entry.key) !== org)
    this.value.popouts = this.value.popouts.filter(entry => entry.org !== org)
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
