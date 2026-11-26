// canvas/orgblocks.tsx — an org's blocks (Mail hub 2.6.0) as the contact lists show them.
//
// Every list of a hub's contacts is the one ConnectionList (USER 2026-11-25 21:49:37Z m8ee22829e340 "use the same
// list for each hub, and add a small red cancel button by each entry to manually block them"; 21:50:37Z
// m706c3054c21d "add the same button next to the entries in the lists under mailservers in the org connections tab,
// integrate it into the ux and style of the general list component"). This module gives such a list, for one org,
// the badge a row wears (blocked, or the contact's lockdown lock) and its controls: the blocked sign as a button that blocks at once
// (blocking is reversible, so it asks nothing), or the checkmark that unblocks on a row the org blocks.
import { useEffect, useState, type ReactNode } from 'react'
import { getNetBlocks, setNetBlock } from '../api'
import { LockIcon } from '../icons'
import type { NetBlocks, NetHub, NetPeer } from '../types'
import { BlockedSign, PresenceDot, rowPresence, type RowControls } from './connectionlist'

/** An engine before blocking (or any odd answer) has no lists: read as none. */
export const blockLists = (b: unknown): NetBlocks => {
  const o = (b ?? {}) as Partial<NetBlocks>
  return { blocked: Array.isArray(o.blocked) ? o.blocked.filter((x) => typeof x?.address === 'string') : [],
    blocked_by: Array.isArray(o.blocked_by) ? o.blocked_by.filter((x) => typeof x === 'string') : [] }
}

export interface OrgBlocks {
  blocks: NetBlocks | null
  /** whom the org blocks / who blocks the org (bare slugs) */
  mine: ReadonlySet<string>
  by: ReadonlySet<string>
  change: (address: string, blocked: boolean) => void
}

/** The org's blocks, read again whenever `key` changes (the hubs' last word moved). */
export function useOrgBlocks(slug: string, key: string, onError?: (message: string | null) => void): OrgBlocks {
  const [blocks, setBlocks] = useState<NetBlocks | null>(null)
  useEffect(() => {
    let live = true
    getNetBlocks(slug).then((b) => { if (live) setBlocks(blockLists(b)) }).catch(() => {})
    return () => { live = false }
  }, [slug, key])
  const change = (address: string, blocked: boolean) => {
    setNetBlock(slug, address, blocked).then((b) => { setBlocks(blockLists(b)); onError?.(null) })
      .catch((e: unknown) => onError?.(e instanceof Error ? e.message : String(e)))
  }
  return { blocks, mine: new Set((blocks?.blocked ?? []).map((b) => b.address)), by: new Set(blocks?.blocked_by ?? []), change }
}

/** A row's status: the red cancel sign when blocked either way; in lockdown, a closed contact only the lock and an
 *  open one its dot with a small lock; otherwise its presence dot. */
export function contactStatus(h: Pick<NetHub, 'locked'> | undefined, p: NetPeer, b: Pick<OrgBlocks, 'mine' | 'by'>): ReactNode {
  if (b.mine.has(p.slug) || b.by.has(p.slug)) {
    const mine = b.mine.has(p.slug)
    return <BlockedSign label={mine ? 'blocked' : 'has blocked this org'}
      title={mine ? 'Blocked: no messages either way' : 'Has blocked this org: no messages either way'} />
  }
  const lock = h?.locked?.[p.slug]
  if (lock === 'closed') return <LockIcon className="oi-locked" fontSize="inherit" role="img" aria-label="in lockdown, can't be messaged"
    titleAccess="In lockdown: this org isn't on their list and can't message them" />
  if (lock === 'open') return <span className="oi-lockbadge" role="img" aria-label="in lockdown, this org is on their list"
    title="In lockdown: this org is on their list"><PresenceDot state={rowPresence(p)} /><LockIcon className="oi-lockbadge-lock" fontSize="inherit" /></span>
  return <PresenceDot state={rowPresence(p)} />
}

/** A hub list's row controls for one org: its status and, at the row's end, the button that blocks (only on a hub
 *  that can block) or, on a row the org blocks, the checkmark that unblocks. */
export function hubListControls(h: NetHub, b: OrgBlocks): RowControls {
  const can = h.blocks !== undefined
  return {
    status: (p) => contactStatus(h, p, b),
    // a row the org blocks has a checkmark that unblocks in the block button's place, no text button (USER
    // 2026-11-26 19:13:26Z mc519405980c8 "change the unblock button to a checkmark that appears in place of the block
    // button"); unblocking needs no block support on the hub's side here, as before
    x: (p) => b.mine.has(p.slug)
      ? { title: `Unblock @net:${p.slug}`, onClick: () => b.change(p.slug, false), unblock: true }
      : can ? { title: `Block @net:${p.slug}: no messages either way`, onClick: () => b.change(p.slug, true), block: true } : null,
  }
}
