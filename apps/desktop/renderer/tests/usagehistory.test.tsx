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
// §5 (user 2026-10-17) switching the period keeps the content, its elements and
//    its scroll position until the new data arrives, and swaps it in place; the
//    account filter names every account with its provider.

// §4 the projected-ahead slider (user 2026-10-17): 0-100 % of the graph's width,
//    default 20 %, live (no refetch), remembered, the time
//    SCALE fixed (history slides off the left edge, never squeezed) and the thumb
//    mirroring the now-line (rightmost = 0 % ahead).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usagehistory

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { modelSeries, seriesTitle, UsageHistoryModal } from '../src/usagehistory'
import * as UH from '../src/usagehistory'
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

// ------------------------------------------------------- §4 projected-ahead slider
const D = 7 * 24 * H
const SINCE = NOW - D
const TO = NOW + D * 0.25

test('§4.1 the axis: a fixed time scale, the now-line sits `share` in from the right edge', () => {
  const ax = (share: number) => UH.aheadAxis(SINCE, NOW, share)
  const span = D
  assert.equal(UH.AHEAD_DEFAULT, 20)
  for (const share of [0, 0.05, 0.2, 0.5, 0.95, 1]) {
    const a = ax(share)
    assert.ok(Math.abs(a.nowAt - (1 - share)) < 1e-9 && Math.abs(a.at(NOW) - (1 - share)) < 1e-9, `now at ${1 - share}`)
    assert.ok(Math.abs((a.at(NOW + D) - a.at(NOW)) - D / span) < 1e-9, `a week is the same width at share ${share}: no squeezing`)
  }
  assert.equal(ax(0).at(NOW), 1, '0 %: the now line is the right edge')
  assert.equal(ax(0).at(SINCE), 0, '0 %: the whole period of history fills the plot, no blank strip')
  assert.ok(ax(0.2).at(SINCE) < 0 && Math.abs(ax(0.2).at(SINCE + 0.2 * D)) < 1e-9, '20 %: the oldest fifth is already off the left edge')
  const half = ax(0.5)
  assert.ok(half.at(SINCE) < 0, '50 %: the oldest history has slid off the left edge')
  assert.equal(half.left, NOW - 0.5 * span)
  const all = ax(1)
  assert.equal(all.at(NOW), 0, '100 %: the now line is the left edge')
  assert.equal(all.right, NOW + D, '100 %: the pane ahead is a whole period')
})

test('§4.2 the axis inverts: a pointer position reads back the time it was drawn at', () => {
  for (const share of [0, 0.05, 0.2, 0.5, 0.95, 1]) {
    const ax = UH.aheadAxis(SINCE, NOW, share)
    for (const t of [SINCE, SINCE + D / 5, NOW, NOW + D / 10, TO]) assert.ok(Math.abs(ax.time(ax.at(t)) - t) < 1000, `share ${share} t ${t}`)
  }
})

const withWidth = async <T,>(fn: () => Promise<T>): Promise<T> => {
  // jsdom does no layout: give the charts a width so their svg is drawn
  const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 800 })
  try { return await fn() } finally { delete (proto as Record<string, unknown>).clientWidth }
}
const chartPanel = async () => {
  const f = stubFetch(payload({
    oldest: iso(NOW - 3 * 24 * H),
    series: [series([bucket(NOW - 2 * H, 10), bucket(NOW - H, 20)])],
  }))
  const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
  await inAct(async () => { await flush(8) })
  return { f, view }
}
const slide = async (view: { el: HTMLElement }, pct: number) => {
  const input = view.el.querySelector('.uh-header input[type="range"]') as HTMLInputElement
  await inAct(async () => {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
    set.call(input, String(pct))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush(4)
  })
}
const has = (el: HTMLElement, sel: string) => el.querySelector(sel) !== null

