// canvas/modalinstances.ts — THE OPEN INSTANCES OF ONE PER-TARGET SURFACE
// (docket several-instances-of-the-same-modal-team-slots-i). USER 2026-10-20
// 17:24:20Z: "different versions of the same modal (like the team modal for
// different agents / projects, the slots modal for different projects, the
// inbox modal for different agents, etc.) should be able to coexist. right now
// opening one replaces the other's position". The coordinator approved these
// defaults at 18:58:51Z (m5083ac2a0b30):
//
//  · the same target again REVEALS its instance (raises the pin, focuses the
//    window); a node's own button still hides its own open pin
//  · a NEW target never touches a pinned or popped-out instance. A centred
//    one gives way: there is at most one centred instance per kind, since a
//    centred modal has no place to keep and two would sit on top of each other
//  · a new target with no placement of its own follows its kind's last
//    explicit placement, cascaded 28 px past the open siblings, or opens
//    centred (modalpin.tsx `placeNewInstance`)
//
// What used to be `const [teamId, setTeamId] = useState<string | null>()` and
// `toggleNodePanel` is this hook: a list of targets instead of one, with the
// same reveal/close rules applied per target.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WindowRestore } from '../windowlayout'
import { detachedPanel, revealDetachedPanel } from '../windowlife'
import { instanceKind } from '../modalkinds'
import { forgetModalOpen, isModalPinned, modalToggleAction, placeNewInstance, raisePinnedModal,
  rememberModalOpen } from './modalpin'

export interface InstanceOpen {
  /** an explicit open (a menu entry, a corner's modal button): never closes.
   *  Without it this is a node's own button, which hides its open pin. */
  ensureOpen?: boolean
  /** false for the desk tab corner's pin and pop-out, which place the window
   *  themselves at the tab; every other opener follows the kind's placement */
  place?: boolean
  /** other open windows of the same class (instance kinds) to cascade past
   *  as well: a team reader steps past the agent readers, and back */
  siblings?: readonly string[]
}

export interface ModalInstances {
  /** the open targets, oldest first */
  ids: readonly string[]
  has: (id: string) => boolean
  open: (id: string, opts?: InstanceOpen) => void
  close: (id: string) => void
  /** start-up restoration (or an org's): exactly these targets */
  restore: (ids: readonly string[]) => void
  /** a node renamed: its instance follows (its records move in modalpin) */
  rename: (from: string, to: string) => void
}

/** Is this instance a window of its own somewhere — pinned in this window,
 *  or popped out into another? The rest are centred. */
export const placedInstance = (kind: string, org: string | null): boolean =>
  isModalPinned(kind, org) || !!detachedPanel(kind, org)

/**
 * `kind` is the surface (`agent-team`), `org` the scope every store is keyed
 * by, and `restoreOf` the identity each open instance's marker carries — the
 * marker is what brings a PINNED instance back at start-up, exactly as
 * `usePersistedModalOpen` did for the single one.
 */
export function useModalInstances(kind: string, org: string | null,
  restoreOf: (id: string) => WindowRestore | undefined): ModalInstances {
  const [ids, setIds] = useState<readonly string[]>([])
  // every write goes through here, so two opens in one tick see each other
  const latest = useRef<readonly string[]>(ids)
  const commit = useCallback((next: readonly string[]) => { latest.current = next; setIds(next) }, [])

  // A different organization is a different set: its own restoration brings
  // its instances; nothing of the previous org's carries over.
  const shownOrg = useRef(org)
  useEffect(() => {
    if (shownOrg.current === org) return
    shownOrg.current = org
    commit([])
  }, [org, commit])

  const open = useCallback((id: string, opts: InstanceOpen = {}) => {
    const own = instanceKind(kind, id)
    const cur = latest.current
    if (cur.includes(id)) {
      if (revealDetachedPanel(own, org)) return
      if (!opts.ensureOpen && modalToggleAction(own, true, org) === 'close') {
        forgetModalOpen(own, org); commit(cur.filter(x => x !== id)); return
      }
      raisePinnedModal(own, org)
      return
    }
    // its own window is already out there (a restore still on its way)
    if (revealDetachedPanel(own, org)) { commit([...cur, id]); return }
    const kept = cur.filter(x => placedInstance(instanceKind(kind, x), org))
    if (opts.place !== false) placeNewInstance(kind, id, org, [...kept.map(x => instanceKind(kind, x)), ...(opts.siblings ?? [])])
    commit([...kept, id])
  }, [kind, org, commit])

  const close = useCallback((id: string) => {
    if (latest.current.includes(id)) commit(latest.current.filter(x => x !== id))
  }, [commit])
  const restore = useCallback((next: readonly string[]) => {
    const ids = [...new Set(next)]
    if (ids.length !== latest.current.length || ids.some((id, i) => latest.current[i] !== id)) commit(ids)
  }, [commit])
  const rename = useCallback((from: string, to: string) => {
    if (latest.current.includes(from)) commit([...new Set(latest.current.map(x => x === from ? to : x))])
  }, [commit])

  // THE DURABLE OPEN MARKERS, per instance — the list form of
  // `usePersistedModalOpen`. Only a PINNED instance is remembered as open (a
  // popped-out one has its window row, a centred one is not restored), and an
  // organization switch writes nothing: the new org's restoration supplies its
  // own set first.
  const restoreKey = JSON.stringify(ids.map(id => [id, restoreOf(id) ?? null]))
  const seen = useRef<{ org: string | null; ids: readonly string[] } | null>(null)
  useEffect(() => {
    const prev = seen.current
    seen.current = { org, ids }
    if (!prev || prev.org !== org) return
    for (const id of prev.ids) if (!ids.includes(id)) {
      const own = instanceKind(kind, id)
      if (isModalPinned(own, org)) forgetModalOpen(own, org)
    }
    for (const id of ids) {
      const own = instanceKind(kind, id)
      if (isModalPinned(own, org)) rememberModalOpen(own, org, restoreOf(id))
    }
  }, [kind, org, restoreKey])   // eslint-disable-line react-hooks/exhaustive-deps

  const has = useCallback((id: string) => latest.current.includes(id), [])
  return useMemo(() => ({ ids, has, open, close, restore, rename }), [ids, has, open, close, restore, rename])
}
