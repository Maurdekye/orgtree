/** WHERE EACH ORGANIZATION'S MAIN WINDOW WAS, and WHICH ONES TO REOPEN. They
 *  are two different facts and this module keeps them apart on purpose.
 *
 *  ⚠ WHY window-placement.ts IS NOT ENOUGH. It stores ONE `{ bounds,
 *  maximized }` record, because v2 had one main window. v3 has one per
 *  organization, plus a Homepage, and each has its own position. One record
 *  cannot express that, so the file gains a schema — and the existing file is
 *  migrated rather than discarded, so nobody's window jumps to the middle of
 *  the screen the first time they run a v3 build.
 *
 *  ⚠ GEOMETRY IS NOT MEMBERSHIP, and conflating them is a real bug this
 *  module already had. `geometry` remembers where a window was for every
 *  organization ever positioned, indefinitely, so reopening one by hand months
 *  later puts it back where the user left it. `session` is the much smaller
 *  thing startup actually reopens: the windows that were open when the app was
 *  last shut down. Restoring from `geometry` would reopen every organization
 *  the user has ever visited, every launch.
 *
 *  The consequences that follow, and they are the settled behavior:
 *    · Closing organization A on its own removes A from `session`, so the next
 *      startup does not reopen it — but KEEPS A's geometry, so opening it by
 *      hand later puts the window back where it was.
 *    · A quit captures the open set BEFORE teardown, in one call. Teardown
 *      then closes every window, and those closes must NOT be read as the user
 *      closing them: `beginShutdown()` latches that, and without it a graceful
 *      quit would empty `session` and the next launch would restore nothing.
 *    · Geometry is forgotten ONLY on a real deletion. An engine that has not
 *      finished starting, or a backend outage, is not proof an organization is
 *      gone; see `forgetDeletedOrg`.
 *
 *  ⚠ NO NEW PLACEMENT ALGORITHM. `fitWindow` from window-placement.ts is
 *  reused verbatim for every restore, so a saved rectangle on a monitor that
 *  has gone away is recovered exactly the way it is today. This module decides
 *  WHICH rectangle to look up, never how to fit one.
 *
 *  ⚠ MAIN WINDOWS ONLY — POPOUTS ARE THE RENDERER'S (agreed with the shell
 *  owner, 2026-09-21). A popout's position and the set of panels open for an
 *  organization are already stored by the renderer, keyed by [org, kind] and
 *  shared across every window of this origin, and the renderer is what opens
 *  them. A second native copy is how two stores come to disagree. Native still
 *  owns popout LIFETIME — closing an organization's window closes the popouts
 *  it owns — but not where they were or which they were. */
import fs from 'node:fs'
import path from 'node:path'
import { fitWindow, type Bounds, type Placement } from './window-placement'
import type { OrgWindowIdentity } from '../../../packages/contracts/desktop-window'

/** One remembered position. `key` is `homepage` or `org:<slug>`; a Create
 *  window is never saved, because its only content is a draft that is
 *  deliberately not persisted. */
export interface SavedWindowPlacement { key: string; placement: Placement }

export interface OrgPlacementFile {
  version: 2
  /** The v2-era single placement, kept as the starting geometry for a window
   *  that has no record of its own. Without it the very first v3 launch would
   *  throw away a position the user had already chosen. */
  default?: Placement
  /** Every position ever captured. Remembered indefinitely. NOT what startup
   *  reopens — see `session`. */
  geometry: SavedWindowPlacement[]
  /** The startup reopen membership: the window keys that were open when the
   *  app was last shut down, in the order they should come back. */
  session: string[]
}

