import { useEffect, useState } from 'react'
import { changeMailTransfer, getMailTransfers, isRequestCancelled } from '../api'
import type { MailTransfer, TransferFile } from '../api'
import { fmtBytes } from './img'

const terminal = new Set(['complete', 'removed'])
const canCancel = new Set(['queued', 'preparing', 'uploading', 'downloading', 'confirming', 'retry_wait', 'failed', 'paused'])
const canRetry = new Set(['retry_wait', 'failed', 'cancelled', 'paused'])
const labels: Record<string, string> = {
  queued: 'Queued', preparing: 'Preparing', uploading: 'Uploading', downloading: 'Downloading',
  confirming: 'Confirming', delivering: 'Delivering', retry_wait: 'Waiting to retry', paused: 'Paused',
  failed: 'Failed', cancelled: 'Cancelled', complete: 'Complete', removed: 'Removed from message',
}

function Bytes({ file, done, direction }: {file: TransferFile; done: boolean; direction: 'upload' | 'download'}) {
  const total = file.total
  const confirmed = Math.max(0, file.confirmed)
  return <div className="transfer-file">
    <span className="transfer-filename">{file.name}</span>
    <progress aria-label={`${file.name} confirmed bytes`} max={total && total > 0 ? total : 1}
      value={done ? (total && total > 0 ? total : 1) : total == null ? undefined : Math.min(confirmed, total)} />
    <small>{fmtBytes(confirmed)}{total == null ? ' confirmed · total unknown' : ` of ${fmtBytes(total)} confirmed`}
      {file.processed > confirmed && ` · ${fmtBytes(file.processed)} ${direction === 'upload' ? 'sent' : 'received'}`}</small>
    {file.restart_reason && <small>{file.restart_reason}</small>}
  </div>
}

/** Mounted only with its mail surface. Closing it never cancels engine jobs. */
export function TransferPanel({ slug, agent }: {slug: string; agent?: string}) {
  const [rows, setRows] = useState<MailTransfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [history, setHistory] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [cursors, setCursors] = useState<string[]>([])
  const [next, setNext] = useState<string | null>(null)
  const cursor = cursors.at(-1)
  useEffect(() => { setCursors([]); setNext(null); setRows([]); setExpanded(false) }, [slug, agent])
  useEffect(() => {
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let active = false
      try {
        const data = await getMailTransfers(slug, agent, AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]), cursor)
        if (stop.signal.aborted) return
        setRows(data.transfers)
        setNext(data.next_cursor)
        setError(null)
        active = data.transfers.some(t => !terminal.has(t.state))
      } catch (err) {
        if (stop.signal.aborted || isRequestCancelled(err)) return
        setError(err instanceof Error ? err.message : 'Could not load transfers')
      }
      if (!stop.signal.aborted) timer = setTimeout(poll, active ? 1000 : 5000)
    }
    void poll()
    return () => { stop.abort(); clearTimeout(timer) }
  }, [slug, agent, reload, cursor])
  const change = async (id: string, action: 'retry' | 'cancel' | 'remove') => {
    setBusy(id)
    try {
      const data = await changeMailTransfer(slug, id, action)
      setRows(old => old.map(row => data.transfers.find(t => t.id === row.id) ?? row))
      setError(null)
      setReload(n => n + 1)
    } catch (err) { setError(err instanceof Error ? err.message : 'Transfer action failed') }
    finally { setBusy(null) }
  }
  if (!rows.length && !error && !cursors.length) return null
  const active = rows.filter(t => !terminal.has(t.state))
  const shown = history ? rows : active.length ? active : rows.slice(0, 3)
  return <section className="mail-transfers" aria-label="Attachment transfers">
    <div className="transfer-heading">
      <button className="linkish" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        {expanded ? '▾' : '▸'} Transfers{active.length ? ` · ${active.length} unfinished` : ''}
      </button>
      <label><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} /> recent history</label>
    </div>
    {error && <div role="alert" className="err">{error} <button onClick={() => setReload(n => n + 1)}>Refresh</button></div>}
    {expanded && <div className="transfer-list">{shown.map(t => {
      const files: TransferFile[] = t.files ?? [{id:t.id, name:t.name ?? 'Attachment', total:t.total ?? null,
        confirmed:t.confirmed ?? 0, processed:t.processed ?? 0}]
      return <article className="transfer-card" data-transfer-id={t.id} data-transfer-state={t.state} data-transfer-attempt={t.attempt} key={t.id}>
        <div className="transfer-heading"><strong>{t.direction === 'upload' ? 'To' : 'From'} {t.peer}</strong>
          <span className={t.state === 'failed' ? 'err' : 'dim'}>{labels[t.state] ?? t.state}</span></div>
        {files.map(f => <Bytes key={f.id} file={f} direction={t.direction} done={t.state === 'complete' || !!f.complete} />)}
        {t.error && <small className="transfer-error">{t.error}</small>}
        <div className="transfer-actions">
          {canRetry.has(t.state) && <button disabled={busy !== null} onClick={() => void change(t.id, 'retry')}>Retry</button>}
          {canCancel.has(t.state) && <button disabled={busy !== null} onClick={() => void change(t.id, 'cancel')}>Cancel transfer</button>}
          {t.direction === 'upload' && ['failed','cancelled'].includes(t.state) &&
            <button disabled={busy !== null} title="Send the message when its remaining files are ready" onClick={() => void change(t.id, 'remove')}>Remove file and send</button>}
          {busy === t.id && <small>Saving…</small>}
        </div>
      </article>
    })}</div>}
    {expanded && <div className="transfer-actions">
      {!!cursors.length && <button onClick={() => setCursors(old => old.slice(0, -1))}>Previous transfers</button>}
      {next && <button onClick={() => { setCursors(old => [...old, next]); setHistory(true) }}>More transfers</button>}
      {(history || next || !!cursors.length) && <small className="dim">Page {cursors.length + 1}, {rows.length} transfers. Unfinished first, then newest history.</small>}
    </div>}
  </section>
}
