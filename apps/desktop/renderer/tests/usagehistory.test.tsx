// usagehistory.test.tsx — the usage history panel (docket
// track-usage-over-time-and-show-usage-analytics, phase 2).
//
// §1 the pure model: a gap and an unavailable span break the line, a reset
//    breaks it too and "change" is measured from the reset, never across it;
//    the projection is a trend to the next reset, capped at 100 %.
// §2 the real panel: an empty install says so (no graph at 0), a sparse
//    series says it has too few readings, and filters hide series.
//
// §3 the header (user 2026-10-17): title, period and the four filters sit in one
//    sticky `.uh-header` above the graphs, compacted into two named groups;
//    the sticky/compact rules are checked in the real styles.css (jsdom does no
//    layout, so the pinned look itself is a screenshot, not a test).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usagehistory

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { modelSeries, seriesTitle, timeTicks, UsageHistoryModal } from '../src/usagehistory'
import type { UsageHistory, UsageHistoryBucket, UsageHistorySeries } from '../src/api'

const H = 3_600_000
const NOW = Date.parse('2026-10-09T12:00:00Z')
const iso = (t: number) => new Date(t).toISOString()
const bucket = (t: number, v: number): UsageHistoryBucket =>
  ({ n: 1, t0: iso(t), t1: iso(t), first: v, last: v, min: v, max: v, avg: v })

const series = (points: UsageHistoryBucket[], over: Partial<UsageHistorySeries> = {}): UsageHistorySeries => ({
  account: 'claude/primary', account_label: 'a@example.test', provider: 'claude', window: 'session',
  group: 'session', model: '', kind: 'percent', unit: null, label: 'Current session',
  latest: { observed_at: points.at(-1)?.t1 ?? iso(NOW), used_pct: points.at(-1)?.last ?? null, amount: null,
    resets_at: iso(NOW + 2 * H) },
  points, ...over,
})
const OPTS = { now: NOW, since: NOW - 24 * H, until: NOW, gapMs: 75 * 60_000 }

test('§1.1 a time gap is joined across, but the average counts only covered time', () => {
  const s = series([bucket(NOW - 10 * H, 5), bucket(NOW - 9.5 * H, 8),
    bucket(NOW - 3 * H, 20), bucket(NOW - 2.5 * H, 25)])
  const m = modelSeries(s, [], OPTS)
  assert.equal(m.segments.length, 1, 'user 2026-10-10: connect the points on either side of the gap')
  assert.equal(m.stats.min, 5)
  assert.equal(m.stats.max, 25)
  assert.ok(m.stats.avg != null && m.stats.avg > 10, `the 8 % before the 6.5 h hole is not held across it (avg ${m.stats.avg})`)
})

test('§1.2 an unavailable span is not marked: the readings either side are joined', () => {
  // the account could not be read for 3 hours: the engine wrote no reading
  const s = series([bucket(NOW - 5 * H, 10), bucket(NOW - 4.5 * H, 12), bucket(NOW - 1.5 * H, 30), bucket(NOW - H, 31)])
  const m = modelSeries(s, [], OPTS)
  assert.equal(m.segments.length, 1, 'user 2026-10-10: no break, no shading')
  assert.ok(!('unavailable' in m), 'the model carries no unavailable spans to draw')
})

test('§1.3 a reset breaks the line and change is measured from it, not across it', () => {
  const s = series([bucket(NOW - 3 * H, 70), bucket(NOW - 2.5 * H, 90), bucket(NOW - 2 * H, 2), bucket(NOW - 1 * H, 12)])
  const m = modelSeries(s, [{ at: iso(NOW - 2 * H), account: 'claude/primary', window: 'session', group: 'session',
    model: '', used_pct: 2, amount: null, resets_at: null, prev_pct: 90, prev_amount: null, prev_resets_at: null }], OPTS)
  assert.equal(m.segments.length, 2, 'the drop from 90 to 2 is not drawn')
  assert.equal(m.stats.change, 10, 'since the reset: 2 → 12, never 70 → 12')
  assert.equal(m.stats.changeSince, NOW - 2 * H)
})

test('§1.4 the projection runs to the next reset, or stops at 100 %', () => {
  const slow = series([bucket(NOW - 2 * H, 10), bucket(NOW - 1 * H, 20), bucket(NOW, 30)])
  const a = modelSeries(slow, [], OPTS)
  assert.ok(a.projection)
  assert.equal(a.projection!.to.t, NOW + 2 * H, 'ends at the window\'s reset')
  assert.ok(Math.abs(a.projection!.to.v - 50) < 1e-6, '10 pts an hour, two hours on')
  assert.equal(a.nextReset, NOW + 2 * H)
  const fast = series([bucket(NOW - 2 * H, 40), bucket(NOW - 1 * H, 70), bucket(NOW, 90)])
  const b = modelSeries(fast, [], OPTS)
  assert.equal(b.projection!.hits, 'limit')
  assert.equal(b.projection!.to.v, 100)
  assert.ok(b.projection!.to.t < NOW + 2 * H)
})