test('§4.3 a 0-100 slider in the header defaults to 20 % and re-lays out live without refetching', async () => {
  globalThis.localStorage.removeItem(UH.AHEAD_KEY)
  await withWidth(async () => {
    const { f, view } = await chartPanel()
    try {
      const input = view.el.querySelector('.uh-header input[type="range"]') as HTMLInputElement
      assert.ok(input, 'the slider is in the sticky header')
      assert.equal(input.getAttribute('aria-label'), 'Projected-ahead share of the graph')
      // mirrored: the thumb sits where the now-line sits, so 20 % ahead reads 80 and 0 % ahead is the rightmost 100
      assert.deepEqual([input.min, input.max, input.value], ['0', '100', '80'])
      assert.equal(input.getAttribute('aria-valuetext'), '20% of the graph')
      const nowX = () => Number(view.el.querySelector('rect.uh-future')!.getAttribute('x'))
      const widthX = () => Number(view.el.querySelector('rect.uh-future')!.getAttribute('width'))
      const endX = () => Number(view.el.querySelector('.uh-end')!.getAttribute('cx'))
      const plot = 800 - 44 - 12
      assert.ok(Math.abs(widthX() - plot * 0.2) < 0.5, `future pane is 20 % of the plot (${widthX()} of ${plot})`)
      assert.ok(has(view.el, '.uh-proj') && has(view.el, '.uh-line'))
      const gap = nowX() - endX()
      const fetches = f.seen.length
      await slide(view, 50)  // the thumb halfway: the now-line halfway
      assert.ok(Math.abs(widthX() - plot * 0.5) < 0.5, `50 % (${widthX()})`)
      assert.ok(Math.abs(nowX() - (44 + plot * 0.5)) < 0.5, 'the now divider moved left with the thumb')
      assert.ok(Math.abs((nowX() - endX()) - gap) < 1e-6, 'the history keeps its scale: it slid, it was not squeezed')
      assert.equal(f.seen.length, fetches, 'no refetch while dragging')
      assert.match(view.el.querySelector('.uh-ahead output')?.textContent ?? '', /50%/)
      await slide(view, 90)  // thumb right: only 10 % ahead
      assert.ok(Math.abs(widthX() - plot * 0.1) < 0.5, `10 % (${widthX()})`)
      await view.unmount()
    } finally { f.restore() }
  })
})

test('§4.4 the rightmost thumb is 0 % ahead (no future pane, no projection); the leftmost is all projection', async () => {
  await withWidth(async () => {
    const { f, view } = await chartPanel()
    try {
      await slide(view, 100)
      assert.equal(has(view.el, 'rect.uh-future'), false, 'no future pane')
      assert.equal(has(view.el, '.uh-proj'), false, 'no projection line')
      assert.equal(has(view.el, '.uh-line'), true, 'the measured line is still there')
      assert.equal(/projected/.test(view.el.querySelector('.uh-foot')?.textContent ?? ''), false, 'no projection caption')
      await slide(view, 0)
      assert.equal(has(view.el, '.uh-line'), false, 'no measured line: the history is entirely off the left edge')
      assert.equal(has(view.el, '.uh-end'), false)
      assert.equal(has(view.el, '.uh-proj'), true, 'the projection fills the graph')
      const r = view.el.querySelector('rect.uh-future')!
      assert.equal(Number(r.getAttribute('x')), 44)
      await view.unmount()
    } finally { f.restore() }
  })
})

test('§4.4b the history that slides off the left edge is clipped to the plot, not drawn over the axis', async () => {
  await withWidth(async () => {
    const { f, view } = await chartPanel()
    try {
      await slide(view, 40)
      const svg = view.el.querySelector('.uh-plot svg')!
      const clip = svg.querySelector('clipPath rect')!
      assert.deepEqual([clip.getAttribute('x'), clip.getAttribute('width')], ['44', String(800 - 44 - 12)])
      const g = svg.querySelector('g[clip-path]')!
      assert.ok(g.querySelector('.uh-line') && g.querySelector('rect.uh-future'), 'lines and the future pane are inside the clip')
      await view.unmount()
    } finally { f.restore() }
  })
})

test('§4.5 the chosen share is remembered across a reopen and survives bad stored values', async () => {
  globalThis.localStorage.removeItem(UH.AHEAD_KEY)
  const f = stubFetch(payload({}))
  try {
    let view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    await slide(view, 35)  // the thumb at 35: 65 % ahead
    assert.equal(globalThis.localStorage.getItem(UH.AHEAD_KEY), '65', 'the stored value is the ahead share, not the thumb')
    await view.unmount()
    view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const value = () => (view.el.querySelector('.uh-header input[type="range"]') as HTMLInputElement).value
    assert.equal(value(), '35')
    // a stored value that is out of range or not a number reads as the nearest legal value / the default
    for (const [stored, expect] of [['999', '0'], ['-4', '100'], ['abc', '80'], ['', '80']] as const) {
      await inAct(async () => {
        globalThis.localStorage.setItem(UH.AHEAD_KEY, stored)
        window.dispatchEvent(new window.StorageEvent('storage', { key: UH.AHEAD_KEY }))
        await flush(2)
      })
      assert.equal(value(), expect, `stored "${stored}"`)
    }
    await view.unmount()
    UH.setAheadShare(20)
  } finally { f.restore() }
})

