import { ImportRecovery } from './importrecovery'
import { useEffect, useRef, useState } from 'react'
import { req } from '../api'
import { pickFolder } from '../picker'
import { useImportJob, type Preview, type Imported } from './importjob'

export function ImportSettings({ active = true }: { active?: boolean }) {
  const [source, setSource] = useState('')
  const [claudeProfile, setClaudeProfile] = useState('')
  const [codexProfile, setCodexProfile] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [ack, setAck] = useState(false)
  const [previewBusy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'Preview' | 'Import'>('Preview')
  const [result, setResult] = useState<Imported | null>(null)
  const progress = useImportJob(active)
  const busy = previewBusy || progress.locked || progress.retryOriginal
  const completed = useRef('')
  const progressFeedback = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const job = progress.job
    if (!job || progress.running || completed.current === `${job.id}:${job.state}`) return
    completed.current = `${job.id}:${job.state}`
    setAction('Import'); setPreview(null); setAck(false); setResult(job.result)
    setError(['failed', 'interrupted', 'cancelled'].includes(job.state) ? job.error || `Import ${job.state}.` : '')
    window.dispatchEvent(new Event('orgtree:organizations-imported'))
  }, [progress.job, progress.running])
  useEffect(() => {
    if (!active || (!progress.starting && !progress.issue)) return
    progressFeedback.current?.focus({ preventScroll: true })
    progressFeedback.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active, progress.starting, progress.issue])
  const errorFeedback = useRef<HTMLDivElement>(null)
  const resultFeedback = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!error && !result) return
    const feedback = error ? errorFeedback.current : resultFeedback.current
    feedback?.focus({ preventScroll: true })
    feedback?.scrollIntoView?.({ block: 'nearest' })
  }, [error, result])
  const invalidatePreview = () => { setPreview(null); setSelected([]); setAck(false); setResult(null); setError('') }
  const changeSource = (value: string) => { setSource(value); invalidatePreview() }
  const nativeSources = { ...(claudeProfile.trim() ? { claude_profile: claudeProfile.trim() } : {}),
    ...(codexProfile.trim() ? { codex_profile: codexProfile.trim() } : {}) }
  const sourceOptions = Object.keys(nativeSources).length ? { native_sources: nativeSources } : {}
  const stopping = progress.cancelPending || progress.job?.cancel_requested || progress.job?.state === 'cancelling'
  const measured = progress.running && !stopping && !progress.issue && progress.job?.phase !== 'counting' && progress.job?.progress_percent != null
  const eta = measured ? progress.job?.eta_seconds : null
  const etaText = eta == null ? null : eta < 60 ? 'less than a minute' : eta < 3600
    ? `about ${Math.ceil(eta / 60)} ${Math.ceil(eta / 60) === 1 ? 'minute' : 'minutes'}`
    : `about ${Math.ceil(eta / 3600)} ${Math.ceil(eta / 3600) === 1 ? 'hour' : 'hours'}`
  const post = <T,>(path: string, body: unknown) => req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 600_000)
  return <section className="import-settings">
    <h3>Import from Orgtree v1</h3>
    <p>Copy selected organizations into this installation. The original installation keeps its data and can continue running.</p>
    {(!progress.checked || progress.id || progress.issue) && <div ref={progressFeedback} tabIndex={-1}>
      <h4>{progress.starting ? 'Starting import' : progress.running ? progress.cancelPending ? 'Requesting cancellation' : stopping ? 'Cancellation requested' : 'Import in progress' : progress.job ? `Import ${progress.job.state}` : 'Checking import status'}</h4>
      {(progress.starting || progress.running) && <progress aria-label="Import progress" {...(measured ? { value: progress.job!.progress_percent!, max: 100 } : {})} />}
      {progress.job && <>
        <p>{({ queued: 'Queued', counting: 'Counting files and measuring total size', reading: 'Reading organization data', copying: 'Copying files', native: 'Copying native conversations', validating: 'Validating the copy', publishing: 'Publishing organizations', recovering: 'Restoring imported work', finished: 'Finished' } as Record<string, string>)[progress.job.phase] || progress.job.phase}
          {progress.job.current_org && ` — ${progress.job.current_org}`}</p>
        <p>{progress.job.files_copied.toLocaleString()} files copied; {progress.job.bytes_copied.toLocaleString()} bytes copied and verified.</p>
        {measured && <p>{(Math.floor(progress.job.progress_percent! * 10) / 10).toFixed(1)}% copy progress. {etaText != null ? `Estimated copy time remaining: ${etaText}.` : 'Estimating remaining copy time…'} Native processing, validation and publication must finish before the import is complete.</p>}
        {progress.running && <p className="dim">{stopping ? 'Waiting for the worker to stop at a safe checkpoint. Keep Orgtree running until the stop is confirmed.' : `${progress.job.total_files == null ? 'Total size is not known yet. ' : ''}You can close this panel and check progress later; keep Orgtree running.`}</p>}
        {['interrupted', 'cancelled'].includes(progress.job.state) && !!progress.job.publications?.length && <details>
          <summary>Review publication and recovery receipts ({progress.job.publications.length})</summary>
          <ul>{progress.job.publications.map(row => <li key={row.slug}>
            <b>{row.slug}</b>: {row.state === 'published' ? 'Copy publication confirmed.' : 'Copy publication outcome is not confirmed.'}{' '}
            {row.recovery === 'not_started' ? 'Recovery has not started.' : row.recovery === 'dispatching' ? 'Recovery outcome is not confirmed.' : 'Recovery callback returned; this does not confirm that agent work finished.'}
          </li>)}</ul>
        </details>}
      </>}
      {progress.issue && <p role="alert" className="ask-warn">{progress.issue}</p>}
      {progress.cancelIssue && <p role="alert" className="ask-warn">{progress.cancelIssue}</p>}
      {progress.missing && progress.startError && <p className="ask-warn">Start response: {progress.startError}</p>}
      {progress.missing && <p>Review the source and selected organizations below, then explicitly retry the start with the saved request ID. No new copy will be started automatically.</p>}
      {progress.id && <p className="dim">Request ID: <span className="mono">{progress.id}</span></p>}
      <button disabled={progress.starting} onClick={() => { void progress.refresh() }}>Check import status</button>
      {progress.running && typeof progress.job?.cancellable === 'boolean' && <button disabled={progress.cancelPending || !!progress.job.cancel_requested || !progress.job.cancellable} onClick={() => { void progress.cancel() }}>Cancel Import</button>}
      {progress.running && !stopping && progress.job?.cancellable === false && <p className="dim">Cancellation is unavailable while publication or recovery is being finalized.</p>}
    </div>}
    <label>V1 data folder<div className="row"><input aria-label="V1 data folder" disabled={busy} value={source}
      onChange={e => changeSource(e.target.value)} style={{ flex: 1 }} />
      <button disabled={busy} onClick={() => { void pickFolder().then(r => { if (r.path) changeSource(r.path) }) }}>Browse…</button></div></label>
    <details>
      <summary>Native session sources (optional)</summary>
      <p>Locate existing Claude and Codex session files in read-only source profiles. Agents with missing native context stay held for review.</p>
      <label>Source Claude profile<input aria-label="Source Claude profile" disabled={busy} value={claudeProfile}
        onChange={e => { setClaudeProfile(e.target.value); invalidatePreview() }} /></label>
      <label>Source Codex profile<input aria-label="Source Codex profile" disabled={busy} value={codexProfile}
        onChange={e => { setCodexProfile(e.target.value); invalidatePreview() }} /></label>
    </details>
    <button disabled={busy || !source.trim()} onClick={async () => {
      setAction('Preview'); setBusy(true); setError(''); setPreview(null); setResult(null); setAck(false)
      try {
        const value = await post<Preview>('/api/desktop/import-v1/preview', { source_root: source.trim(), ...sourceOptions })
        setPreview(value); setSelected(value.organizations.filter(o => !o.conflict).map(o => o.slug))
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>{busy ? 'Working…' : 'Preview organizations'}</button>
    {preview && <>
      {preview.warnings?.map((w, i) => <p className="ask-warn" key={i}>{w}</p>)}
      {!preview.organizations.length && <p>No organizations found in this folder.</p>}
      {preview.organizations.map(org => <div key={org.slug}>
        <label className="checkline"><input type="checkbox" disabled={busy || !!org.conflict} checked={selected.includes(org.slug)}
          onChange={e => setSelected(old => e.target.checked ? [...old, org.slug] : old.filter(s => s !== org.slug))} />
          {org.name} <span className="dim">{org.slug}</span></label>
        {org.nodes != null && <p className="dim">{org.nodes} {org.nodes === 1 ? 'agent' : 'agents'}</p>}
        {!!org.memory?.length && <details>
          <summary className={org.memory.some(row => row.status === 'held') ? 'ask-warn' : 'dim'}>Claude memory ({org.memory.length} {org.memory.length === 1 ? 'group' : 'groups'}; {org.memory.filter(row => row.status === 'held').length} held)</summary>
          {org.memory.map(row => <p key={row.base}><b>{row.base}</b>: {row.status === 'held' ? 'memory held' : row.status === 'ready' ? 'memory available' : 'no source memory'}{row.reason && ` — ${row.reason}`}</p>)}
        </details>}
        {org.warnings?.map((w, i) => <p className="ask-warn" key={i}>{w}</p>)}
        {!!org.native_context?.length && <details>
          <summary>Agent details ({org.native_context.length}{org.native_context.some(c => c.status === 'held') && `; ${org.native_context.filter(c => c.status === 'held').length} held`})</summary>
          {org.native_context.map(context => <div key={`${context.provider}:${context.node}`} className={context.status === 'held' ? 'ask-warn' : 'dim'}>
          <b>{context.node}</b> ({context.provider}): {context.status === 'held' ? 'held - native context unavailable' : 'native context available'}
          {context.reason && <p>{context.reason}</p>}
          {context.source_path && <p className="mono">{context.source_path}</p>}
        </div>)}
        </details>}
        {org.conflict && <p className="ask-warn">{org.conflict}</p>}
      </div>)}
      {!!preview.organizations.length && <>
        <p className="ask-warn">Imported active work with available context can resume here; unavailable context stays held for review. If the original installation is still running, both copies can perform the same work and use provider capacity.</p>
        <label className="checkline"><input type="checkbox" aria-label="Acknowledge duplicate work" disabled={busy} checked={ack} onChange={e => setAck(e.target.checked)} />
          I understand that both copies can run the same work.</label>
        <button disabled={previewBusy || progress.locked || !ack || !selected.length} onClick={async () => {
          setAction('Import'); setError(''); setResult(null)
          await progress.begin({ source_root: source.trim(), organizations: selected, acknowledge_duplicate_work: true, ...sourceOptions }, progress.missing)
        }}>{progress.missing ? 'Retry start with same request ID' : 'Copy selected organizations'}</button>
      </>}
    </>}
    {error && <div ref={errorFeedback} tabIndex={-1} role="alert" className="ask-warn">
      <p><b>{action === 'Import' && progress.job && ['interrupted', 'cancelled'].includes(progress.job.state) ? `Import ${progress.job.state}` : `${action} failed`}</b></p><p>{error}</p>
      {action === 'Import' && <p>Check the organization list before trying again; a lost response can leave completed copies.</p>}
    </div>}
    {result && <div ref={resultFeedback} tabIndex={-1} role="status">
      <p><b>{progress.job && ['interrupted', 'cancelled'].includes(progress.job.state) ? 'Saved import results' : result.failed?.length ? 'Import finished with errors' : result.imported.length ? 'Import complete' : 'Import finished'}</b></p>
      <p>{result.imported.length ? `Imported ${result.imported.map(o => o.name || o.slug).join(', ')}.` : 'No organizations imported.'}</p>
      {[...new Set([...result.warnings ?? [], ...result.imported.flatMap(o => o.warnings ?? [])])].map((w, i) => <p className="ask-warn" key={i}>{w}</p>)}
      {result.imported.filter(o => o.recovery_pending).map(o => <p className="ask-warn" key={o.slug}>{o.name || o.slug} was copied; resuming its active work is still pending.</p>)}
      {result.failed?.map(f => <div className="ask-warn" key={f.slug}><p>{f.slug}: {f.error}</p>
        {!!f.not_attempted?.length && <p>Not copied: {f.not_attempted.join(', ')}.</p>}</div>)}
    </div>}
    <ImportRecovery active={active} />
  </section>
}
