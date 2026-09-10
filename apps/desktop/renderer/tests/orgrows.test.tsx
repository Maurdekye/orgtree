// orgrows.test.tsx — the sidebar/home org rows as aligned columns (user spec
// 2026-09-10): every row renders an activity cell, the name, and an
// always-visible n/m active/hired count; the spinner is the activity cell's
// content only while that org has a turn executing. jsdom does no layout, so
// column ALIGNMENT is bound at its source — the one grid template in
// styles.css — while the DOM assertions prove every row feeds that grid the
// same cells in the same order (the alignment is only real if both hold).
//
// Run:  node tests/run.mjs orgrows
import { mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { OrgRows } from '../src/App'
import type { OrgListEntry } from '../src/types'

declare const __SRC_DIR__: string   // injected by run.mjs (see agentstray.test.tsx)

const entry = (slug: string, patch: Partial<OrgListEntry> = {}): OrgListEntry => ({
  slug, name: slug, nodes: 9, live: 4, kiosk: false, created: null, ...patch,
})

const ORGS: OrgListEntry[] = [
  entry('busy', { name: 'Busy Org', working: 3, live: 5 }),
  entry('quiet', { name: 'Quiet Org', working: 0, live: 2 }),
  entry('public-row', { name: 'Public', live: 4 }),   // kiosk listing: no working
]

async function mountRows(t: TestContext, orgs: OrgListEntry[],
  onPick: (slug: string) => void = () => {}, onDelete: (o: OrgListEntry) => void = () => {}) {
  useFakeClock()
  const view = await mountView(
    <OrgRows orgs={orgs} slug={null} onPick={onPick} onDelete={onDelete} />,
    (el) => el)
  t.after(async () => { await view.unmount(); realClock() })
  return view.el
}

test('every row renders the three cells in column order; n/m stays when idle', async (t) => {
  const el = await mountRows(t, ORGS)
  const rows = [...el.querySelectorAll('.org')]
  assert.equal(rows.length, 3)
  for (const row of rows) {
    const cells = [...row.children].map((c) => c.className.split(' ')[0])
    assert.deepEqual(cells, ['org-activity', 'org-name', 'org-counts', 'org-del'],
      'each row feeds the shared grid the same cells in the same order')
  }
  const counts = rows.map((r) => r.querySelector('.org-counts')!.textContent)
  assert.deepEqual(counts, ['3/5', '0/2', '4'],
    'n/m is active/hired, visible when idle; a working-less public row does not invent a 0')
  assert.equal(rows[1]!.querySelector('.org-counts')!.getAttribute('title'), 'active / hired agents')
})

test('the spinner appears only in the active row, inside the activity cell', async (t) => {
  const el = await mountRows(t, ORGS)
  const rows = [...el.querySelectorAll('.org')]
  assert.ok(rows[0]!.querySelector('.org-activity .cc-spin'), 'the busy org spins')
  assert.equal(rows[1]!.querySelector('.cc-spin'), null, 'an idle org shows no spinner')
  assert.equal(rows[2]!.querySelector('.cc-spin'), null, 'unknown activity shows no spinner')
  // the CELL is still there on idle rows — that is what keeps names flush
  assert.ok(rows[1]!.querySelector('.org-activity'))
  const tip = rows[0]!.querySelector('.working-ct')!.getAttribute('title')
  assert.equal(tip, '3 agents active — a turn executing now')
})

test('clicking a row picks its org; the delete button deletes without picking', async (t) => {
  const picked: string[] = []
  const doomed: string[] = []
  const el = await mountRows(t, ORGS, (s) => picked.push(s), (o) => doomed.push(o.slug))
  ;(el.querySelectorAll('.org')[1] as HTMLElement).click()
  assert.deepEqual(picked, ['quiet'])
  ;(el.querySelector('.org .org-del') as HTMLElement).click()
  assert.deepEqual(doomed, ['busy'])
  assert.deepEqual(picked, ['quiet'], 'the trash click must not also open the org')
})

test('the columns exist as ONE shared grid template, so the DOM order above is alignment', () => {
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const org = /\.org \{\r?\n([^}]*)\}/.exec(css)
  assert.ok(org, 'the .org row rule exists')
  assert.match(org![1]!, /display: grid; grid-template-columns: 14px minmax\(0, 1fr\) max-content auto;/)
  // the counts column right-aligns tabular digits over a shared floor width
  // — that pair is what makes per-row max-content read as one column
  assert.match(css, /\.org-counts \{\r?\n\s*font-variant-numeric: tabular-nums; text-align: right;/)
})