export const HOMEPAGE_KEY = 'homepage'
export function placementKey(identity: Pick<OrgWindowIdentity, 'kind' | 'org'>): string | undefined {
  if (identity.kind === 'org' && identity.org) return `org:${identity.org}`
  if (identity.kind === 'homepage') return HOMEPAGE_KEY
  // A Create window has no saved geometry and no membership: it is never
  // restored, because its only content is a draft that is not persisted.
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

/** ⚠ A FUNCTION, NOT A SHARED CONSTANT. A `const EMPTY = {...}` copied with
 *  the object-spread operator copies the object but ALIASES the arrays inside
 *  it, so every store built from a missing or damaged file would push into the
 *  SAME arrays — one profile's saved geometry appearing in another's file.
 *  Caught by the per-org tests. */
const empty = (): OrgPlacementFile => ({ version: 2, geometry: [], session: [] })

/** READ WHATEVER IS ON DISK AND ANSWER WITH SOMETHING USABLE.
 *
 *  Three shapes arrive here: a v2-era `{ bounds, maximized }`, a v3 file, and
 *  garbage. The first is migrated into `default`; the third produces an empty
 *  file rather than an exception, exactly as WindowPlacement's constructor
 *  already treats a damaged state — a window that cannot be placed from memory
 *  is a default-sized window, never a failure to start.
 *
 *  A `windows` array written by an earlier draft of this schema is read as
 *  GEOMETRY ONLY and contributes no membership, because that draft could not
 *  tell the two apart and assuming it meant "reopen all of these" would do the
 *  exact thing this split exists to prevent.
 *
 *  Pure and exported so the migration is testable without touching a disk. */
export function migratePlacementFile(raw: unknown): OrgPlacementFile {
  if (!raw || typeof raw !== 'object') return empty()
  const value = raw as Partial<OrgPlacementFile> & Partial<Placement> & { windows?: unknown }
  if (value.version !== 2) {
    // The v2-era file, or anything else with a usable rectangle in it.
    return validPlacement(raw) ? { version: 2, default: raw as Placement, geometry: [], session: [] } : empty()
  }
  const readGeometry = (source: unknown): SavedWindowPlacement[] => Array.isArray(source)
    ? source.filter((entry): entry is SavedWindowPlacement =>
      !!entry && typeof entry === 'object' && typeof (entry as SavedWindowPlacement).key === 'string'
      && !!(entry as SavedWindowPlacement).key && validPlacement((entry as SavedWindowPlacement).placement))
    : []
  const geometry = readGeometry(value.geometry ?? value.windows)
  const known = new Set(geometry.map(entry => entry.key))
  const session = Array.isArray(value.session)
    // Membership names windows; a key with no geometry is not one we can place.
    ? value.session.filter((key): key is string => typeof key === 'string' && !!key && known.has(key))
    : []
  return {
    version: 2,
    ...(validPlacement(value.default) ? { default: value.default } : {}),
    geometry,
    // De-duplicated: one window per key, whatever the file says.
    session: [...new Set(session)],
  }
}

export interface PlacementCaptureWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  getNormalBounds(): Bounds
}

export class OrgPlacement {
  private value: OrgPlacementFile
  /** Latched for the rest of the process once a shutdown begins. See
   *  `beginShutdown`. */
  private shuttingDown = false
  constructor(private file: string) {
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { raw = undefined }
    this.value = migratePlacementFile(raw)
  }

  /** WHAT STARTUP REOPENS — the windows that were open at the last shutdown,
   *  in order. Deliberately NOT every key in `geometry`. */
  sessionWindows(): string[] { return [...this.value.session] }
  /** Every position ever captured. For diagnostics and for asking whether a
   *  key has a remembered position; NEVER the restore list. */
  geometry(): readonly SavedWindowPlacement[] { return this.value.geometry }

  restoreWindow(key: string, areas: Bounds[]): Placement | undefined {
    const saved = this.value.geometry.find(entry => entry.key === key)?.placement ?? this.value.default
    return saved && { bounds: fitWindow(saved.bounds, areas), maximized: saved.maximized }
  }

  /** Remember where this window is. Geometry only: capturing a position says
   *  nothing about whether the window should reopen next launch. */
  captureWindow(key: string, window: PlacementCaptureWindow): void {
    const placement = readPlacement(window)
    if (!placement) return
    const existing = this.value.geometry.find(entry => entry.key === key)
    if (existing) {
      if (samePlacement(existing.placement, placement)) return
      existing.placement = placement
    } else this.value.geometry.push({ key, placement })
    this.write()
  }

  /** This window is open now, so it should reopen next launch. Idempotent and
   *  order-preserving: reopening a window already in the set does not move it. */
  openedWindow(key: string): void {
    if (this.value.session.includes(key)) return
    this.value.session.push(key)
    this.write()
  }

  /** THE USER CLOSED THIS WINDOW DELIBERATELY: drop it from the reopen set,
   *  and KEEP its geometry, so opening it by hand later puts it back where it
   *  was.
   *
   *  ⚠ A no-op once a shutdown has begun. Teardown closes every window, and
   *  if those closes counted as deliberate the quit would empty the reopen set
   *  and the next launch would restore nothing — which is the whole failure
   *  `beginShutdown` exists to prevent. */
  closedWindow(key: string): void {
    if (this.shuttingDown) return
    const before = this.value.session.length
    this.value.session = this.value.session.filter(entry => entry !== key)
    if (this.value.session.length !== before) this.write()
  }

  /** THE APP IS SHUTTING DOWN. Called with the keys that are open at this
   *  moment, BEFORE anything is torn down, and it latches the shutdown so the
   *  teardown's own closes cannot rewrite what was just recorded. */
  beginShutdown(openKeys: readonly string[]): void {
    const next = [...new Set(openKeys.filter(key => !!key))]
    this.shuttingDown = true
    if (JSON.stringify(next) === JSON.stringify(this.value.session)) return
    this.value.session = next
    this.write()
  }

  /** AN ORGANIZATION WAS REALLY DELETED. Forget everything about it, so it is
   *  neither reopened nor placed again.
   *
   *  ⚠ NOT FOR A MISSING ORGANIZATION. An engine still starting, a backend
   *  outage or a failed list all make an organization look absent, and none of
   *  them is proof it was deleted. Startup SKIPS an organization it cannot
   *  find and says so; only a real deletion reaches here. */
  forgetDeletedOrg(org: string): void {
    const key = `org:${org}`
    const before = JSON.stringify(this.value)
    this.value.geometry = this.value.geometry.filter(entry => entry.key !== key)
    this.value.session = this.value.session.filter(entry => entry !== key)
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
