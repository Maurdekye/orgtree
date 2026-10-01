// orgfreshness.test.tsx — `show-current-organization-statuses-immediately`.
//
// The defect: opening the organizations list painted the rows the renderer
// happened to have in memory — possibly minutes old, because the poll was
// switched off entirely while an org window had the list closed — and then
// silently corrected them three seconds later, because the poll it started on
// open was a bare `setInterval` whose first call is one period away.
//
// The properties asserted here: (1) opening asks AT ONCE, (2) rows taken
// before the open are never presented as current status, (3) the row markup
// says which of loading / stale / current it is showing, (4) the renderer asks
// once for the whole list rather than fanning out per organization, (5) the
// two races a later source inspection named — a request already in flight when
// the list opens, and an older completion landing after a newer one.
//
// ⚠ WHAT THESE DO NOT CLAIM. data-arch-astra verified in source (2026-09-21)
// that `GET /api/orgs` is fresh per returned observation but is NOT an atomic
// cross-organization snapshot: the documents are read serially and each
// `working_count` takes its lock separately, `_scan_orgs` silently skips
// failures, and a successful response carries no completeness marker. So
// nothing below asserts that the list is complete or internally consistent,
// because the renderer has no way to know that and no token to ask for it.
// What it asserts is that the renderer never claims more than it was given.
//
// Run:  node apps/desktop/renderer/tests/run.mjs orgfreshness
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { OrgRows } from '../src/App'
import {
  EMPTY_SNAPSHOT, ORG_POLL_MS, ORG_STALE_MS,
  orgFreshness, orgFreshnessNote, useOrgStatus,
} from '../src/orgstatus'
import type { OrgFreshness } from '../src/orgstatus'
import type { OrgListEntry } from '../src/types'

declare const __SRC_DIR__: string   // injected by run.mjs (see agentstray.test.tsx)
const src = (name: string) => fs.readFileSync(path.join(__SRC_DIR__, name), 'utf8')

const entry = (slug: string, patch: Partial<OrgListEntry> = {}): OrgListEntry => ({
  slug, name: slug, nodes: 9, live: 4, kiosk: false, created: null, ...patch,
})

// ------------------------------------------------------------- §1 the rule

test('a snapshot taken before the list opened is loading, never current', () => {
  const taken = { orgs: [], at: 1_000, error: null }
  assert.equal(orgFreshness(taken, 2_000, 2_010), 'loading',
    'rows older than the open are not an answer to "what is happening now"')
  assert.equal(orgFreshness(taken, 1_000, 1_010), 'current',
    'taken exactly at the open still counts')
  assert.equal(orgFreshness(taken, 0, 1_010), 'current',
    'a surface that is always visible (openedAt 0) accepts any snapshot')
})

test('nothing fetched yet is loading, a failing refresh is stale, and age decays', () => {
  assert.equal(orgFreshness(EMPTY_SNAPSHOT, 0, 5_000), 'loading')
  assert.equal(orgFreshness({ orgs: [], at: 1_000, error: 'offline' }, 0, 1_010), 'stale',
    'a failure means the numbers stopped moving, whatever their age')
  assert.equal(orgFreshness({ orgs: [], at: 1_000, error: null }, 0, 1_000 + ORG_STALE_MS),
    'current', 'the boundary itself is still current')
  assert.equal(orgFreshness({ orgs: [], at: 1_000, error: null }, 0, 1_001 + ORG_STALE_MS),
    'stale', 'one millisecond past it is not')
})

test('the staleness window is three polls, derived rather than invented', () => {
  assert.equal(ORG_STALE_MS, ORG_POLL_MS * 3)
})

test('the note is silent when current and names the failure when it is not', () => {
  assert.equal(orgFreshnessNote('current', 0, null), null)
  assert.equal(orgFreshnessNote('loading', 0, null), 'checking organization status…')
  assert.match(orgFreshnessNote('loading', 0, 'signal timed out') ?? '',
    /checking organization status… \(last attempt failed: signal timed out\)/,
    'waiting through a dead backend still says why')
  assert.equal(orgFreshnessNote('stale', 12_000, 'signal timed out'),
    'status from 12s ago — could not refresh: signal timed out')
})

// ----------------------------------------------------- §2 the leading call

/** A probe that mounts the hook and reports what it is showing. `active` is
 *  driven from the outside so a test can open and close the list. */
function Probe({ load, start = false }: {
  load: () => Promise<OrgListEntry[]>
  start?: boolean
}) {
  const [active, setActive] = useState(start)
  const status = useOrgStatus({ active, load })
  return <div>
    <button className="open" onClick={() => setActive(true)}>open</button>
    <button className="shut" onClick={() => setActive(false)}>shut</button>
    <span className="freshness">{status.freshness}</span>
    <span className="rows">{status.orgs.map((o) => o.slug).join(',')}</span>
    <span className="known">{String(status.known)}</span>
  </div>
}

