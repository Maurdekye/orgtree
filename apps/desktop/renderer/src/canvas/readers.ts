// canvas/readers.ts — THE OPEN DOCUMENT READERS, and which one a document
// opening goes to (docket several-instances-of-the-same-modal-team-slots-i).
//
// USER 2026-10-20 19:03:28Z (md184a546b2d7): "one class of reader; one global
// reader, one agent / project reader per agent or project, one team reader per
// agent or project team. if a document is already viewable from one, then bring
// it to the front, otherwise open a new one". And 19:05:36Z (mcebcf541bac6):
// "if several ones could win, choose one arbitrarily in a consistent manner".
//
// A reader is a presentations gallery in a window of its own: the org's
// Presented documents (global), one agent's or project's (agent), or one
// team's (team: its node and everyone under it, passing through projects).
// Each mounted reader registers here with its scope, what it shows, and how
// to show something else; a document opening asks `pickReader` first.
//
// "VIEWABLE FROM ONE" IS READ BY SCOPE, not by the rows a reader happens to
// have loaded: a global reader can show any document of its org, an agent
// reader its node's, a team reader its node's and its descendants'. Each
// reader locates the document itself (its list grows to the page holding it).
//
// THE FIXED ORDER, when several can show it: a reader already showing it;
// then the document's own agent/project reader; then the team readers from
// the document's own node upwards, nearest first; then the global reader.
// Readers of the same rank (several showing it) go by that same order.

import { useEffect, useRef } from 'react'
import type { LoadedDoc } from './docs'

export type ReaderScope = { kind: 'global' } | { kind: 'agent' | 'team'; id: string }

export interface ReaderHandle {
  org: string
  scope: ReaderScope
  /** the document on screen in it right now */
  shown: () => string | null
  /** bring it to the front showing `doc` (its list finds the page) */
  show: (doc: string, loaded?: LoadedDoc) => void
}

const handles = new Set<ReaderHandle>()
export const registerReader = (handle: ReaderHandle): (() => void) => {
  handles.add(handle)
  return () => { handles.delete(handle) }
}
export const openReaders = (org: string): ReaderHandle[] => [...handles].filter(h => h.org === org)

/** where a reader stands in the fixed order for a document of `ancestry[0]`
 *  (`ancestry` is that node, then its parent, and so on): lower is first,
 *  Infinity is a reader that cannot show it */
export const readerRank = (scope: ReaderScope, ancestry: readonly string[]): number => {
  if (scope.kind === 'global') return 1000
  if (scope.kind === 'agent') return ancestry.length && scope.id === ancestry[0] ? 0 : Infinity
  const at = ancestry.indexOf(scope.id)
  return at < 0 ? Infinity : 1 + at
}

/** The reader a document opening goes to, or null: then its own agent or
 *  project reader opens. `ancestry` may be empty when the document's node is
 *  not known yet; only a reader already showing it, or the global one, can
 *  then be picked. */
export function pickReader(org: string, doc: string, ancestry: readonly string[]): ReaderHandle | null {
  const open = openReaders(org)
  const ranked = (list: ReaderHandle[]) => list
    .map(h => ({ h, rank: readerRank(h.scope, ancestry) }))
    .sort((a, b) => a.rank - b.rank || scopeKey(a.h.scope).localeCompare(scopeKey(b.h.scope)))
  const showing = ranked(open.filter(h => h.shown() === doc)).filter(r => !ancestry.length || r.rank < Infinity)
  if (showing.length) return showing[0]!.h
  const viewable = ranked(open).filter(r => r.rank < Infinity)
  return viewable[0]?.h ?? null
}
const scopeKey = (s: ReaderScope) => s.kind === 'global' ? 'global' : `${s.kind}:${s.id}`

/** A mounted reader's registration, kept current: the callbacks are read
 *  through a ref, so a re-render never re-registers it. */
export function useReaderHandle(org: string | null, scope: ReaderScope | null,
  shown: () => string | null, show: (doc: string, loaded?: LoadedDoc) => void): void {
  const latest = useRef({ shown, show })
  latest.current = { shown, show }
  const key = scope ? scopeKey(scope) : ''
  useEffect(() => {
    if (!org || !scope) return
    return registerReader({ org, scope, shown: () => latest.current.shown(),
      show: (doc, loaded) => latest.current.show(doc, loaded) })
  }, [org, key])   // eslint-disable-line react-hooks/exhaustive-deps
}
