// canvas/staffingoptions.ts — THE renderer's one warm staffing source.
//
// ⚠ THE DEFECT THIS EXISTS FOR (user report 2026-09-15, image-118.png).
// `Staff…` fired its first request when the context menu opened, and behind
// that request the backend ran provider discovery and a live GET to
// openrouter.ai. The menu could not appear until all of it returned. The user's
// ruling widened it past that one menu: NO staffing surface may begin its first
// availability load when it is opened, and every one of them reads the same
// already-loaded answer.
//
// TWO LAYERS, because the data has two shapes.
//
//   * ORG-LEVEL availability — which tiers can be staffed at all, on which
//     accounts, at which efforts. It is the expensive half (it is what runs the
//     network), it is identical for every ticket and every chooser, and it is
//     fetched ONCE when the organization loads. Every staffing surface reads
//     it: the context menus, the hire modal's model and account selects, the
//     effort selects.
//   * PER-TICKET staffing context — where one ticket would be staffed and
//     whether its own hire would be refused. Cheap, and unshareable because it
//     is about one ticket. It is prefetched when a docket row is hovered or
//     focused, which is strictly before the right-click that opens its menu, so
//     the menu consumes a request already in flight or already answered instead
//     of starting one.
//
// SINGLE FLIGHT IS THE POINT, NOT AN OPTIMISATION. A docket of forty rows, a
// hover crossing six of them and an org-level load in progress must produce ONE
// org-level request. Everything here is keyed by the REQUEST PATH and returns
// the same promise while it is in flight, so "prefetch, then open" and "open
// cold" converge on one network call rather than two.
import { req } from '../api'

export interface StaffingAccount {
  /** what a staffing call submits: a managed id, or `provider/primary`. */
  value: string
  /** what a surface prints: the id, or `default` for the ambient login. */
  id: string
  provider: string
  ambient: boolean
  email?: string | null
}
export interface StaffingTier {
  tier: string
  seat: number
  provider?: string
  efforts: string[]
  /** ELIGIBLE accounts only. Empty means this lane has no account at all (an
   *  OpenRouter routed key) — never "none of them work", because a tier whose
   *  accounts are all ineligible is omitted from `tiers` entirely. */
  accounts: StaffingAccount[]
  /** may the tier be chosen WITHOUT naming an account — that is, can the
   *  account a plain hire would pick by itself actually run it. */
  default_ok: boolean
}
export interface StaffingOptions {
  tiers: StaffingTier[]
  at: number
  stale: boolean
  /** non-empty means COULD NOT FIND OUT, which is not the same as "nothing is
   *  available" and must never be rendered as an empty list. */
  errors: string[]
  loading: boolean
  generation: number
}

export const staffingOptionsPath = (org: string) =>
  `/api/orgs/${encodeURIComponent(org)}/staffing-options`

/** How long an answer is reused before the next reader refetches. The BACKEND
 *  holds the real cache and its invalidation; this only stops the renderer
 *  re-asking on every hover. */
export const REUSE_MS = 20_000

interface Entry { value?: unknown; error?: Error; inflight?: Promise<unknown>; at: number }
const held = new Map<string, Entry>()
/** how many network requests each path has actually caused. The pack's
 *  "opening the menu starts no second request" is only checkable if something
 *  counts, and counting here counts the real thing rather than a stand-in. */
const requests = new Map<string, number>()

function load<T>(path: string): Promise<T> {
  const entry = held.get(path)
  // ⚠ IN-FLIGHT FIRST, always. This is the clause that makes "prefetch, then
  // open" one request instead of two: the open finds the prefetch's own promise
  // and waits on it.
  if (entry?.inflight) return entry.inflight as Promise<T>
  if (entry && entry.value !== undefined && Date.now() - entry.at < REUSE_MS) {
    return Promise.resolve(entry.value as T)
  }
  const next: Entry = { ...(entry ?? {}), at: Date.now() }
  requests.set(path, (requests.get(path) ?? 0) + 1)
  next.inflight = req<T>(path).then(value => {
    next.value = value; next.error = undefined; next.at = Date.now()
    return value
  }).catch((e: Error) => {
    // A failure does NOT erase a previous good answer — a menu with a recent
    // valid list beats a menu with none, and `stale`/`errors` is how the
    // surface says which it has. It does clear the in-flight promise, so a
    // retry is a real retry.
    next.error = e
    if (next.value !== undefined) return next.value
    throw e
  }).finally(() => { next.inflight = undefined }) as Promise<unknown>
  held.set(path, next)
  return next.inflight as Promise<T>
}