test('§4.6 a sub-day axis still gets its time labels, whatever hour it starts on', () => {
  // the future pane alone (100 %) and the 24-hour range are both spans of this kind
  for (const start of ['2026-10-17T16:19:00', '2026-10-17T03:40:00', '2026-10-17T22:05:00']) {
    const from = new Date(start).getTime()
    const ticks = UH.timeTicks(from, from + 42 * H)
    assert.ok(ticks.length >= 3, `${start}: ${ticks.length} ticks`)
    const step = (ticks[1]!.t - ticks[0]!.t) / H
    assert.ok(ticks.every((k) => k.t >= from && new Date(k.t).getHours() % step === 0), 'on round hours')
  }
})

// ------------------------------------------------ §5 period switch / account names
test('§5.1 switching the period keeps the shown content (same elements) until the new data arrives', async () => {
  const g = globalThis as unknown as Record<string, unknown>
  const week = payload({ oldest: iso(NOW - 3 * 24 * H), series: [series([bucket(NOW - 2 * H, 10), bucket(NOW - H, 20)])] })
  const day = payload({ range: '24h', oldest: iso(NOW - 3 * 24 * H), series: [series([bucket(NOW - 2 * H, 10), bucket(NOW - H, 20)])] })
  let release: () => void = () => {}
  const seen: string[] = []
  g.fetch = ((url: string) => {
    seen.push(String(url))
    const body = String(url).includes('range=24h') ? day : week
    const reply = { ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) }
    // the 24 h answer is held back until the test lets it through
    return String(url).includes('range=24h') ? new Promise((r) => { release = () => r(reply) }) : Promise.resolve(reply)
  }) as unknown as typeof fetch
  try {
    const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const card = view.el.querySelector('.uh-card')
    const head = view.el.querySelector('.uh-account')
    assert.ok(card && head)
    const button = [...view.el.querySelectorAll('.uh-header [aria-label="period"] button')][0] as HTMLButtonElement
    await inAct(async () => { button.click(); await flush(6) })
    assert.ok(seen.some((u) => u.includes('range=24h')), 'the new period was requested')
    assert.equal(button.getAttribute('aria-pressed'), 'true', 'the choice shows at once')
    assert.equal(card!.isConnected && view.el.querySelector('.uh-card') === card, true, 'the old graphs stay mounted while waiting')
    assert.equal(view.el.querySelector('.uh-account') === head, true)
    assert.equal(/loading/.test(view.el.textContent ?? ''), false, 'no loading state replaces the content')
    assert.equal(view.el.querySelector('[aria-busy="true"]') !== null, true, 'a quiet in-place busy hint')
    await inAct(async () => { release(); await flush(8) })
    assert.equal(view.el.querySelector('.uh-card') === card, true, 'the new data is swapped in place, not remounted')
    assert.equal(view.el.querySelector('[aria-busy="true"]') === null, true, 'busy hint cleared')
    await view.unmount()
  } finally { delete g.fetch }
})

test('§5.2 every account in the filter is prefixed with its provider; "All accounts" is not', async () => {
  const f = stubFetch(payload({
    oldest: iso(NOW - 3 * 24 * H),
    series: [
      series([bucket(NOW - H, 10), bucket(NOW, 20)]),
      series([bucket(NOW - H, 40)], { account: 'openai/primary', account_label: 'a@example.test', provider: 'openai', window: 'weekly_all', label: 'Weekly' }),
      series([bucket(NOW - H, 5)], { account: 'or-1', account_label: 'sk-or-v1-3dd...5c0', provider: 'openrouter', window: 'spend', label: 'Spend', kind: 'amount', unit: 'USD' }),
    ],
  }))
  try {
    const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
    await inAct(async () => { await flush(8) })
    const select = view.el.querySelector('.uh-header select[aria-label="Account"]') as HTMLSelectElement
    assert.deepEqual([...select.options].map((o) => o.textContent),
      ['All accounts', 'Claude · a@example.test', 'Codex · a@example.test', 'OpenRouter · sk-or-v1-3dd...5c0'])
    await inAct(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')!.set!
      set.call(select, 'openai/primary')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flush(4)
    })
    assert.equal(view.el.querySelectorAll('.uh-card').length, 1, 'filtering by the prefixed entry still filters')
    assert.equal(select.selectedOptions[0]!.textContent, 'Codex · a@example.test', 'the closed dropdown carries the prefix too')
    await view.unmount()
  } finally { f.restore() }
})

