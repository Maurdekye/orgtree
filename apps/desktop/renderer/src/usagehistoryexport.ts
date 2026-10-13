import type { UsageHistorySeries } from './api'

export type UsageExportFormat = 'csv' | 'jsonl'
type Reading = { t: number; v: number | null }
const FIELDS = ['timestamp', 'value', 'provider', 'account', 'window', 'group', 'model', 'kind', 'unit'] as const

/** The card supplies the former table's measured points, never its projection
 * or aggregate statistics. No missing observation is invented as zero. */
export function usageExportRows(series: UsageHistorySeries, readings: readonly Reading[]) {
  return [...readings].sort((a, b) => a.t - b.t).map(p => ({
    timestamp: new Date(p.t).toISOString(),
    value: p.v != null && Number.isFinite(p.v) ? p.v : null,
    provider: series.provider, account: series.account, window: series.window,
    group: series.group, model: series.model, kind: series.kind, unit: series.unit,
  }))
}

function csvCell(value: string | number | null): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function serializeUsageHistory(series: UsageHistorySeries, readings: readonly Reading[], format: UsageExportFormat): string {
  const rows = usageExportRows(series, readings)
  return format === 'csv'
    ? [FIELDS.join(','), ...rows.map(row => FIELDS.map(field => csvCell(row[field])).join(','))].join('\r\n') + '\r\n'
    : rows.map(row => JSON.stringify(row) + '\n').join('')
}

export function usageExportFilename(series: UsageHistorySeries, since: number, until: number, format: UsageExportFormat): string {
  const safe = (text: string) => text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 36).replace(/[. ]+$/g, '') || 'all'
  const date = (t: number) => new Date(t).toISOString().slice(0, 10)
  return `usage-${[series.provider, series.account, series.window, series.group, series.model].map(safe).join('-')}-${date(since)}_${date(until)}.${format}`
}

/** Use the same Blob/anchor download path as documents and templates. The
 * anchor belongs to the clicked button's document (main frame or popout). */
export function downloadUsageHistory(owner: Document, series: UsageHistorySeries, readings: readonly Reading[],
  since: number, until: number, format: UsageExportFormat): void {
  const blob = new Blob([serializeUsageHistory(series, readings, format)], {
    type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/x-ndjson;charset=utf-8',
  })
  const url = window.URL.createObjectURL(blob)
  const anchor = owner.createElement('a')
  anchor.href = url
  anchor.download = usageExportFilename(series, since, until, format)
  owner.body.appendChild(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    window.setTimeout(() => window.URL.revokeObjectURL(url), 30_000)
  }
}
