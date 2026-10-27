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

import { getDocumentRefs } from '../api'
import type { DocumentRef } from '../api'
import { refKey, refNames } from './refnames'

refNames.register({
  kinds: ['doc'],
  batch: 64,
  async read(org, ids) {
    const rows = await getDocumentRefs(org, ids.map(x => x.id))
    const found = new Map<string, unknown>()
    for (const row of rows) found.set(refKey('doc', row.ref), row)
    return found
  },
  name: (_kind, row) => ({ label: (row as DocumentRef).title }),
})

/** The org feed's presentations frame: a presentation was presented or
 *  replaced, so the titles on screen are read again. True when the frame was
 *  this one. */
export function documentsFeed(slug: string, data: { type?: unknown } | null): boolean {
  if (data?.type !== 'documents_changed') return false
  refNames.invalidate(slug, ['doc'])
  return true
}