test('§4.7 the projection runs as far as the pane ahead reaches', () => {
  const s7 = series([bucket(NOW - 2 * H, 10), bucket(NOW - H, 10.1), bucket(NOW, 10.2)],
    { latest: { observed_at: iso(NOW), used_pct: 10.2, amount: null, resets_at: null } })
  const base = { now: NOW, since: SINCE, until: NOW, gapMs: 75 * 60_000 }
  assert.equal(modelSeries(s7, [], base).projection!.to.t, NOW + D * 0.25, 'no horizon given: a quarter of the period')
  const wide = modelSeries(s7, [], { ...base, horizonMs: UH.aheadAxis(SINCE, NOW, 1).right - NOW })
  assert.equal(wide.projection!.to.t, NOW + D, 'at 100 % it runs the whole plot')
})

// §6 (user 2026-10-19): across a large time gap between two readings the line is a
//    STEP at the new reading (hold the old value, jump when the new one arrives),
//    never a diagonal that suggests a change nobody observed.
const MIN = 60_000
const P = (t: number, v: number) => ({ t, v })

test('§6.1 stepPoints: a gap of STEP_GAP_MS or more gets a corner at the new time with the old value', () => {
  assert.equal(UH.STEP_GAP_MS, 30 * MIN)
  const seg = [P(0, 10), P(10 * MIN, 12), P(10 * MIN + UH.STEP_GAP_MS, 30), P(10 * MIN + UH.STEP_GAP_MS + MIN, 31)]
  assert.deepEqual(UH.stepPoints(seg), [
    P(0, 10), P(10 * MIN, 12),
    P(10 * MIN + UH.STEP_GAP_MS, 12),  // held flat until the new reading ...
    P(10 * MIN + UH.STEP_GAP_MS, 30),  // ... then the jump, exactly at its time
    P(10 * MIN + UH.STEP_GAP_MS + MIN, 31),
  ])
  const close = [P(0, 10), P(UH.STEP_GAP_MS - 1, 12)]
  assert.deepEqual(UH.stepPoints(close), close, 'just under the threshold stays linear')
  assert.deepEqual(UH.stepPoints([P(0, 1)]), [P(0, 1)])
})

test('§6.2 the drawn line steps across a long gap and stays linear across a short one', async () => {
  const f = stubFetch(payload({
    oldest: iso(NOW - 3 * 24 * H),
    series: [series([bucket(NOW - 3 * H, 10), bucket(NOW - 3 * H + 6 * MIN, 12),
      bucket(NOW - H, 30), bucket(NOW - H + 6 * MIN, 31)])],
  }))
  await withWidth(async () => {
    try {
      const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
      await inAct(async () => { await flush(8) })
      const d = view.el.querySelector('path.uh-line')!.getAttribute('d')!
      const pts = d.match(/[ML]([\d.]+),([\d.]+)/g)!.map((s) => s.slice(1).split(',').map(Number) as [number, number])
      assert.equal(pts.length, 5, `4 readings + 1 corner in ${d}`)
      assert.equal(pts[2]![1], pts[1]![1], 'flat: the corner holds the previous value')
      assert.equal(pts[2]![0], pts[3]![0], 'then a vertical jump at the new reading')
      assert.ok(pts[3]![1] < pts[2]![1], 'the jump goes up to 30 %')
      assert.ok(pts[1]![0] < pts[2]![0] && pts[1]![1] !== pts[0]![1], 'the 6-minute pair keeps its linear slope')
      await view.unmount()
    } finally { f.restore() }
  })
})

test('§6.3 the hover readout inside a long gap shows the value in effect, not the nearer later reading', async () => {
  const f = stubFetch(payload({
    oldest: iso(NOW - 3 * 24 * H),
    series: [series([bucket(NOW - 3 * H, 10), bucket(NOW - 3 * H + 6 * MIN, 12), bucket(NOW - H, 30)])],
  }))
  await withWidth(async () => {
    try {
      const view = await mountView(<UsageHistoryModal close={() => {}} />, (el) => el)
      await inAct(async () => { await flush(8) })
      const ax = UH.aheadAxis(NOW - 7 * 24 * H, NOW, UH.AHEAD_DEFAULT / 100)
      const svg = view.el.querySelector('.uh-plot svg')!
      const hoverAt = async (t: number) => {
        const px = 44 + ax.at(t) * (800 - 44 - 12)
        await inAct(async () => {
          svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: px }))
          await flush(2)
        })
        return view.el.querySelector('.uh-tip')?.textContent ?? ''
      }
      assert.match(await hoverAt(NOW - 1.1 * H), /^12%/, 'closer to the 30 % reading, but it had not happened yet')
      assert.match(await hoverAt(NOW - H + 2 * MIN), /^30%/, 'after the jump it reads the new value')
      await view.unmount()
    } finally { f.restore() }
  })
})
