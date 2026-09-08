import { useCallback, useEffect, useRef, useState } from 'react'

export interface NativeContext { node: string; provider: string; status: 'available' | 'held'; source_path?: string; reason?: string }
export interface ImportOrg { nodes?: number; native_context?: NativeContext[]; slug: string; name: string; warnings?: string[]; active_nodes?: string[]; conflict?: string | null; recovery_pending?: boolean }
export interface Preview { organizations: ImportOrg[]; warnings: string[] }
export interface Imported { imported: ImportOrg[]; warnings: string[]; failed?: { slug: string; error: string; not_attempted?: string[] }[] }
export interface ImportBody { source_root: string; organizations: string[]; acknowledge_duplicate_work: boolean; native_sources?: { claude_profile?: string; codex_profile?: string } }
export interface ImportJob {
  id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  phase: string; source_root: string; organizations: string[]; current_org: string | null
  files_copied: number; bytes_copied: number; started_at: string; updated_at: string
  result: Imported | null; error: string | null
}
export const IMPORT_REQUEST_KEY = 'orgtree-import-request-id'
const jobs = '/api/desktop/import-v1/jobs'
const terminal = (job: ImportJob | null) => !!job && ['succeeded', 'failed', 'interrupted'].includes(job.state)
class JobRequestError extends Error { constructor(message: string, readonly status: number) { super(message) } }

async function request(path: string, body?: unknown): Promise<ImportJob | null> {
  const response = await fetch(path, { signal: AbortSignal.timeout(15_000), ...(body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {}) })
  let value: { job?: ImportJob | null; detail?: string }
  try { value = await response.json() } catch { throw new Error(`Import status returned an unreadable response (${response.status}).`) }
  if (!response.ok) throw new JobRequestError(value.detail || `Import request failed (${response.status}).`, response.status)
  if (value.job === null) return null
  const job = value.job
  if (!job || typeof job.id !== 'string' || !['queued', 'running', 'succeeded', 'failed', 'interrupted'].includes(job.state)
    || !Number.isFinite(job.files_copied) || job.files_copied < 0 || !Number.isFinite(job.bytes_copied) || job.bytes_copied < 0
    || !Array.isArray(job.organizations) || typeof job.phase !== 'string'
    || (job.result != null && (!Array.isArray(job.result.imported) || !Array.isArray(job.result.warnings)))
    || (job.state === 'succeeded' && !job.result)) throw new Error('Import status returned an invalid job.')
  return job
}

/** Only the request identity survives reload. Paths and the retry body stay in memory. */
export function useImportJob(active: boolean) {
  const [job, setJob] = useState<ImportJob | null>(null)
  const [issue, setIssue] = useState('')
  const [checked, setChecked] = useState(false)
  const [missing, setMissing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  const [id, setId] = useState<string | null>(null)
  const current = useRef<{ id: string | null; job: ImportJob | null; body: ImportBody | null }>({ id: null, job: null, body: null })
  const alive = useRef(false), inFlight = useRef(false)
  const persist = (value: string | null) => {
    if (value) localStorage.setItem(IMPORT_REQUEST_KEY, value)
    else localStorage.removeItem(IMPORT_REQUEST_KEY)
  }
  const accept = (value: ImportJob) => {
    current.current = { id: value.id, job: value, body: null }
    // A persistence failure after acceptance cannot erase a known server job.
    try { persist(terminal(value) ? null : value.id) } catch { /* current discovery also restores server jobs */ }
    setId(value.id); setJob(value); setMissing(false); setIssue(''); setStartError(''); setChecked(true)
  }
  const refresh = useCallback(async () => {
    if (!alive.current || inFlight.current) return
    inFlight.current = true
    try {
      let value: ImportJob | null
      const wanted = current.current.id
      if (wanted) {
        try {
          value = await request(`${jobs}/${encodeURIComponent(wanted)}`)
          if (!value || value.id !== wanted) throw new Error('Import status did not match the saved request.')
        } catch (error) {
          if (!(error instanceof JobRequestError) || error.status !== 404) throw error
          // A concurrent window may already own the destination. Adopt that
          // job instead of offering an overlapping retry.
          const other = await request(`${jobs}/current`)
          if (!alive.current) return
          if (other && !terminal(other)) { accept(other); return }
          setMissing(true); setChecked(true)
          setIssue('No saved job was found for this request. The import has not been confirmed. Check status again, or explicitly retry with the same request ID.')
          return
        }
      } else value = await request(`${jobs}/current`)
      if (!alive.current) return
      if (value) accept(value)
      else { setChecked(true); setIssue(''); setMissing(false) }
    } catch (error) {
      if (alive.current) { setMissing(false); setIssue(`Progress is temporarily unavailable: ${(error as Error).message}. This does not mean the import stopped.`) }
    } finally { inFlight.current = false }
  }, [])
  useEffect(() => {
    alive.current = true
    try {
      const saved = localStorage.getItem(IMPORT_REQUEST_KEY)
      if (saved) { current.current.id = saved; setId(saved) }
    } catch { /* Discovery is read-only and does not need browser storage. */ }
    return () => { alive.current = false }
  }, [])
  useEffect(() => { if (active) void refresh() }, [active, refresh])
  useEffect(() => {
    if (!active || (checked && !issue && !starting && (!job || terminal(job)))) return
    const timer = setInterval(() => { void refresh() }, 2500)
    return () => clearInterval(timer)
  }, [active, checked, issue, starting, job, refresh])

  const begin = async (body: ImportBody, retry = false) => {
    if (inFlight.current || starting || (!retry && (!checked || !!issue || (!!job && !terminal(job))))) return
    if (retry && (!missing || !current.current.id)) return
    const requestId = retry ? current.current.id! : crypto.randomUUID()
    // Refuse before sending when the recovery identity cannot be retained.
    try { persist(requestId) } catch {
      setIssue('Cannot save the import request ID. Restore browser storage before starting a copy.'); return
    }
    const original = retry && current.current.body ? current.current.body : body
    current.current = { id: requestId, job: null, body: original }
    setId(requestId); setJob(null); setMissing(false); setStarting(true); setIssue(''); setStartError(''); inFlight.current = true
    try {
      const value = await request(jobs, { ...original, request_id: requestId })
      if (!value || value.id !== requestId) throw new Error('Import start did not return the saved request ID.')
      if (alive.current) accept(value)
    } catch (error) {
      if (alive.current) {
        setStartError((error as Error).message)
        setIssue(`Import start is not confirmed: ${(error as Error).message}. Checking saved status; no new copy was requested.`)
      }
    } finally {
      inFlight.current = false
      if (alive.current) { setStarting(false); void refresh() }
    }
  }
  const running = !!job && !terminal(job)
  return { job, issue, startError, id, missing, starting, checked, running, refresh, begin,
    retryOriginal: missing && !!current.current.body,
    locked: starting || !checked || running || (!!issue && !missing),
  }
}
