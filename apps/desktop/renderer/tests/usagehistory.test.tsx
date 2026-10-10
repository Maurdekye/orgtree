// usagehistory.test.tsx — the usage history panel (docket
// track-usage-over-time-and-show-usage-analytics, phase 2).
//
// §1 the pure model: a gap and an unavailable span break the line, a reset
//    breaks it too and "change" is measured from the reset, never across it;
//    the projection is a trend to the next reset, capped at 100 %.
// §2 the real panel: an empty install says so (no graph at 0), a sparse
//    series says it has too few readings, and filters hide series.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usagehistory

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelSeries, seriesTitle, unavailableSpans, UsageHistoryModal } from '../src/usagehistory'
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

test('§1.1 a time gap longer than the keepalive breaks the line', () => {
  const s = series([bucket(NOW - 10 * H, 5), bucket(NOW - 9.5 * H, 8),
    bucket(NOW - 3 * H, 20), bucket(NOW - 2.5 * H, 25)])
  const m = modelSeries(s, [], [], OPTS)
  assert.equal(m.segments.length, 2, 'the 6.5 h hole is a gap, not a line')
  assert.equal(m.stats.min, 5)
  assert.equal(m.stats.max, 25)
})

test('§1.2 an unavailable span breaks the line even when the points are close', () => {
  const s = series([bucket(NOW - 2 * H, 10), bucket(NOW - 1.5 * H, 12)])
  const spans = unavailableSpans([
    { account: 'claude/primary', account_label: '', provider: 'claude', at: iso(NOW - 1.9 * H), state: 'unavailable', detail: '401' },
    { account: 'claude/primary', account_label: '', provider: 'claude', at: iso(NOW - 1.6 * H), state: 'ok', detail: null },
  ], NOW).get('claude/primary') ?? []
  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.to, NOW - 1.6 * H, 'the span ends where the account came back')
  const m = modelSeries(s, [], spans, OPTS)
  assert.equal(m.segments.length, 2)
})

test('§1.3 a reset breaks the line and change is measured from it, not across it', () => {
  const s = series([bucket(NOW - 3 * H, 70), bucket(NOW - 2.5 * H, 90), bucket(NOW - 2 * H, 2), bucket(NOW - 1 * H, 12)])
  const m = modelSeries(s, [{ at: iso(NOW - 2 * H), account: 'claude/primary', window: 'session', group: 'session',
    model: '', used_pct: 2, amount: null, resets_at: null, prev_pct: 90, prev_amount: null, prev_resets_at: null }], [], OPTS)
  assert.equal(m.segments.length, 2, 'the drop from 90 to 2 is not drawn')
  assert.equal(m.stats.change, 10, 'since the reset: 2 → 12, never 70 → 12')
  assert.equal(m.stats.changeSince, NOW - 2 * H)
})

test('§1.4 the projection runs to the next reset, or stops at 100 %', () => {
  const slow = series([bucket(NOW - 2 * H, 10), bucket(NOW - 1 * H, 20), bucket(NOW, 30)])
  const a = modelSeries(slow, [], [], OPTS)
  assert.ok(a.projection)
  assert.equal(a.projection!.to.t, NOW + 2 * H, 'ends at the window\'s reset')
  assert.ok(Math.abs(a.projection!.to.v - 50) < 1e-6, '10 pts an hour, two hours on')
  assert.equal(a.nextReset, NOW + 2 * H)
  const fast = series([bucket(NOW - 2 * H, 40), bucket(NOW - 1 * H, 70), bucket(NOW, 90)])
  const b = modelSeries(fast, [], [], OPTS)
  assert.equal(b.projection!.hits, 'limit')
  assert.equal(b.projection!.to.v, 100)
  assert.ok(b.projection!.to.t < NOW + 2 * H)
})

test('§1.5 one reading: no projection, no change, still a current value', () => {
  const m = modelSeries(series([bucket(NOW - 10 * 60_000, 7)]), [], [], OPTS)
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
