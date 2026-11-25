import { useEffect, useMemo, useRef, useState } from 'react'
import { changeMailTransfer, getMailTransfers, isRequestCancelled } from '../api'
import type { MailTransfer, TransferFile } from '../api'
import { fmtBytes } from './img'
import { useLoadWhenSeen } from './loadmore'

const terminal = new Set(['complete', 'removed'])
const canCancel = new Set(['queued', 'preparing', 'uploading', 'downloading', 'confirming', 'retry_wait', 'failed', 'paused'])
const canRetry = new Set(['retry_wait', 'failed', 'cancelled', 'paused'])
const labels: Record<string, string> = {
  queued: 'Queued', preparing: 'Preparing', uploading: 'Uploading', downloading: 'Downloading',
  confirming: 'Confirming', delivering: 'Delivering', retry_wait: 'Waiting to retry', paused: 'Paused',
  failed: 'Failed', cancelled: 'Cancelled', complete: 'Complete', removed: 'Removed from message',
}

/** A TRANSFER ON ITS MESSAGE (Hubchat's attachment progress, USER 2026-11-25 m1454b39b8fd0): what
 *  one file of a message shows while its transfer is unfinished, from the same transfer list the
 *  mailbox's transfers tab reads. Null once it is complete or removed. */
export interface FileTransferView { state: string; label: string; confirmed: number; total: number | null; pct: number | null }
export function fileTransferView(t: MailTransfer | undefined, name: string): FileTransferView | null {
  if (!t || terminal.has(t.state)) return null
  const f = (t.files ?? []).find(x => x.name === name) ?? (t.files?.length ? null : { name: t.name ?? '', total: t.total ?? null,
    confirmed: t.confirmed ?? 0 } as Pick<TransferFile, 'name' | 'total' | 'confirmed'>)
  if (!f || f.complete) return null
  const total = f.total && f.total > 0 ? f.total : null
  const confirmed = Math.max(0, f.confirmed)
  const pct = total ? Math.min(100, Math.round(confirmed / total * 100)) : null
  const word = labels[t.state] ?? t.state
  return { state: t.state, label: pct == null ? word : `${word} · ${pct}%`, confirmed, total, pct }
}

/** The mailbox's transfers by the message they carry, polled while any is unfinished (and once
 *  on opening): the first page, as the transfers tab's live poll reads it. */
