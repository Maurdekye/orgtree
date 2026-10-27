// canvas/itemrefs.ts — a ticket mention shows its docket item's current full
// title, not its slug (USER 2026-10-27 m7bb9eb904138 "ticket ajd presentation
// links should renerr ss their full nsme, notmtheir slug").
//
// A `refnames` reader over the existing bounded work-item-references read of
// the exact slugs on screen (WorkReferenceReader: 128 a request). Its answers
// are keyed by a per-org epoch that every `docket_changed` frame moves, so each
// docket write reads the titles on screen again; the engine sends that frame
// from its docket write funnel because the record feed skips an unchanged work
// summary and a rename alone changes none of it.
//
// The same row's status is the chip's flare, in the docket's status colour
// and named in its tooltip (USER 2026-10-27 m43beb8089dd4 "add a flare with the
// ticket's status as a color, similar to ticket links"), so it follows every
// docket write as the title does.

import { getWorkReferences } from '../api'
import type { WorkReference } from '../workreferences'
import { refKey, refNames } from './refnames'
import { ticketFlare } from './docketstatus'

const epochs = new Map<string, number>()

refNames.register({
  kinds: ['item'],
  batch: 128,
  async read(org, ids) {
    const rows = await getWorkReferences(org, `mentions:${epochs.get(org) ?? 0}`, ids.map(x => x.id))
    const found = new Map<string, unknown>()
    for (const [slug, row] of rows) if (row) found.set(refKey('item', slug), row)
    return found
  },
  name: (_kind, row) => {
    const flare = ticketFlare(row as WorkReference)
    return { label: (row as WorkReference).title, ...(flare ? { flare } : {}) }
  },
})

/** The org feed's docket frame: every docket write reads the ticket titles on
 *  screen again. True when the frame was this one. */
export function docketFeed(slug: string, data: { type?: unknown } | null): boolean {
  if (data?.type !== 'docket_changed') return false
  epochs.set(slug, (epochs.get(slug) ?? 0) + 1)
  refNames.invalidate(slug, ['item'])
  return true
}
