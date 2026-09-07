import { ImportRecovery } from './importrecovery'
import { useState } from 'react'
import { req } from '../api'
import { pickFolder } from '../picker'

interface ImportOrg { slug: string; name: string; warnings?: string[]; active_nodes?: string[]; conflict?: string | null; recovery_pending?: boolean }
interface Preview { organizations: ImportOrg[]; warnings: string[] }
interface Imported { imported: ImportOrg[]; warnings: string[]; failed?: { slug: string; error: string; not_attempted?: string[] }[] }

export function ImportSettings({ active = true }: { active?: boolean }) {
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Imported | null>(null)
  const changeSource = (value: string) => { setSource(value); setPreview(null); setSelected([]); setAck(false); setResult(null); setError('') }
  const post = <T,>(path: string, body: unknown) => req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 600_000)
  return <section className="import-settings">
    <h3>Import from Orgtree v1</h3>
    <p>Copy selected organizations into this installation. The original installation keeps its data and can continue running.</p>
    <label>V1 data folder<div className="row"><input aria-label="V1 data folder" disabled={busy} value={source}
      onChange={e => changeSource(e.target.value)} style={{ flex: 1 }} />
      <button disabled={busy} onClick={() => { void pickFolder().then(r => { if (r.path) changeSource(r.path) }) }}>Browse…</button></div></label>
    <button disabled={busy || !source.trim()} onClick={async () => {
      setBusy(true); setError(''); setPreview(null); setResult(null); setAck(false)
      try {
        const value = await post<Preview>('/api/desktop/import-v1/preview', { source_root: source.trim() })
        setPreview(value); setSelected(value.organizations.filter(o => !o.conflict).map(o => o.slug))
      } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>{busy ? 'Working…' : 'Preview organizations'}</button>
    {error && <p role="alert" className="ask-warn">{error}</p>}
    {preview && <>
      {preview.warnings?.map((w, i) => <p className="ask-warn" key={i}>{w}</p>)}
      {!preview.organizations.length && <p>No organizations found in this folder.</p>}
      {preview.organizations.map(org => <div key={org.slug}>
        <label className="checkline"><input type="checkbox" disabled={busy || !!org.conflict} checked={selected.includes(org.slug)}
          onChange={e => setSelected(old => e.target.checked ? [...old, org.slug] : old.filter(s => s !== org.slug))} />
          {org.name} <span className="dim">{org.slug}</span></label>
        {org.warnings?.map((w, i) => <p className="ask-warn" key={i}>{w}</p>)}
        {org.conflict && <p className="ask-warn">{org.conflict}</p>}
      </div>)}
      {!!preview.organizations.length && <>
        <p className="ask-warn">Imported active work resumes here. If the original installation is still running, both copies can perform the same work and use provider capacity.</p>
        <label className="checkline"><input type="checkbox" aria-label="Acknowledge duplicate work" disabled={busy} checked={ack} onChange={e => setAck(e.target.checked)} />
          I understand that both copies can run the same work.</label>
        <button disabled={busy || !ack || !selected.length} onClick={async () => {
          setBusy(true); setError('')
          try {
            const value = await post<Imported>('/api/desktop/import-v1', { source_root: source.trim(), organizations: selected, acknowledge_duplicate_work: true })
            setResult(value); setPreview(null); setAck(false)
            window.dispatchEvent(new Event('orgtree:organizations-imported'))
          } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
        }}>Copy selected organizations</button>
      </>}
    </>}
    {result && <div role="status"><p>{result.imported.length ? `Imported ${result.imported.map(o => o.name || o.slug).join(', ')}.` : 'No organizations imported.'}</p>
      {[...new Set([...result.warnings ?? [], ...result.imported.flatMap(o => o.warnings ?? [])])].map((w, i) => <p className="ask-warn" key={i}>{w}</p>)}
      {result.imported.filter(o => o.recovery_pending).map(o => <p className="ask-warn" key={o.slug}>{o.name || o.slug} was copied; resuming its active work is still pending.</p>)}
      {result.failed?.map(f => <div className="ask-warn" key={f.slug}><p>{f.slug}: {f.error}</p>
        {!!f.not_attempted?.length && <p>Not copied: {f.not_attempted.join(', ')}.</p>}</div>)}
    </div>}
    <ImportRecovery active={active} />
  </section>
}
