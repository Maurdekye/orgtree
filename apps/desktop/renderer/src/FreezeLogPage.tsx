// /debug/freezes — the freeze log (freezelog.ts) as a page. Rendered by
// main.tsx INSTEAD of the app when the path ends in /debug/freezes, so a tab
// showing it records nothing of its own and the app's own state never loads.
// Reads localStorage, so it shows every tab's entries, including a tab that
// has since crashed — open it in a fresh tab after a freeze.
import { useState } from 'react'
import { clearFreezeLog, readFreezeLog, type FreezeEntry } from './freezelog'

export function isFreezeLogPath(pathname: string = location.pathname): boolean {
  return /\/debug\/freezes\/?$/.test(pathname)
}

const fmt = (at: number): string => {
  const d = new Date(at)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

const cell: React.CSSProperties = { padding: '2px 8px', borderBottom: '1px solid #ddd', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }

export default function FreezeLogPage() {
  const [entries, setEntries] = useState<FreezeEntry[]>(() => readFreezeLog())
  const [copied, setCopied] = useState(false)
  const newestFirst = [...entries].reverse()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 1))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <main style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }} data-testid="freeze-log">
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>Freeze log</h1>
      <p style={{ margin: '0 0 12px', color: '#555', fontSize: 13 }}>
        Frame gaps of 250 ms or more, long tasks, visibility and lifecycle events recorded by every orgtree
        tab in this browser profile, merged by time, newest first ({entries.length} entries; each tab keeps
        its last 200, the 10 most recent tabs are kept, older than 7 days is dropped). Times are local;
        the sampler's CSV is UTC.
      </p>
      <p style={{ margin: '0 0 12px' }}>
        <button type="button" onClick={() => setEntries(readFreezeLog())}>Refresh</button>{' '}
        <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy JSON'}</button>{' '}
        <button type="button" onClick={() => { clearFreezeLog(); setEntries([]) }}>Clear</button>
      </p>
      {newestFirst.length === 0
        ? <p data-testid="freeze-empty">Nothing recorded.</p>
        : (
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['when', 'kind', 'ms', 'detail', 'visibility', 'tab', 'heap MB'].map((h) =>
                <th key={h} style={{ ...cell, textAlign: 'left' }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {newestFirst.map((e, i) => (
                <tr key={`${e.at}-${i}`} data-kind={e.kind}>
                  <td style={cell}>{fmt(e.at)}</td>
                  <td style={cell}>{e.kind}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{e.ms ?? ''}</td>
                  <td style={{ ...cell, whiteSpace: 'normal' }}>{e.detail}</td>
                  <td style={cell}>{e.vis}</td>
                  <td style={cell}>{e.tab}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{e.heap_mb ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </main>
  )
}
