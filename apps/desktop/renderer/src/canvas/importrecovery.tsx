import { useEffect, useRef, useState } from 'react'
import { listOrgs, req } from '../api'

export interface RecoveryNode {
  node: string; attempt: string; phase: string
  identity: { generation: number; session_id: string }
  intent: { text: string; view?: unknown }
  result?: unknown
}
export interface RecoveryState { pending: boolean; phase: string; nodes: RecoveryNode[] }
type RecoveryOrg = { slug: string; name: string; state?: RecoveryState; error?: string }
interface Resolution { pending: boolean; results: { node: string; attempt: string; phase: string; error?: string }[] }
type Action = 'retry' | 'mark-handled' | 'continue'
const path = (slug: string) => `/api/desktop/import-v1/${encodeURIComponent(slug)}`
const proven = (phase: string) => phase === 'held' || phase === 'not-dispatched'
const actionable = (phase: string) => proven(phase) || phase === 'uncertain'
const printable = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? ''

export function ImportRecovery({ active = true }: { active?: boolean }) {
  const [orgs, setOrgs] = useState<RecoveryOrg[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [working, setWorking] = useState('')
  const [outcome, setOutcome] = useState('')
  const [outcomeError, setOutcomeError] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    const refresh = () => setRevision(v => v + 1)
    window.addEventListener('orgtree:organizations-imported', refresh)
    return () => window.removeEventListener('orgtree:organizations-imported', refresh)
  }, [])
  useEffect(() => {
    if (!active) return
    let alive = true
    setLoading(true); setError('')
    void listOrgs().then(async entries => {
      const found: RecoveryOrg[] = entries.map(o => ({ slug: o.slug, name: o.name }))
      let next = 0
      const worker = async () => {
        while (alive && next < found.length) {
          const index = next++, org = found[index]!
          try { org.state = await req<RecoveryState>(`${path(org.slug)}/recovery`) }
          catch (e) { org.error = (e as Error).message }
        }
      }
      await Promise.all([worker(), worker()])
      if (alive) { setOrgs(found); setUncertain(false) }
    }).catch(e => { if (alive) setError((e as Error).message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [revision, active])
  const resolve = async (org: RecoveryOrg, row: RecoveryNode, action: Action, note: string, ack: boolean) => {
    if (working || loading || uncertain || !actionable(row.phase)) return
    if (action === 'retry' && !proven(row.phase)) return
    if (action === 'continue' && row.phase !== 'uncertain') return
    setWorking(`${org.slug}:${row.node}`); setOutcome(''); setOutcomeError(false)
    try {
      const result = await req<Resolution>(`${path(org.slug)}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes: [{ node: row.node, attempt: row.attempt, expected_phase: row.phase }],
          action, acknowledge_duplicate_work: ack, note: note.trim() }),
      })
      if (!mounted.current) return
      setOutcomeError(result.results.some(r => !!r.error))
      setOutcome(result.results.map(r => `${r.node}: ${r.phase}${r.error ? ` - ${r.error}` : ''}`).join('\n')); setRevision(v => v + 1)
    } catch (e) {
      if (!mounted.current) return
      setUncertain(true); setOutcomeError(true)
      setOutcome(`The resolution outcome is not confirmed: ${(e as Error).message}. Refresh recovery before deciding what to do next. The request was not repeated.`)
    } finally { if (mounted.current) setWorking('') }
  }
  const visible = orgs.filter(org => org.error || org.state?.pending || org.state?.nodes.length)
  return <section className="import-recovery">
    <h3>Imported work recovery</h3>
    <p>Review work whose resumption was held or whose outcome is uncertain. No action here runs automatically.</p>
    <button disabled={loading || !!working} onClick={() => { setOutcome(''); setRevision(v => v + 1) }}>Refresh recovery</button>
    {loading && <p role="status">Checking imported work...</p>}
    {error && <p className="ask-warn" role="alert">Could not check recovery: {error}</p>}
    {outcome && <pre className={outcomeError ? 'ask-warn' : 'dim'} role={outcomeError ? 'alert' : 'status'}
      style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{outcome}</pre>}
    {!loading && !error && !visible.length && <p>No imported work needs review.</p>}
    {visible.map(org => <div key={org.slug} className="set-group">
      <h4>{org.name || org.slug}</h4>
      {org.error && <p role="alert" className="ask-warn">Could not check {org.slug}: {org.error}</p>}
      {org.state && <>
        <p className="dim">Recovery status: {org.state.phase}{org.state.pending ? ' (review needed)' : ''}</p>
        {org.state.nodes.map(row => <RecoveryRow key={`${row.node}:${row.attempt}:${row.phase}`} row={row}
          disabled={loading || !!working || uncertain || !!error}
          onResolve={(action, note, ack) => { void resolve(org, row, action, note, ack) }} />)}
      </>}
    </div>)}
  </section>
}

function RecoveryRow({ row, disabled, onResolve }: {
  row: RecoveryNode; disabled: boolean
  onResolve: (action: Action, note: string, acknowledge: boolean) => void
}) {
  const [action, setAction] = useState<Action | null>(null)
  const [note, setNote] = useState(''), [ack, setAck] = useState(false)
  const choose = (next: Action | null) => { setAction(next); setNote(''); setAck(false) }
  return <div className="set-group recovery-node" data-agent={row.node}>
    <p><b>{row.node}</b> - {row.phase}</p>
    {row.phase === 'uncertain' && <p className="ask-warn">This attempt may already have performed work. Its result cannot be established, including after a restart.</p>}
    {row.phase === 'admitting' && <p className="ask-warn">Admission is in progress or has not been resolved. Refresh to check its state before taking action.</p>}
    {row.phase === 'admitted' && <p className="dim">Accepted by the running process; this does not establish that the work completed.</p>}
    <details><summary>Original intent and attempt</summary>
      <p className="dim">Attempt: {row.attempt}<br />Generation: {row.identity.generation}<br />Session: {row.identity.session_id}</p>
      <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{row.intent.text}</pre>
      {row.intent.view != null && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{printable(row.intent.view)}</pre>}
      {row.result != null && <><p>Recorded result</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{printable(row.result)}</pre></>}
    </details>
    {actionable(row.phase) && <div className="row">
      {proven(row.phase) && <button disabled={disabled} onClick={() => choose('retry')}>Retry</button>}
      {row.phase === 'uncertain' && <button disabled={disabled} onClick={() => choose('continue')}>Continue after review</button>}
      <button disabled={disabled} onClick={() => choose('mark-handled')}>Mark handled</button>
    </div>}
    {action && <div className="set-group">
      <p>{action === 'mark-handled' ? 'Mark this attempt handled without dispatching any work.'
        : action === 'retry' ? 'Retry this attempt only if the engine still proves it was not admitted and the agent is idle.'
          : 'Authorize a new continuation after reviewing the uncertain attempt. This can repeat effects of work that already ran.'}</p>
      <label style={{ display: 'block' }}>Review note<textarea style={{ display: 'block', width: '100%', marginTop: 6 }} aria-label={`Recovery note for ${row.node}`} rows={3} disabled={disabled}
        value={note} onChange={e => setNote(e.target.value)} /></label>
      <label className="checkline"><input type="checkbox" disabled={disabled} checked={ack}
        aria-label={`Acknowledge recovery review for ${row.node}`} onChange={e => setAck(e.target.checked)} />
        I have reviewed this attempt and understand that retrying or continuing can repeat effects.</label>
      <div className="row"><button className="primary" disabled={disabled || !note.trim() || !ack}
        onClick={() => { onResolve(action, note, ack); choose(null) }}>Confirm {action === 'mark-handled' ? 'mark handled' : action === 'retry' ? 'retry' : 'continuation'}</button>
        <button disabled={disabled} onClick={() => choose(null)}>Cancel review</button></div>
    </div>}
  </div>
}
