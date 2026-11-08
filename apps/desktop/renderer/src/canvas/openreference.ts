// canvas/openreference.ts — an orgtree:// link's reference, opened in its org's
// window (docs/rust-engine/orgtree-links.md).
//
// Hubchat's Orgtree mention chips open their target here: main checks the link
// and that this Orgtree holds its org, reveals the org's own window and hands it
// a held `open-reference` event (events/heldbus.ts). This is the window's half.
// It opens the reference through the SAME routes the shell's chips use (App's
// gallery world), so a link lands exactly where a chip click would, and a target
// that is gone shows that route's usual not-found state (USER 2026-11-08
// m7c183781895c, Q5).
//
// ⚠ NAVIGATION ONLY. The event carries a token, never an action; anything that
// is not one canonical token of THIS window's org is dropped.
import { useEffect, useRef, useState } from 'react'
import { onHeldEvent } from '../events/heldbus'
import { parseRef } from './workrefs'
import type { TypedRef } from './workrefs'

/** The reference a link asks this org window to open, or null. */
export function linkedReference(data: unknown, org: string | null): TypedRef | null {
  if (!org || !data || typeof data !== 'object') return null
  const { org: target, token } = data as { org?: unknown; token?: unknown }
  if (target !== org || typeof token !== 'string') return null
  const ref = parseRef(token)
  return ref && ref.org === org ? ref : null
}

/** Opens a linked reference once this org's tree has arrived: before that the
 *  canvas cannot centre on a card it has not laid out, and the routes would
 *  judge every agent and mailbox against a list still loading. `open` is the
 *  shell's chip route (`galleryRefs.onOpen(resolveRef(…))`). */
export function useLinkedReference(org: string | null, treeOrg: string | null | undefined,
  open: (ref: TypedRef) => void): void {
  const [pending, setPending] = useState<TypedRef | null>(null)
  const orgNow = useRef(org)
  orgNow.current = org
  const openNow = useRef(open)
  openNow.current = open
  // held: a link is what cold-starts the window, so it arrives before effects run
  useEffect(() => onHeldEvent('open-reference', (event) => {
    const ref = linkedReference(event.data, orgNow.current)
    if (ref) setPending(ref)
  }), [])
  useEffect(() => {
    if (!pending || !org || treeOrg !== org || pending.org !== org) return
    setPending(null)
    openNow.current(pending)
  }, [pending, org, treeOrg])
}