function reader(el: HTMLElement) {
  return {
    freshness: el.querySelector('.freshness')!.textContent as OrgFreshness,
    rows: el.querySelector('.rows')!.textContent,
    known: el.querySelector('.known')!.textContent,
  }
}

async function probe(t: TestContext, load: () => Promise<OrgListEntry[]>, start = false) {
  useFakeClock()
  const view = await mountView(<Probe load={load} start={start} />, reader)
  t.after(async () => { await view.unmount(); realClock() })
  return view
}

test('opening the list asks at once — not one poll period later', async (t) => {
  const calls: number[] = []
  let answer: OrgListEntry[] = [entry('a', { working: 1, live: 2 })]
  const view = await probe(t, async () => { calls.push(Date.now()); return answer })
  await inAct(async () => { await flush() })
  assert.equal(calls.length, 1, 'mount asks once, so a closed list still has rows')

  const before = calls.length
  await advance(60_000)            // a long stretch with the list closed
  assert.equal(calls.length, before, 'a closed list does not poll')

  answer = [entry('a', { working: 3, live: 5 })]
  await inAct(async () => {
    (view.el.querySelector('.open') as HTMLElement).click()
  })
  assert.equal(calls.length, before + 1,
    'opening fires a request immediately — this is the leading call that was missing')
  await inAct(async () => { await flush() })
  assert.equal(view.last().freshness, 'current')
})

test('until the post-open snapshot lands the list says loading, not the old numbers', async (t) => {
  let release: ((rows: OrgListEntry[]) => void) | null = null
  const load = () => new Promise<OrgListEntry[]>((resolve) => { release = resolve })
  const view = await probe(t, load, true)
  // the very first request is still in flight
  assert.equal(view.last().freshness, 'loading')
  assert.equal(view.last().known, 'false')
  await inAct(async () => { release!([entry('a'), entry('b')]); await flush() })
  assert.deepEqual([view.last().freshness, view.last().rows, view.last().known],
    ['current', 'a,b', 'true'])

  // shut, let the world move on, reopen: the rows we hold predate the reopen
  await inAct(async () => { (view.el.querySelector('.shut') as HTMLElement).click() })
  await inAct(async () => { release!([entry('a'), entry('b')]); await flush() })
  await advance(30_000)
  await inAct(async () => { (view.el.querySelector('.open') as HTMLElement).click() })
  assert.equal(view.last().freshness, 'loading',
    'reopening re-arms the comparison, so held rows are not re-presented as current')
  assert.equal(view.last().rows, 'a,b',
    'the names and their order stay on screen — navigation is not status')
})

test('numbers go stale rather than silently freezing when the refresh fails', async (t) => {
  let fail = false
  const view = await probe(t, async () => {
    if (fail) throw new Error('signal timed out')
    return [entry('a', { working: 2, live: 4 })]
  }, true)
  await inAct(async () => { await flush() })
  assert.equal(view.last().freshness, 'current')
  fail = true
  await advance(ORG_POLL_MS + 50)
  assert.equal(view.last().freshness, 'stale')
  assert.equal(view.last().rows, 'a', 'the rows survive; only the claim about them changes')
})

test('current numbers decay to stale on their own once refreshes stop landing', async (t) => {
  let answer: OrgListEntry[] | null = [entry('a')]
  const view = await probe(t, async () => {
    if (!answer) await new Promise(() => {})    // hang, never resolve
    return answer!
  }, true)
  await inAct(async () => { await flush() })
  assert.equal(view.last().freshness, 'current')
  answer = null
  await advance(ORG_STALE_MS + ORG_POLL_MS)
  assert.equal(view.last().freshness, 'stale',
    'a poll that never comes back is as silent as one that errors')
})

// ---------------------------------------------------------- §3 the markup

async function rows(t: TestContext, freshness: OrgFreshness, ageMs = 0) {
  useFakeClock()
  const view = await mountView(
    <OrgRows slug={null} onPick={() => {}} onDelete={() => {}}
      freshness={freshness} ageMs={ageMs}
      orgs={[entry('busy', { name: 'Busy', working: 3, live: 5 })]} />,
    (el) => el)
  t.after(async () => { await view.unmount(); realClock() })
  return view.el
}

test('a loading row shows no counts and no spinner — the two things it cannot know', async (t) => {
  const el = await rows(t, 'loading')
  assert.equal(el.querySelector('.org-counts')!.textContent, '…')
  assert.equal(el.querySelector('.org-counts')!.getAttribute('title'), 'checking current status…')
  assert.ok(el.querySelector('.org-counts-loading'), 'the cell is marked, not merely blank')
  assert.equal(el.querySelector('.cc-spin'), null,
    'the spinner is an animated claim that a turn is executing NOW; it may not run on memory')
  assert.ok(el.querySelector('.org-activity'), 'the cell stays so the columns keep their grid')
  assert.equal(el.querySelector('.org-name-text')!.textContent, 'Busy',
    'the name is navigation and is never withheld')
})

