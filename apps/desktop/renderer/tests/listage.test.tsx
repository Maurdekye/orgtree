// listage.test.tsx — one time presentation for the mail-idiom lists (UX
// symmetry audit #7; USER 2026-10-29 m019c9500d23a, verbatim: "A7 use time
// ago in list, full date and time in header of detail tab"). A list row says
// how long ago, on one scale (s, m, h, d, w, mo, y; an old presentation once
// read "500h"), with the full local date and time as its hover and its
// accessible name: mail, Attention's mentions, presentations and tickets
// alike. A ticket's age reads the clock its list is sorted by (docket.test.tsx
// §38f); an open ticket's header says the full date and time (§38i).
import { flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MailRowView } from '../src/canvas/mail'
import { MentionRowView } from '../src/attention/mentionrow'
import { DocGalleryModal } from '../src/canvas/gallery'
import { rowAge } from '../src/canvas/docket'
import { fmtFull } from '../src/timefmt'
import type { DocRow } from '../src/api'
import type { WorkItem } from '../src/types'

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H
const before = (ms: number) => new Date(Date.now() - ms).toISOString()

/** A list row's time cell: what it shows, its hover and its accessible name. */
function timeCell(row: Element | null | undefined) {
  const c = row?.querySelector('.l1 .mtime')
  assert.ok(c, 'the row has its time cell')
  return { text: c.textContent, title: c.getAttribute('title'), label: c.getAttribute('aria-label') }
}

test('one scale for every list: seconds, minutes, hours, then days, weeks, months and years', () => {
  const cases: [number, string][] = [
    [30 * S, '30s'], [45 * M, '45m'], [5 * H, '5h'], [30 * H, '30h'], [50 * H, '2d'], [10 * D, '10d'],
    [20 * D, '3w'], [60 * D, '2mo'], [400 * D, '13mo'], [600 * D, '2y'],
  ]
  for (const [ms, text] of cases) {
    const at = before(ms)
    const it = { slug: 'aged', title: 'aged', status: 'open', at, docket_at: at, status_at: at } as unknown as WorkItem
    assert.equal(rowAge(it, 'updated').text, text, `${Math.round(ms / H)} h ago`)
  }
})

test('a mail row says how long ago, with the full date and time on hover', async t => {
  const at = before(3 * H)
  const v = await mountView(<MailRowView m={{ id: 'aged-mail', from: 'lead', kind: 'message', at, body: 'Release update' }}
    view={null} selected={false} party="lead" onClick={() => {}} />, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(timeCell(v.el.querySelector('.mailrow')), { text: '3h', title: fmtFull(at), label: fmtFull(at) })
})

test('an Attention mention row reads the same way', async t => {
  const at = before(3 * D)
  const v = await mountView(<MentionRowView mention={{ id: '1:0', blurb: 'see @user here', at }} party="worker-a"
    selected={false} onClick={() => {}} />, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(timeCell(v.el.querySelector('.mailrow')), { text: '3d', title: fmtFull(at), label: fmtFull(at) })
})

test('a presentation row reads the same way, never hundreds of hours', async t => {
  const at = before(20 * D)
  const rows = [{ id: 'old', node: 'coordinator-opus', title: 'An old presentation', tier: 'opus', at,
    evicted: false, node_state: 'live', format: 'markdown', bytes: 120 }] as DocRow[]
  const old = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    const one = String(url).match(/\/documents\/([^/?]+)$/)
    const data = one ? { ...rows[0], body: '# An old presentation' } : { documents: rows, total: rows.length, next_offset: null }
    return { ok: true, status: 200, headers: new Headers(), json: async () => data } as Response
  }) as typeof fetch
  const v = await mountView(<DocGalleryModal slug="synthetic" toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await v.unmount(); globalThis.fetch = old })
  await flush()
  assert.deepEqual(timeCell(v.el.querySelector('.doc-gallery-row')), { text: '3w', title: fmtFull(at), label: fmtFull(at) })
})
