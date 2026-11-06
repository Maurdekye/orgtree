/* attract/docketlog.ts - every docket open and close, from any path, so "two dockets in one window" is measurable even when attract
   mode is not running (coordinator follow-up 2026-11-06 m34e26cd39c88). Records go through the same bridge as the attract trace
   (src `attract`), so they land in diagnostics/ui-attract.jsonl with its OWN rate bucket and never in ui-stalls.jsonl.
   THE USER STREAMS: kind, path and counts only - never an id, title or slug. */

export type DocketKind = 'org' | 'agent' | 'team'
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
let marked: { path: DocketPath; at: number } | null = null

/** the caller says HOW the next docket change comes about; it counts for 2 s and for one change, else the path is `other` */
export function markDocketPath(path: DocketPath): void { marked = { path, at: Date.now() } }

/** dockets standing now, of all kinds */
export function docketInstances(): number { return open.org + open.agent + open.team }
export function resetDocketLog(): void { open.org = open.agent = open.team = 0; marked = null }

/** a docket of `kind` opened or closed: one record with the instance count after the change */
export function docketChanged(kind: DocketKind, action: 'open' | 'close'): void {
  open[kind] = Math.max(0, open[kind] + (action === 'open' ? 1 : -1))
  const path: DocketPath = marked && Date.now() - marked.at <= MARK_MS ? marked.path : 'other'
  marked = null
  try { sink({ ev: 'docket', kind, action, path, count: docketInstances() }) } catch { /* diagnostics only */ }
}
