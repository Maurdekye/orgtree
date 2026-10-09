// canvas/docviewed.ts — which presented documents the user has opened.
// A card the user has never opened is NEW; one an agent re-presented with
// `replaces` after the user last opened it is UPDATED. Both clear on open.
// The record is per organization in this origin's localStorage (the same
// place the inbox-seen mark lives): document id -> the `at` that was current
// when it was opened. A replace bumps `at`, which is how UPDATED is told
// apart from a card that is simply read.

import { useSyncExternalStore } from 'react'

export type DocUnread = 'new' | 'updated' | null

const KEY = 'orgtree-docs-viewed-'
const cache = new Map<string, Record<string, string>>()
const listeners = new Set<() => void>()
let version = 0

function load(slug: string): Record<string, string> {
  let m = cache.get(slug)
  if (!m) {
    try { m = JSON.parse(localStorage.getItem(KEY + slug) ?? '{}') as Record<string, string> }
    catch { m = {} }
    if (!m || typeof m !== 'object') m = {}
    cache.set(slug, m)
  }
  return m
}

export function docUnread(slug: string, id: string, at?: string): DocUnread {
  if (!at) return null
  const seen = load(slug)[id]
  if (seen === undefined) return 'new'
  return seen < at ? 'updated' : null
}

export function markDocViewed(slug: string, id: string, at?: string): void {
  if (!id || !at) return
  const m = load(slug)
  if (m[id] !== undefined && m[id] >= at) return
  m[id] = at
  try { localStorage.setItem(KEY + slug, JSON.stringify(m)) } catch { /* private mode */ }
  version++
  listeners.forEach((l) => l())
}

/** re-renders the caller whenever any document is marked viewed */
export function useDocViewedVersion(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => version)
}
