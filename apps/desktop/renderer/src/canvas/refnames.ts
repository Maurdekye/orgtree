// canvas/refnames.ts — the current name a mention shows, for every kind whose
// chip names its target rather than printing its ID: apps and panels (USER
// 2026-10-27 m449dc0a35cbe), docket items (m7bb9eb904138 "ticket ajd
// presentation links should renerr ss their full nsme, notmtheir slug"), and any
// kind that registers a reader later (presentations). One cache, one batching
// rule and one re-read rule, so the kinds cannot drift apart.
//
// A kind's module registers a reader: a bounded read of the exact IDs on screen
// for one org. Answers are kept per org (oldest dropped first) and read again
// when that kind's change signal arrives, with the old answer on screen until
// the new one lands, so a rename never flickers a chip back to its token.
//
// ⚠ ONLY AN ANSWERED READ MAKES A TARGET `absent`. An ID the reader leaves out
// of its answer is gone; an ID whose read failed is still `pending`, keeps
// whatever answer it had, and is not asked again for RETRY_MS.

import { useMemo, useSyncExternalStore } from 'react'
import type { RefOutcome } from './reflinks'
import type { RefKind, TypedRef } from './workrefs'

/** What a chip shows for a target that exists: its name, and the hover text
 *  when the kind's links share one (an Apps row's). */
export interface RefName { label: string; title?: string }

/** One mention, decided by name. */
export interface RefNameAnswer { outcome: RefOutcome; label?: string; title?: string }

export interface RefNameReader {
  /** the kinds this reader answers for, read together */
  kinds: readonly RefKind[]
  /** IDs per read: the engine's own bound */
  batch: number
  /** the rows of the requested IDs that exist in `org`, keyed `kind:id`.
   *  Throws when the read failed: that is not an answer. */
  read(org: string, ids: { kind: RefKind; id: string }[]): Promise<Map<string, unknown>>
  /** what the chip shows for one row */
  name(kind: RefKind, row: unknown): RefName
}

type Known = { row: unknown } | { absent: true }

/** targets kept per org, oldest dropped first; a dropped one simply asks again */
const KEEP = 512
/** a failed read is not retried on every render */
const RETRY_MS = 10_000

export const refKey = (kind: RefKind, id: string) => `${kind}:${id}`
const split = (key: string) => { const at = key.indexOf(':'); return { kind: key.slice(0, at) as RefKind, id: key.slice(at + 1) } }

class RefNames {
  private readers = new Map<RefKind, RefNameReader>()
  private known = new Map<string, Map<string, Known>>()
  private queued = new Map<string, Set<string>>()
  private asking = new Map<string, Set<string>>()
  private failed = new Map<string, number>()
  private reading = new Set<string>()
  private subs = new Set<() => void>()
  private version = 0
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn) } }
  snapshot = () => this.version

  register(reader: RefNameReader): void {
    for (const kind of reader.kinds) this.readers.set(kind, reader)
  }

  /** the kept answer, asking for it when there is none. `undefined` for a
   *  kind no reader names, and for a target still being read. */
  get(org: string, kind: RefKind, id: string): Known | undefined {
    if (!this.readers.has(kind)) return undefined
    const key = refKey(kind, id)
    const hit = this.known.get(org)?.get(key)
    if (hit === undefined && Date.now() - (this.failed.get(org + '\0' + key) ?? 0) > RETRY_MS) this.ask(org, [key])
    return hit
  }

  names(kind: RefKind): boolean { return this.readers.has(kind) }

  row(org: string, kind: RefKind, id: string): unknown {
    const known = this.get(org, kind, id)
    return known && 'row' in known ? known.row : undefined
  }

  describe(org: string, ref: TypedRef): RefNameAnswer | undefined {
    const reader = this.readers.get(ref.kind)
    if (!reader) return undefined
    const known = this.get(org, ref.kind, ref.id)
    if (!known) return { outcome: 'pending' }
    if ('absent' in known) return { outcome: 'absent' }
    return { outcome: 'ready', ...reader.name(ref.kind, known.row) }
  }

  /** a kind changed in `org`: read its kept targets again */
  invalidate(org: string, kinds: readonly RefKind[]): void {
    const kept = this.known.get(org)
    if (!kept?.size) return
    const keys = [...kept.keys()].filter(key => kinds.includes(split(key).kind))
    if (keys.length) this.ask(org, keys, true)
  }

  private ask(org: string, keys: string[], again = false): void {
    const queue = this.queued.get(org) ?? new Set<string>()
    const asking = this.asking.get(org)
    for (const key of keys) if (again || !asking?.has(key)) queue.add(key)
    if (!queue.size) return
    this.queued.set(org, queue)
    queueMicrotask(() => this.flush(org))
  }

  private flush(org: string): void {
    if (this.reading.has(org)) return          // the read in flight flushes again when it ends
    const keys = [...(this.queued.get(org) ?? [])]
    this.queued.delete(org)
    if (!keys.length) return
    this.reading.add(org)
    const asking = this.asking.get(org) ?? new Set<string>()
    this.asking.set(org, asking)
    for (const key of keys) asking.add(key)
    // one read per reader and batch: an app and a panel share a read, an item does not
    const groups = new Map<RefNameReader, string[]>()
    for (const key of keys) {
      const reader = this.readers.get(split(key).kind)
      if (reader) groups.set(reader, [...(groups.get(reader) ?? []), key])
    }
    void (async () => {
      for (const [reader, all] of groups) {
        for (let i = 0; i < all.length; i += reader.batch) {
          const part = all.slice(i, i + reader.batch)
          try {
            const found = await reader.read(org, part.map(split))
            for (const key of part) this.keep(org, key, found.has(key) ? { row: found.get(key) } : { absent: true })
            for (const key of part) this.failed.delete(org + '\0' + key)
            this.version++
            for (const fn of this.subs) fn()
          } catch {
            for (const key of part) this.failed.set(org + '\0' + key, Date.now())
          } finally {
            for (const key of part) asking.delete(key)
          }
        }
      }
      this.reading.delete(org)
      if (this.queued.get(org)?.size) this.flush(org)
    })()
  }

  private keep(org: string, key: string, value: Known): void {
    const kept = this.known.get(org) ?? new Map<string, Known>()
    this.known.set(org, kept)
    kept.delete(key)                              // re-inserted as the newest
    kept.set(key, value)
    while (kept.size > KEEP) kept.delete(kept.keys().next().value!)
  }
}

export const refNames = new RefNames()

/** A surface's name resolver for `org`. It changes identity whenever an answer
 *  arrives, so a world built from it does too and the chips on screen are
 *  decided again. `undefined` for a kind no reader names. */
export function useRefNames(org: string): (ref: TypedRef) => RefNameAnswer | undefined {
  const version = useSyncExternalStore(refNames.subscribe, refNames.snapshot)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (ref: TypedRef) => refNames.describe(org, ref), [org, version])
}