test('§1.5 one reading: no projection, no change, still a current value', () => {
  const m = modelSeries(series([bucket(NOW - 10 * 60_000, 7)]), [], OPTS)
  assert.equal(m.projection, null)
  assert.equal(m.noProjection, 'not enough readings yet')
  assert.equal(m.stats.change, null)
  assert.equal(m.stats.current?.v, 7)
  assert.equal(seriesTitle(series([], { label: null, window: 'weekly_all', model: 'opus' })), 'Weekly · opus')
})

const payload = (over: Partial<UsageHistory>): UsageHistory => ({
  range: '7d', since: iso(NOW - 7 * 24 * H), until: iso(NOW), bucket_s: 2400, retain_days: 90, keepalive_min: 60,
  oldest: null, series: [], resets: [], states: [], truncated: false, ...over,
})

const stubFetch = (body: UsageHistory) => {
  const g = globalThis as unknown as Record<string, unknown>
  const seen: string[] = []
  g.fetch = ((url: string) => {
    seen.push(String(url))
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  return { seen, restore: () => { delete g.fetch } }
}

test('§2.1 an empty install says there is no history and draws no graph', async () => {
  const f = stubFetch(payload({}))
  try {
    const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const text = view.el.textContent ?? ''
    assert.match(text, /No usage history yet/)
    assert.equal(view.el.querySelectorAll('.uh-card').length, 0)
    assert.ok(f.seen.some((u) => u.includes('/api/usage/history?range=7d')), f.seen.join(','))
    await view.unmount()
  } finally { f.restore() }
})

test('§2.2 series render per account; a filter hides the others', async () => {
  const f = stubFetch(payload({
    oldest: iso(NOW - 3 * 24 * H),
    series: [
      series([bucket(NOW - 2 * H, 10), bucket(NOW - H, 20)]),
      series([bucket(NOW - H, 40)], { account: 'claude-5', account_label: 'b@example.test', window: 'weekly_all', label: 'Weekly' }),
    ],
  }))
  try {
    const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    assert.equal(view.el.querySelectorAll('.uh-card').length, 2)
    assert.equal(view.el.querySelectorAll('.uh-account').length, 2)
    assert.match(view.el.textContent ?? '', /one reading so far/)
    const select = [...view.el.querySelectorAll('select')][1] as HTMLSelectElement
    await inAct(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')!.set!
      set.call(select, 'claude-5')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flush(4)
    })
    assert.equal(view.el.querySelectorAll('.uh-card').length, 1)
    assert.match(view.el.textContent ?? '', /b@example\.test/)
    await view.unmount()
  } finally { f.restore() }
})

test('§2.3 the Orgtree menu lists "Usage history…" right under "Usage…" and it opens the panel', async () => {
  const { OrgtreeMenu } = await import('../src/shell/menu')
  let opened = 0
  const view = await mountView(<OrgtreeMenu orgs={[]} freshness={'fresh' as never} ageMs={0} error={null}
    currentOrg={null} onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}} onUsage={() => {}}
    onUsageHistory={() => { opened++ }} onAppSettings={() => {}} />, (el) => el)
  await inAct(async () => {
    (view.el.querySelector('.shell-menu-button') as HTMLButtonElement).click()
    await flush(2)
  })
  const items = [...view.el.querySelectorAll('[role="menuitem"]')].map((e) => (e.textContent ?? '').trim())
  const at = items.findIndex((t) => t.startsWith('Usage history'))
  assert.ok(at > 0 && items[at - 1]!.startsWith('Usage…'), items.join(' | '))
  await inAct(async () => {
    (view.el.querySelectorAll('[role="menuitem"]')[at] as HTMLButtonElement).click()
    await flush(2)
  })
  assert.equal(opened, 1)
  await view.unmount()
})

// ----------------------------------------------------------------- §3 header
declare const __SRC_DIR__: string
const CSS = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const rule = (selector: string): string => {
  // the rule is found by its literal selector at the start of a line, then its declaration block is cut out
  const lines = CSS.split(String.fromCharCode(10))
  const at = lines.findIndex((l) => l.startsWith(selector + ' {'))
  assert.ok(at >= 0, `no "${selector}" rule in styles.css`)
  const body = lines.slice(at).join(' ')
  return body.slice(body.indexOf('{') + 1, body.indexOf('}'))
}

const mountPanel = async () => {
  const f = stubFetch(payload({
    oldest: iso(NOW - 3 * 24 * H),
    series: [series([bucket(NOW - 2 * H, 10), bucket(NOW - H, 20)])],
  }))
  const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
  await inAct(async () => { await flush(8) })
  return { f, view }
}