export function useMessageTransfers(slug: string, agent?: string): ReadonlyMap<string, MailTransfer> {
  const [rows, setRows] = useState<MailTransfer[]>([])
  useEffect(() => {
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = new AbortController()
    const read = async () => {
      let again = false
      try {
        const data = await getMailTransfers(slug, agent, stop.signal)
        const list = Array.isArray(data.transfers) ? data.transfers : []
        if (dead) return
        setRows(list)
        again = list.some(t => !terminal.has(t.state))
      } catch { again = false }
      if (!dead) timer = setTimeout(() => void read(), again ? 1000 : 10000)
    }
    void read()
    return () => { dead = true; stop.abort(); if (timer) clearTimeout(timer) }
  }, [slug, agent])
  return useMemo(() => {
    const map = new Map<string, MailTransfer>()
    for (const t of rows) if (t.message_id && !map.has(t.message_id)) map.set(t.message_id, t)
    return map
  }, [rows])
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

/** Mounted only with its mail surface. Closing it never cancels engine jobs.
 *
 *  HISTORY GROWS AS YOU NEAR ITS END (UX symmetry audit #15, ux05 S7): the
 *  live poll keeps refreshing the FIRST page (unfinished first, then newest
 *  history); later pages are read once each and APPENDED when the end of the
 *  list comes into view, as Orgtree's other long lists and Hubchat's Settings
 *  transfer history (3f7f273) do. "Load more" stays as the manual path, and a
 *  failed page shows its error with a Retry that repeats THAT page; nothing
 *  loads by itself while the error stands. Each page stays bounded (100). */
export interface TransferSummary { total: number; active: number }

/** TAB MODE (USER 2026-11-25 09:31:19Z m7202711b8122 "make transfers in every
 *  mailbox it appears in a separate tab"): with `tab` set, the panel is the
 *  body of a mailbox's own "transfers" tab. It stays mounted while another tab
 *  shows (so it keeps polling, its history and the host's tab badge), lists
 *  at once while `tab.visible`, and drops the "▸ Transfers" disclosure; the
 *  "recent history" toggle, progress and actions are unchanged. `onSummary`
 *  tells the host whether to offer the tab and how many are unfinished. */
export function TransferPanel({ slug, agent, tab, onSummary }: {slug: string; agent?: string;
  tab?: {visible: boolean}; onSummary?: (s: TransferSummary) => void}) {
  const [rows, setRows] = useState<MailTransfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [history, setHistory] = useState(false)
  const [disclosed, setExpanded] = useState(false)
  const expanded = tab ? tab.visible : disclosed
  // the first page's own continuation, then (once a later page is read) the
  // last read page's; `older` keeps every row seen beyond the live first page
  const [firstNext, setFirstNext] = useState<string | null>(null)
  const [older, setOlder] = useState<MailTransfer[]>([])
  const [olderNext, setOlderNext] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  // the cursor whose read failed: Retry repeats exactly that one
  const [failedAfter, setFailedAfter] = useState<string | null>(null)
  const epoch = useRef(0)
  const pending = useRef(false)
  const pageStop = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const next = olderNext === undefined ? firstNext : olderNext
  useEffect(() => {
    epoch.current++; pending.current = false
    setFirstNext(null); setRows([]); setExpanded(false)
    setOlder([]); setOlderNext(undefined); setLoading(false); setPageError(null); setFailedAfter(null)
    return () => { pageStop.current?.abort(); pageStop.current = null }
  }, [slug, agent])
  useEffect(() => {
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      let active = false
      try {
        const data = await getMailTransfers(slug, agent, AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]))
        if (stop.signal.aborted) return
        // a reply without a list (an older engine, a stub) is no transfers, never a crash
        const list = Array.isArray(data.transfers) ? data.transfers : []
        setRows(list)
        setFirstNext(data.next_cursor ?? null)
        setError(null)
        active = list.some(t => !terminal.has(t.state))
      } catch (err) {
        if (stop.signal.aborted || isRequestCancelled(err)) return
        setError(err instanceof Error ? err.message : 'Could not load transfers')
      }
      if (!stop.signal.aborted) timer = setTimeout(poll, active ? 1000 : 5000)
    }
    void poll()
    return () => { stop.abort(); clearTimeout(timer) }
  }, [slug, agent, reload])
  const more = async (cursor = next) => {
    if (!cursor || pending.current) return
    const mine = epoch.current, shown = rows
    const stop = new AbortController()
    pageStop.current = stop
    pending.current = true; setLoading(true); setPageError(null); setFailedAfter(null)
    try {
      const data = await getMailTransfers(slug, agent, AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]), cursor)
      if (epoch.current !== mine) return
      if (data.next_cursor === cursor) throw new Error('Transfer history page did not advance')
      // the first page as shown when this page was asked for joins the kept
      // rows, so a row the live first page later pushes out stays in view
      setOlder(old => [...new Map([...shown, ...old, ...data.transfers].map(t => [t.id, t])).values()])
      setOlderNext(data.next_cursor)
    } catch (err) {
      if (epoch.current !== mine || stop.signal.aborted || isRequestCancelled(err)) return
      setPageError(err instanceof Error ? err.message : 'Could not load more transfers')
      setFailedAfter(cursor)
    } finally {
      if (epoch.current === mine) { pending.current = false; setLoading(false) }
    }
  }
  // the end of the visible history coming into view loads the next page; a new
  // cursor re-arms it, so a short page that leaves the end in view loads on
  useLoadWhenSeen(end, expanded && history && !loading && !pageError ? next : null, () => void more())
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
  const active = rows.filter(t => !terminal.has(t.state))
  // the live first page wins for any row it still carries
  const live = new Set(rows.map(t => t.id))
  const all = [...rows, ...older.filter(t => !live.has(t.id))]
  const summary = useRef(onSummary); summary.current = onSummary
  useEffect(() => { summary.current?.({ total: all.length, active: active.length }) }, [all.length, active.length])
  if (!rows.length && !error && !older.length)
    return tab?.visible ? <section className="mail-transfers tab" aria-label="Attachment transfers">
      <div className="dim">no transfers</div></section> : null
  const shown = history ? all : active.length ? active : rows.slice(0, 3)
  return <section className={'mail-transfers' + (tab ? ' tab' : '')} aria-label="Attachment transfers">
    <div className="transfer-heading">
      {tab ? <span className="dim">{active.length ? `${active.length} unfinished` : ''}</span>
        : <button className="linkish" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        {expanded ? '▾' : '▸'} Transfers{active.length ? ` · ${active.length} unfinished` : ''}
      </button>}
      <label><input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} /> recent history</label>
    </div>
    {error && <div role="alert" className="err">{error} <button onClick={() => setReload(n => n + 1)}>Retry</button></div>}
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
    })}
      {/* THE END MARKER sits inside the list's own scroller (max-height), so
          it comes into view only as you scroll near the end of the history */}
      {history && next && <div ref={end} className="transfer-history-end" aria-hidden="true" />}
    </div>}
    {/* Load more also opens the history, as the page button it replaces did;
        automatic loading happens only while the history shows */}
    {expanded && (history || next) && <div className="transfer-actions transfer-more">
      {pageError && <div role="status" className="err">{pageError} <button onClick={() => { if (failedAfter) void more(failedAfter) }}>Retry</button></div>}
      {loading && <small role="status" className="dim">Loading…</small>}
      {next && <button disabled={loading} onClick={() => { setHistory(true); void more() }}>Load more</button>}
      {history && <small className="dim">{all.length} transfers. Unfinished first, then newest history.</small>}
    </div>}
  </section>
}
