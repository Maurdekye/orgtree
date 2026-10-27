// canvas/docrefs.ts — a presentation mention shows the presentation's current
// full title, not its slug (USER 2026-10-27 m7bb9eb904138 "ticket ajd
// presentation links should renerr ss their full nsme, notmtheir slug"; the
// slug is its identity, m4efbc12ac94e).
//
// A `refnames` reader over the gallery's bounded `refs` read of the exact
// references on screen (64 a request, the engine's REFS_MAX). An old generic id
// answers with the presentation it named, so an old token shows the current
// title as well. Every presentation write sends `documents_changed` on the org
// socket, and the titles on screen are read again.
//
// The answer also carries the presentation's `at` and `viewed_at`, so the chip
// flares when it is unread or modified since it was read (USER 2026-10-27
// m919f12828686 "unread or modified presentation links should be highlighted
// in a similar manner as well"), by the read state the cards use
// (docviewed.ts). Opening one marks it here first: the chips are decided again
// at once from the answers on screen, with no read.

import { useSyncExternalStore } from 'react'
import { getDocumentRefs } from '../api'
import type { DocumentRef } from '../api'
import { refKey, refNames } from './refnames'
import type { RefFlare } from './refnames'
import { DOC_UNREAD_WORDS, docUnread, subscribeDocViewed } from './docviewed'

/** A presentation's flare: unread or modified since read, none once read. */
export function docFlare(org: string, row: Pick<DocumentRef, 'id' | 'at' | 'viewed_at'>): RefFlare | undefined {
  const unread = docUnread(org, row.id, row.at, row.viewed_at)
  return unread ? { cls: 'doc-' + unread, tip: DOC_UNREAD_WORDS[unread] } : undefined
}

refNames.register({
  kinds: ['doc'],
  batch: 64,
  async read(org, ids) {
    const rows = await getDocumentRefs(org, ids.map(x => x.id))
    const found = new Map<string, unknown>()
    for (const row of rows) found.set(refKey('doc', row.ref), row)
    return found
  },
  name: (_kind, row, org) => {
    const flare = docFlare(org, row as DocumentRef)
    return { label: (row as DocumentRef).title, ...(flare ? { flare } : {}) }
  },
})

subscribeDocViewed(() => refNames.touch())

const still = () => () => {}
const zero = () => 0

/** The presentation `id` names now, through the same bounded read as its
 *  mentions: its slug, current title and read times. `undefined` until the
 *  read answers, and for one it did not find. With no `id` it subscribes to
 *  nothing, so a transcript's other tool rows never re-render for a name read. */
export function useDocumentRef(org: string, id: string | undefined): DocumentRef | undefined {
  useSyncExternalStore(id ? refNames.subscribe : still, id ? refNames.snapshot : zero)
  return id ? refNames.row(org, 'doc', id) as DocumentRef | undefined : undefined
}

/** The org feed's presentations frame: a presentation was presented or
 *  replaced, so the titles on screen are read again. True when the frame was
 *  this one. */
export function documentsFeed(slug: string, data: { type?: unknown } | null): boolean {
  if (data?.type !== 'documents_changed') return false
  refNames.invalidate(slug, ['doc'])
  return true
}
