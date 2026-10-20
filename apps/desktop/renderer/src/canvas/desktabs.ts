// canvas/desktabs.ts — EVERY DESK REOPENS WHERE IT WAS LEFT (user 2026-10-20
// 06:22Z): an agent or project desk opens on the tab last picked on it, and a
// project desk's Mail tab opens on the folder last picked in its folder strip.
// Kept per organization and node id in this origin's localStorage, so a
// revisit, another host of the same desk and a restart all find it; a
// session-only copy stands in where storage is unavailable. Only the OPENING
// tab is shared: a desk that is already open keeps its own, so a pick in one
// host never moves another (the send-opens-Chat rule, user 2026-10-18).

import { useCallback, useEffect, useState } from 'react'

/** what a desk remembers: its tab, and a project desk's Mail folder */
export type DeskPart = 'tab' | 'mail'
type Saved = Partial<Record<DeskPart, string>>

const KEY = 'orgtree-desk-tabs:'
const fallback = new Map<string, Record<string, Saved>>()
/** one node's entry: an own, plain object, or nothing (hand-edited storage) */
function entry(all: Record<string, Saved>, nid: string): Saved {
  const e: unknown = Object.prototype.hasOwnProperty.call(all, nid) ? all[nid] : undefined
  return e && typeof e === 'object' && !Array.isArray(e) ? e as Saved : {}
}

function load(slug: string): Record<string, Saved> {
  const held = fallback.get(slug)
  if (held) return held
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY + slug) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Saved> : {}
  } catch { return {} }        // private mode, or a hand-edited value: nothing remembered
}

function save(slug: string, all: Record<string, Saved>): void {
  try { localStorage.setItem(KEY + slug, JSON.stringify(all)); fallback.delete(slug) }
  catch { fallback.set(slug, all) }
}

export function deskMemory(slug: string, nid: string, part: DeskPart): string | null {
  const v = entry(load(slug), nid)[part]
  return typeof v === 'string' ? v : null
}

export function rememberDesk(slug: string, nid: string, part: DeskPart, value: string): void {
  const all = load(slug)
  if (entry(all, nid)[part] === value) return
  save(slug, { ...all, [nid]: { ...entry(all, nid), [part]: value } })
}

/** Every organization's desk memory forgotten: a test fixture that mounts the
 *  same desk in several tests starts each one on the desk's first tab. */
export function forgetDeskMemory(): void {
  fallback.clear()
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(KEY)) localStorage.removeItem(key)
  } catch { /* no storage, nothing stored */ }
}

/** A renamed node keeps its desk's memory (OrgCanvas's client-state move).
 *  As there, a value already under the new id wins. */
export function moveDeskMemory(slug: string, from: string, to: string): void {
  const all = load(slug)
  if (from === to || !Object.prototype.hasOwnProperty.call(all, from)) return
  const next = { ...all, [to]: { ...entry(all, from), ...entry(all, to) } }
  delete next[from]
  save(slug, next)
}

/** The desk's remembered `part` when it is one of `known`, else `first`; the
 *  setter selects and remembers. A host that shows another node in the same
 *  desk (the Attention panel's project desk) reads that node's own. Whether
 *  the desk OFFERS the tab right now is the desk's call (each falls back to
 *  its first tab). */
export function useDeskMemory<T extends string>(slug: string, nid: string, part: DeskPart, first: T,
  known: readonly T[]): [T, (next: T) => void] {
  const id = slug + '\n' + nid
  const recall = (): T => {
    const v = deskMemory(slug, nid, part)
    return v !== null && (known as readonly string[]).includes(v) ? v as T : first
  }
  const [state, setState] = useState(() => ({ id, value: recall() }))
  useEffect(() => {
    setState((s) => s.id === id ? s : { id, value: recall() })
  }, [id])
  const pick = useCallback((next: T) => {
    setState({ id, value: next })
    rememberDesk(slug, nid, part, next)
  }, [id, slug, nid, part])
  return [state.id === id ? state.value : recall(), pick]
}
