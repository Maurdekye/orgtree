// canvas/docviewed.ts — which presented documents the user has opened.
// A card the user has never opened is NEW; one an agent re-presented with
// `replaces` after the user last opened it is UPDATED. Both clear on open.
// The engine holds the record (documents.viewed_at, sent as `viewed_at` on
// every document payload): it survives a PC crash, a profile loss and a moved
// origin. This origin's localStorage is the fast copy, per organization:
// document id -> the `at` that was current when it was opened. A replace bumps
// `at`, which is how UPDATED is told apart from a card that is simply read.
// A mark only ever moves forward, so a window with an old copy cannot un-read
// a card: writes merge with what storage holds now, other windows' writes
// arrive by the `storage` event, and the whole local copy is pushed to the
// engine once per page load (which also carries marks made before the engine
// kept them).

import { useSyncExternalStore } from 'react'
import { req } from '../api'

export type DocUnread = 'new' | 'updated' | null

const KEY = 'orgtree-docs-viewed-'
const cache = new Map<string, Record<string, string>>()
const pushed = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function read(slug: string): Record<string, string> {
  let m: Record<string, string>
  try { m = JSON.parse(localStorage.getItem(KEY + slug) ?? '{}') as Record<string, string> }
  catch { m = {} }
  return m && typeof m === 'object' ? m : {}
}

function post(slug: string, marks: { id: string; at: string }[]): void {
  if (!marks.length) return
  void req(`/api/orgs/${encodeURIComponent(slug)}/documents/viewed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks }), keepalive: true,
  }).catch(() => { /* the local mark stands; the next page load pushes it again */ })
}

function load(slug: string): Record<string, string> {
  let m = cache.get(slug)
  if (!m) {
    m = read(slug)
    cache.set(slug, m)
  }
  if (!pushed.has(slug)) {
    pushed.add(slug)
    post(slug, Object.entries(m).map(([id, at]) => ({ id, at })))
  }
  return m
}

/** `viewedAt`: what the engine says (`viewed_at` on the payload). */
export function docUnread(slug: string, id: string, at?: string, viewedAt?: string | null): DocUnread {
  if (!at) return null
  const local = load(slug)[id]
  const seen = local && viewedAt ? (local > viewedAt ? local : viewedAt) : local ?? viewedAt ?? undefined
  if (seen === undefined) return 'new'
  return seen < at ? 'updated' : null
}

export function markDocViewed(slug: string, id: string, at?: string): void {
  if (!id || !at) return
  const m = load(slug)
  if (m[id] !== undefined && m[id] >= at) return
  // another window may have written since this copy was read
  const stored = read(slug)
  for (const [k, v] of Object.entries(stored)) if (m[k] === undefined || m[k] < v) m[k] = v
  m[id] = at
  try { localStorage.setItem(KEY + slug, JSON.stringify(m)) } catch { /* private mode */ }
  post(slug, [{ id, at }])
  version++
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(KEY)) return
    cache.delete(e.key.slice(KEY.length))
    version++
    listeners.forEach((l) => l())
  })
}

/** re-renders the caller whenever any document is marked viewed */
export function useDocViewedVersion(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => version)
}