test('a stale row keeps its numbers but says how old they are', async (t) => {
  const el = await rows(t, 'stale', 12_400)
  assert.equal(el.querySelector('.org-counts')!.textContent, '3/5')
  assert.ok(el.querySelector('.org-counts-stale'))
  assert.equal(el.querySelector('.org-counts')!.getAttribute('title'),
    'active / hired agents — from 12s ago, not refreshing')
  assert.equal(el.querySelector('.cc-spin'), null)
})

test('current rows are byte-for-byte what they always were', async (t) => {
  const el = await rows(t, 'current')
  assert.equal(el.querySelector('.org-counts')!.textContent, '3/5')
  assert.equal(el.querySelector('.org-counts')!.getAttribute('title'), 'active / hired agents')
  assert.ok(el.querySelector('.org-activity .cc-spin'))
  assert.equal(el.querySelector('.org-counts-loading'), null)
  assert.equal(el.querySelector('.org-counts-stale'), null)
})

// ------------------------------------------------ §4 the shape of the fetch

test('one request answers for every organization — no per-org fan-out to roll out serially', () => {
  const api = src('api.ts')
  assert.match(api, /export const listOrgs = \(\): Promise<OrgListEntry\[\]> => req\('\/api\/orgs'\)/,
    'the whole list is one call; there is nothing to stagger')
  const status = src('orgstatus.ts')
  assert.doesNotMatch(status, /Promise\.all|forEach.*fetch|map\(.*load\(/,
    'the poller never fans out per organization')
})

test('the leading-call-less interval is gone from App', () => {
  const app = src('App.tsx')
  assert.doesNotMatch(app, /setInterval\(refreshOrgs/,
    'the bare interval whose first call was one period away must not come back')
  assert.match(app, /useOrgStatus\(\{ active: orgListOpen/,
    'App drives the one poller off whether the list is on screen')
})

// ------------------------------------- §5 the two races the source inspection named
//
// data-arch-astra verified in source (2026-09-21) that `GET /api/orgs` is
// fresh per returned observation but is NOT an atomic cross-organization
// snapshot: the documents are read serially and each `working_count` takes its
// lock separately, so the two halves have different sample times and there is
// no coverage token to ask for. Two consequences land squarely on the
// renderer, and both are asserted here.

test('a request ALREADY IN FLIGHT when the list opens does not count as the answer', async (t) => {
  // it describes the world BEFORE the reader asked to see the world now
  const issued: number[] = []
  const pending: ((rows: OrgListEntry[]) => void)[] = []
  const view = await probe(t, () => {
    issued.push(Date.now())
    return new Promise<OrgListEntry[]>((resolve) => { pending.push(resolve) })
  })
  await inAct(async () => { await flush() })
  assert.equal(issued.length, 1, 'the mount read is in flight')

  await advance(30_000)
  await inAct(async () => { (view.el.querySelector('.open') as HTMLElement).click() })
  assert.equal(issued.length, 2, 'opening issues its own read')

  // the PRE-OPEN one comes back first, describing the old world
  await inAct(async () => { pending[0]!([entry('a', { working: 9, live: 9 })]); await flush() })
  assert.equal(view.last().freshness, 'loading',
    'a pre-open completion is not the post-open answer, however recently it landed')

  await inAct(async () => { pending[1]!([entry('a', { working: 1, live: 9 })]); await flush() })
  assert.equal(view.last().freshness, 'current', 'and the post-open one is')
})

test('an older completion landing last does not pull the visible rows backwards', async (t) => {
  const pending: ((rows: OrgListEntry[]) => void)[] = []
  const view = await probe(t, () => new Promise<OrgListEntry[]>((resolve) => { pending.push(resolve) }), true)
  await inAct(async () => { await flush() })
  // two polls in flight, the second issued later
  await advance(ORG_POLL_MS + 50)
  assert.ok(pending.length >= 2, 'a second read was issued')
  // the NEWER one settles first…
  await inAct(async () => { pending[1]!([entry('new')]); await flush() })
  assert.equal(view.last().rows, 'new')
  // …and the older one settles after it, and is discarded
  await inAct(async () => { pending[0]!([entry('old')]); await flush() })
  assert.equal(view.last().rows, 'new',
    'an out-of-order response is rejected rather than overwriting a newer observation')
  assert.equal(view.last().freshness, 'current')
})

test('an organization that reports no working count is never rendered as zero', async (t) => {
  // a public/kiosk listing omits `working` deliberately; absence is unknown,
  // not idle, and the source inspection called that out explicitly
  const el = await rows(t, 'current')
  assert.equal(el.querySelector('.org-counts')!.textContent, '3/5')
  const view = await mountView(
    <OrgRows slug={null} onPick={() => {}} onDelete={() => {}}
      orgs={[entry('public-row', { name: 'Public', live: 4 })]} />,
    (e) => e)
  t.after(async () => { await view.unmount() })
  assert.equal(view.el.querySelector('.org-counts')!.textContent, '4',
    'the hired count alone — an invented 0/4 would claim an idleness nobody reported')
})
