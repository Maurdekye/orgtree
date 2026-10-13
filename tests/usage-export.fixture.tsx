import { createRoot } from 'react-dom/client'
import { UsageHistoryModal } from '../apps/desktop/renderer/src/usagehistory'
import { CurrentOrg } from '../apps/desktop/renderer/src/popout'
import type { UsageHistory, UsageHistorySeries } from '../apps/desktop/renderer/src/api'

const W = window as any
const NOW = Date.parse('2026-10-13T12:00:00Z'), H = 3600000
const iso = (t: number) => new Date(t).toISOString()
const series: UsageHistorySeries = {
  provider: 'openai', account: 'openai/primary', account_label: 'Synthetic Codex login',
  window: 'session', group: '5h', model: '', kind: 'percent', unit: null, label: 'Session',
  latest: { observed_at: iso(NOW - H), used_pct: 17.3456789, amount: null, resets_at: iso(NOW + H) },
  points: [[-30, 65], [-26, 90], [-3, 2], [-1, 17.3456789]].map(([h, v]) => ({
    n: 1, t0: iso(NOW + h * H), t1: iso(NOW + h * H), first: v, last: v, min: v, max: v, avg: v,
  })),
}
const requests: string[] = [], errors: string[] = []
W.addEventListener('error', (e: ErrorEvent) => errors.push(e.message))
W.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => errors.push(String(e.reason)))
W.fetch = async (input: unknown) => {
  const url = new URL(String(input), location.origin)
  if (requests.length < 20) requests.push(url.pathname + url.search)
  const range = url.searchParams.get('range') === '24h' ? '24h' : '7d'
  const current = range === '24h' ? { ...series, points: series.points.slice(2) } : series
  const data: UsageHistory = {
    range, since: iso(NOW - (range === '24h' ? 24 : 168) * H), until: iso(NOW), oldest: iso(NOW - 200 * H),
    bucket_s: 60, keepalive_min: 60, retain_days: 90, truncated: false,
    series: [current, { ...current, provider: 'claude', account: 'claude/primary', account_label: 'Synthetic Claude login' }],
    resets: [{ at: iso(NOW - 3 * H), account: series.account, window: series.window, group: series.group,
      model: '', used_pct: 2, amount: null, resets_at: null, prev_pct: 90, prev_amount: null, prev_resets_at: null }],
    states: [],
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
W.orgtreeDesktop = { getPopoutState: async (name: string) => ({ name, present: true, maximized: false }),
  getPreferences: async () => ({}), onEvent: () => () => {} }
const root = createRoot(document.getElementById('root')!)
root.render(<CurrentOrg.Provider value="synthetic"><UsageHistoryModal close={() => {}} /></CurrentOrg.Provider>)
W.proof = { requests, errors, dispose: () => root.unmount() }