/** Begin loading this organization's staffing availability NOW. Call it when
 *  the org loads — never from a menu's open handler. Safe to call repeatedly:
 *  it hands back the one in-flight promise rather than starting another. */
export function prefetchStaffingOptions(org: string): Promise<StaffingOptions> {
  return load<StaffingOptions>(staffingOptionsPath(org))
}

/** The availability every chooser renders from. The same call as the prefetch,
 *  named separately so a reading site says what it means. */
export const staffingOptions = prefetchStaffingOptions

/** The already-resolved answer, or undefined. A surface that can render
 *  synchronously reads this and never awaits at all. */
export function peekStaffingOptions(org: string): StaffingOptions | undefined {
  return held.get(staffingOptionsPath(org))?.value as StaffingOptions | undefined
}

/** Begin loading ONE ticket's staffing context, from a docket row's hover or
 *  focus — before the right-click that opens its menu. */
export function prefetchQuickStaff<T>(path: string): Promise<T> {
  return load<T>(path)
}

/** One ticket's already-held staffing context, however old, or undefined.
 *
 *  ⚠ THE MENU READS THIS AND NEVER AWAITS (user ruling 2026-09-15, measured on
 *  beta.5: `Staff…` still showed "Loading current staffing choices…" when it
 *  opened). Held-and-aged beats awaited-and-current here for the same reason
 *  the backend's own cache says a warm read never blocks: a refresh runs behind
 *  the reader, and the staffing DOOR re-checks its own snapshot before it
 *  creates anything, so the worst an aged menu can do is offer a click that is
 *  then refused with a reason. */
export function peekQuickStaff<T>(path: string): T | undefined {
  return held.get(path)?.value as T | undefined
}

/** ⚠ HOW MANY WARM-UPS RUN AT ONCE. One, deliberately. Each of these is a
 *  request the backend answers under its document lock, so firing a docket's
 *  worth of them together would make the app's other calls queue behind the
 *  whole batch — trading a slow menu for a slow everything. Serialised, the
 *  work is invisible and the rows come ready in the order they were drawn. */
const WARM_AT_ONCE = 1
const pendingWarm: string[] = []
let warming = 0

/** Warm ONE ticket's staffing context in the background, from the row's own
 *  mount — that is, as part of the docket appearing, strictly before any
 *  hover and long before any right-click.
 *
 *  Nothing is queued twice: a path that has been asked for at all (in flight,
 *  answered, or failed) is already held, and rows re-render constantly. */
export function queueStaffingWarm(path: string): void {
  if (held.has(path) || pendingWarm.includes(path)) return
  pendingWarm.push(path)
  pumpWarm()
}

function pumpWarm(): void {
  while (warming < WARM_AT_ONCE && pendingWarm.length) {
    const path = pendingWarm.shift()!
    warming += 1
    load(path).catch(() => {}).finally(() => { warming -= 1; pumpWarm() })
  }
}

/** Ask the backend to refresh, then re-read: the recoverable state's retry. It
 *  never blocks a menu, because the backend marks its snapshot stale and warms
 *  behind the call instead of holding it open. */
export function retryStaffingOptions(org: string): Promise<StaffingOptions> {
  const path = staffingOptionsPath(org)
  held.delete(path)
  return req<unknown>(`${path}/refresh`, { method: 'POST' })
    .catch(() => undefined)
    .then(() => prefetchStaffingOptions(org))
}

/** Drop what is held (for one org, or everything). Called when the renderer
 *  learns availability moved — an account added or removed, a sign-in, a
 *  provider toggle — so the next read gets the backend's fresh answer. */
export function invalidateStaffingOptions(org?: string): void {
  if (org === undefined) { held.clear(); return }
  const prefix = `/api/orgs/${encodeURIComponent(org)}/`
  for (const key of [...held.keys()]) {
    if (key.startsWith(prefix)) held.delete(key)
  }
}

/** What the regression pack asserts on, and what a surface reads to explain
 *  itself. `requests` is the count of real network calls this path has caused. */
export function staffingOptionsState(org: string): {
  loaded: boolean; loading: boolean; failed: boolean; requests: number
} {
  const path = staffingOptionsPath(org)
  const entry = held.get(path)
  return {
    loaded: entry?.value !== undefined,
    loading: !!entry?.inflight,
    failed: !!entry?.error && entry?.value === undefined,
    requests: requests.get(path) ?? 0,
  }
}

export function requestCount(path: string): number {
  return requests.get(path) ?? 0
}

export function resetStaffingOptionsForTests(): void {
  held.clear(); requests.clear(); pendingWarm.length = 0; warming = 0
}
