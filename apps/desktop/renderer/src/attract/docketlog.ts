/* attract/docketlog.ts - every docket open and close, from any path, so "two dockets in one window" is measurable even when attract
   mode is not running (coordinator follow-up 2026-11-06 m34e26cd39c88). Records go through the same bridge as the attract trace
   (src `attract`), so they land in diagnostics/ui-attract.jsonl with its OWN rate bucket and never in ui-stalls.jsonl.
   THE USER STREAMS: kind, path and counts only - never an id, title or slug. */

export type DocketKind = 'org' | 'agent' | 'team'
export type DocketReason = 'run_start'
export type DocketPath = 'attract' | 'user' | 'link' | 'restore' | 'pin' | 'other'

type Sink = (record: Record<string, unknown>) => void
const bridgeSink: Sink = (record) => {
  try {
    const b = (typeof window === 'undefined' ? undefined : (window as unknown as { orgtreeDesktop?: { diagStall?: (r: unknown) => void } }).orgtreeDesktop)
    b?.diagStall?.({ src: 'attract', ...record })
  } catch { /* diagnostics only */ }
}
let sink: Sink = bridgeSink
/** tests capture the records; null restores the bridge */
export function setDocketLogSink(next: Sink | null): void { sink = next ?? bridgeSink }

const open: Record<DocketKind, number> = { org: 0, agent: 0, team: 0 }
const MARK_MS = 2000
let marked: { path: DocketPath; reason?: DocketReason; at: number; left: number } | null = null
/** how to close each floating agent or team docket of this window (a run's start closes them all) */
const closers = new Set<() => void>()
export function registerDocketCloser(fn: () => void): () => void { closers.add(fn); return () => { closers.delete(fn) } }
/** close every floating agent or team docket of this window; how many were closed */
export function closeFloatingDockets(): number { const all = [...closers]; for (const c of all) c(); return all.length }

/** the caller says HOW the next `changes` docket changes come about; it counts for 2 s, else the path is `other` */
export function markDocketPath(path: DocketPath, reason?: DocketReason, changes = 1): void { marked = { path, reason, at: Date.now(), left: changes } }

/** dockets standing now, of all kinds */
export function docketInstances(): number { return open.org + open.agent + open.team }
export function resetDocketLog(): void { open.org = open.agent = open.team = 0; marked = null }

/** a docket of `kind` opened or closed: one record with the instance count after the change */
export function docketChanged(kind: DocketKind, action: 'open' | 'close'): void {
  open[kind] = Math.max(0, open[kind] + (action === 'open' ? 1 : -1))
  const live = marked && marked.left > 0 && Date.now() - marked.at <= MARK_MS ? marked : null
  if (live && --live.left <= 0) marked = null
  const path: DocketPath = live ? live.path : 'other'
  try { sink({ ev: 'docket', kind, action, path, ...(live?.reason ? { reason: live.reason } : {}), count: docketInstances() }) } catch { /* diagnostics only */ }
}
