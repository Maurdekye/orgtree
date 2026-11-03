import { useCallback, useEffect, useRef, useState } from 'react'
import { getAgentStates, type AgentStateSpan, type AgentStateTotals, type AgentStateWord, type AgentStatesPage } from '../api'
import { onLiveBump } from '../livebus'
import { useOrgRecordCursor } from '../recordsession'
import { fmtAge, fmtFull } from '../timefmt'

const WORDS: AgentStateWord[] = ['active', 'idle', 'blocked', 'halted', 'frozen']
const LABEL: Record<AgentStateWord, string> = {
  active: 'Active', idle: 'Idle', blocked: 'Blocked', halted: 'Halted', frozen: 'Frozen',
}

/** A span in the desk's age words (`45s`, `12m`, `2h`): the same buckets as every other age. */
const fmtSpan = (secs: number): string => fmtAge(0, Math.max(0, secs) * 1000)

function TotalsLine({ label, totals }: { label: string; totals: AgentStateTotals }) {
  const parts = WORDS.filter(w => totals[w] > 0)
  return <span className="agent-states-window"><b>{label}</b>{' '}
    {parts.length ? parts.map((w, i) => <span key={w} data-state={w}>{i ? ' · ' : ''}{LABEL[w]} {fmtSpan(totals[w])}</span>)
      : <span className="dim">nothing recorded</span>}</span>
}

/** The agent's state history in node settings: time per state over the last
 *  24 hours and 7 days, then each span newest first in pages by cursor. The
 *  rows are the engine's own recorded state changes (the desk transcript's
 *  state rows read as spans); nothing here is recorded or computed again. */
export function AgentStatesView({ slug, nid }: { slug: string; nid: string }) {
  const cursor = useOrgRecordCursor(slug)
  const [first, setFirst] = useState<AgentStatesPage | null>(null)
  const [older, setOlder] = useState<AgentStateSpan[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identity = useRef(0)
  const nextRef = useRef<string | null>(null)
  nextRef.current = next
  /** newest page again; older pages read so far stay below it */
  const loadFirst = useCallback(async () => {
    const request = identity.current
    setBusy(true); setError('')
    try {
      const page = await getAgentStates(slug, nid)
      if (request !== identity.current) return
      setFirst(page)
      // an older cursor already walked past this page's tail keeps its place
      setNext(prev => prev && older.length ? prev : page.next_cursor)
    } catch (e) {
      if (request === identity.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === identity.current) setBusy(false)
    }
  }, [slug, nid, older.length])
  const loadOlder = useCallback(async () => {
    const before = nextRef.current
    if (!before) return
    const request = identity.current
    setBusy(true); setError('')
    try {
      const page = await getAgentStates(slug, nid, before)
      if (request !== identity.current) return
      setOlder(prev => [...prev, ...page.states])
      setNext(page.next_cursor)
    } catch (e) {
      if (request === identity.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === identity.current) setBusy(false)
    }
  }, [slug, nid])
  useEffect(() => {
    ++identity.current
    setFirst(null); setOlder([]); setNext(null)
    void loadFirst()
    const off = onLiveBump(() => { void loadFirst() })
    return () => { ++identity.current; off() }
  }, [slug, nid])  // eslint-disable-line react-hooks/exhaustive-deps
  const seen = useRef(cursor)
  useEffect(() => {
    if (cursor && seen.current && seen.current !== cursor) void loadFirst()
    seen.current = cursor
  }, [cursor])  // eslint-disable-line react-hooks/exhaustive-deps
  const spans = [...(first?.states ?? []), ...older]
  return <section className="agent-states" aria-label={`${nid}'s state history`}>
    <div className="agent-states-head"><span className="dim">State history</span>
      <button disabled={busy} onClick={() => { setOlder([]); void loadFirst() }}>Refresh</button></div>
    {first?.totals && <div className="agent-states-totals">
      <TotalsLine label="Last 24 hours" totals={first.totals.h24} />
      <TotalsLine label="Last 7 days" totals={first.totals.d7} />
    </div>}
    {error && <p role="alert">Could not load state history: {error}</p>}
    {busy && !first && <p role="status" className="dim">Loading state history…</p>}
    {first && spans.length === 0 && <p className="dim">No state changes recorded yet.</p>}
    <ol className="agent-states-list">{spans.map(s => <li key={s.start} data-state={s.state}>
      <span className="agent-states-name"><i className={`state-dot ${s.state}`} aria-hidden="true" />{LABEL[s.state]}</span>
      <span className="agent-states-when dim">
        <time dateTime={s.start} title={s.start}>{fmtFull(s.start)}</time>
        {' → '}
        {s.end ? <time dateTime={s.end} title={s.end}>{fmtFull(s.end)}</time> : <b>now</b>}
      </span>
      <span className="agent-states-dur">{fmtSpan(s.secs)}</span>
    </li>)}</ol>
    {next && <button className="agent-states-more" disabled={busy} onClick={() => void loadOlder()}>Load older</button>}
  </section>
}