test('§3.1 title, period and filters share one header that the graphs are not part of', async () => {
  const { f, view } = await mountPanel()
  try {
    const header = view.el.querySelector('.uh-header')
    assert.ok(header, 'the page has a .uh-header')
    assert.match(header!.querySelector('h3')?.textContent ?? '', /Usage history/)
    const period = header!.querySelector('[role="group"][aria-label="period"]')
    assert.ok(period, 'the period buttons are one named group in the header')
    assert.deepEqual([...period!.querySelectorAll('button')].map((b) => b.textContent),
      ['24 hours', '7 days', '30 days', '90 days'])
    assert.equal(period!.querySelectorAll('button[aria-pressed="true"]').length, 1)
    const filters = header!.querySelector('[role="group"][aria-label="filters"]')
    assert.ok(filters, 'the four filters are one named group in the header')
    assert.deepEqual([...filters!.querySelectorAll('select')].map((s) => s.getAttribute('aria-label')),
      ['Provider', 'Account', 'Window', 'Model scope'], 'every filter keeps its accessible name, in order')
    assert.equal(header!.querySelectorAll('select').length, 4)
    assert.equal(header!.querySelector('.uh-card') === null, true, 'graphs scroll beneath, not inside')
    assert.equal(view.el.querySelectorAll('.uh-card').length, 1)
    await view.unmount()
  } finally { f.restore() }
})

test('§3.2 each compact filter says what it filters while nothing is chosen', async () => {
  const { f, view } = await mountPanel()
  try {
    const selects = [...view.el.querySelectorAll('.uh-header select')] as HTMLSelectElement[]
    assert.deepEqual(selects.map((s) => s.options[0]!.textContent),
      ['All providers', 'All accounts', 'All windows', 'All models'])
    assert.equal(selects.every((s) => s.getAttribute('title') === s.getAttribute('aria-label')), true,
      'the name is also the tooltip, as the visible label used to be')
    await view.unmount()
  } finally { f.restore() }
})

test('§3.3 choosing a period still re-reads the history', async () => {
  const { f, view } = await mountPanel()
  try {
    const day = [...view.el.querySelectorAll('.uh-header [aria-label="period"] button')][0] as HTMLButtonElement
    await inAct(async () => { day.click(); await flush(8) })
    assert.ok(f.seen.some((u) => u.includes('/api/usage/history?range=24h')), f.seen.join(','))
    assert.equal(day.getAttribute('aria-pressed'), 'true')
    await view.unmount()
  } finally { f.restore() }
})

test('§3.4 styles: the header is sticky at the panel edge on an opaque background', () => {
  const r = rule('.uh-header')
  assert.match(r, /position:\s*sticky/)
  assert.match(r, /top:\s*calc\(-1 \* var\(--panel-pad-y/, 'offset from the scroll container content box, like the pinned title bar')
  assert.match(r, /background:\s*var\(--panel\)/, 'opaque: the graphs must not show through')
  assert.match(r, /z-index:\s*[1-9]/)
  assert.ok(CSS.includes(':is(.modalpin-win, .modalpin-detached) > .uh-header > h3 { display: none; }'),
    'a window names itself in its title bar, so the header drops its own title')
})

test('§3.5 styles: the controls are compact and out-rank the roomy .settings sizes', () => {
  const size = (selector: string) => Number(/font-size:\s*([\d.]+)px/.exec(rule(selector))?.[1])
  assert.ok(size('.uh-ranges .uh-range') <= 13, 'period buttons <= 13px (was the 14px .settings button)')
  assert.ok(size('.uh-filters .uh-filter') <= 13, 'filter selects <= 13px (was the 14.5px .settings select)')
  assert.match(rule('.uh-ranges .uh-range'), /padding:\s*2px 9px/)
  assert.match(rule('.uh-filters .uh-filter'), /padding:\s*3px 6px/)
  assert.match(rule('.uh-filters'), /grid-template-columns:\s*repeat\(auto-fit/, 'the filters wrap as a block when the window is narrow')
})

test('§3.6 a sub-day axis still gets its time labels, whatever hour it starts on', () => {
  // local-time starts, so the hour is the same in every timezone; a 42 h span steps by 12 h
  for (const [h, m] of [[16, 19], [3, 40], [22, 5]] as const) {
    const from = new Date(2026, 9, 17, h, m).getTime()
    const ticks = timeTicks(from, from + 42 * H)
    assert.ok(ticks.length >= 3, `${h}:${m}: ${ticks.length} ticks`)
    const step = (ticks[1]!.t - ticks[0]!.t) / H
    assert.ok(ticks.every((k) => k.t >= from && new Date(k.t).getHours() % step === 0), 'on round hours')
  }
})
