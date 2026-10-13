import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { downloadUsageHistory, serializeUsageHistory, usageExportFilename, usageExportRows } from '../src/usagehistoryexport'
import type { UsageHistorySeries } from '../src/api'

const T = Date.parse('2026-10-13T12:34:56.789Z')
const s: UsageHistorySeries = {
  provider: 'openrouter', account: 'openrouter-2', account_label: 'Synthetic account',
  window: 'credits', group: 'balance', model: '', kind: 'amount', unit: 'USD', label: null,
  points: [], latest: { observed_at: new Date(T).toISOString(), used_pct: null, amount: 0, resets_at: null },
}

// Independent CSV reader, including embedded CRLF, delimiters and escaped quotes.
function readCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted
    } else if (c === ',' && !quoted) { row.push(cell); cell = '' }
    else if (c === '\r' && text[i + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; i++
    } else cell += c
  }
  assert.equal(quoted, false)
  assert.equal(cell, '')
  return rows
}

test('export preserves chronological measured values, UTC milliseconds and standalone identity', () => {
  const input = [{ t: T + 1000, v: 0 }, { t: T, v: 12.3456789 }, { t: T + 2000, v: -1.25 }]
  const rows = usageExportRows(s, input)
  assert.deepEqual(rows.map(r => [r.timestamp, r.value]), [
    ['2026-10-13T12:34:56.789Z', 12.3456789], ['2026-10-13T12:34:57.789Z', 0], ['2026-10-13T12:34:58.789Z', -1.25],
  ])
  assert.deepEqual(rows[0], { timestamp: '2026-10-13T12:34:56.789Z', value: 12.3456789,
    provider: 'openrouter', account: 'openrouter-2', window: 'credits', group: 'balance', model: '', kind: 'amount', unit: 'USD' })
  assert.equal(input[0]!.t, T + 1000, 'sorting cannot mutate the chart points')
})

test('CSV RFC4180 quotes commas, quotes and newlines while preserving UTF-8 identity', () => {
  const special = { ...s, provider: 'réseau', account: 'acct,"two"', group: 'line\r\nnext', model: 'model, "scope"' }
  const text = serializeUsageHistory(special, [{ t: T, v: 12.3456789 }], 'csv')
  const rows = readCsv(text)
  assert.deepEqual(rows[0], ['timestamp', 'value', 'provider', 'account', 'window', 'group', 'model', 'kind', 'unit'])
  assert.deepEqual(rows[1], ['2026-10-13T12:34:56.789Z', '12.3456789', 'réseau', 'acct,"two"', 'credits', 'line\r\nnext', 'model, "scope"', 'amount', 'USD'])
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text)
})

test('JSONL has one object per reading with equivalent CSV fields and escaped identity newlines', () => {
  const special = { ...s, group: 'line\nnext', model: 'a"b' }
  const readings = [{ t: T + 1, v: 45.678 }, { t: T, v: 1 }]
  const lines = serializeUsageHistory(special, readings, 'jsonl').trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(line => JSON.parse(line)), usageExportRows(special, readings))
  const csv = readCsv(serializeUsageHistory(special, readings, 'csv'))
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)), csv[0])
  assert.deepEqual(Object.values(JSON.parse(lines[0]!)).map(String), csv[1])
})

test('missing/nonfinite values and units stay empty/null, real zeros stay zero', () => {
  const percent = { ...s, kind: 'percent' as const, unit: null }
  const readings = [{ t: T, v: null }, { t: T + 1, v: NaN }, { t: T + 2, v: Infinity }, { t: T + 3, v: 0 }]
  const rows = serializeUsageHistory(percent, readings, 'jsonl').trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(r => r.value), [null, null, null, 0])
  assert.ok(rows.every(r => r.unit === null && r.kind === 'percent'))
  assert.deepEqual(readCsv(serializeUsageHistory(percent, readings, 'csv')).slice(1).map(r => [r[1], r[8]]), [['', ''], ['', ''], ['', ''], ['0', '']])
})

test('an empty measured series exports no fabricated reading', () => {
  assert.equal(readCsv(serializeUsageHistory(s, [], 'csv')).length, 1)
  assert.equal(serializeUsageHistory(s, [], 'jsonl'), '')
})

test('default filename identifies the series and selected dates with bounded safe components', () => {
  const file = usageExportFilename({ ...s, account: 'acct/unsafe:two', window: 'weekly?', model: 'x'.repeat(400) }, T - 86400000, T, 'jsonl')
  assert.match(file, /^usage-openrouter-acct-unsafe-two-weekly-/)
  assert.match(file, /-2026-10-12_2026-10-13\.jsonl$/)
  assert.doesNotMatch(file, /[<>:"/\\|?*\u0000-\u001f]/)
  assert.ok(file.length < 255)
})

test('normal Blob download uses the supplied main or child document and releases its URL', () => {
  const child = new JSDOM('<!doctype html><html><body></body></html>')
  const create = window.URL.createObjectURL, revoke = window.URL.revokeObjectURL, timeout = window.setTimeout
  const mainClick = window.HTMLAnchorElement.prototype.click
  const downloads: { owner: Document; name: string; url: string }[] = [], blobs: Blob[] = [], revoked: string[] = []
  const click = function (this: HTMLAnchorElement) { downloads.push({ owner: this.ownerDocument, name: this.download, url: this.href }) }
  window.HTMLAnchorElement.prototype.click = click
  child.window.HTMLAnchorElement.prototype.click = click
  window.URL.createObjectURL = blob => { blobs.push(blob as Blob); return 'blob:synthetic-' + blobs.length }
  window.URL.revokeObjectURL = url => { revoked.push(url) }
  window.setTimeout = ((fn: () => void) => { fn(); return 0 }) as typeof window.setTimeout
  try {
    for (const owner of [document, child.window.document]) {
      for (const format of ['csv', 'jsonl'] as const) downloadUsageHistory(owner, s, [{ t: T, v: 1.23 }], T, T, format)
      assert.equal(owner.querySelectorAll('a').length, 0, 'temporary anchors removed')
    }
    assert.equal(downloads.length, 4)
    assert.deepEqual(downloads.map(d => d.owner), [document, document, child.window.document, child.window.document])
    assert.ok(downloads.every(d => d.name.endsWith('.csv') || d.name.endsWith('.jsonl')))
    assert.deepEqual(blobs.map(b => b.type), ['text/csv;charset=utf-8', 'application/x-ndjson;charset=utf-8', 'text/csv;charset=utf-8', 'application/x-ndjson;charset=utf-8'])
    assert.deepEqual(revoked, downloads.map(d => d.url))
  } finally {
    window.HTMLAnchorElement.prototype.click = mainClick
    window.URL.createObjectURL = create; window.URL.revokeObjectURL = revoke; window.setTimeout = timeout
    child.window.close()
  }
})
