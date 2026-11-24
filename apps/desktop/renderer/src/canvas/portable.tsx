// canvas/portable.tsx — the Export, Import and Duplicate dialogs (portable.ts has what they
// ask and the words they show; docs/rust-engine/agent-export.md).
//
// Opened from a node's context menu and the canvas's own (canvas/agentmenu.tsx, OrgCanvas.tsx)
// and mounted once per window (App.tsx). They use the dialog and the form pieces App settings'
// own dialogs use (ProviderDialog, .ls-add, .ls-actions), so they read as the same app.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { ToastFn } from '../types'
import { ProviderDialog } from './providerdialog'
import {
  INCLUDE_ALL, applyImport, closePortable, confirmExport, estimateText, exportEstimate, exportFileUrl, exportLines, exportStatus,
  forgetExport, forgetExportWhenSaved, forgetImport, importStatus, nodesText, overLimit, planDuplicate, planImport, planNotes, planText, resultLines,
  secretLines, secretPlaces, portableNeedsUpdate, portableUpdateText, sendImportFile, sizeText, startDuplicate, startExport, usePortableAsk,
} from '../portable'
import type { Estimate, ExportResult, ImportResult, Include, Job, Plan, PortableAsk } from '../portable'
import { desktop } from '../desktop'
import { downloadFile } from './filedownload'
import { historyUndo } from '../historyregistry'
import { olderEngine } from '../remotefiles'
import { remoteHere } from '../remotehere'

/** What a failed request says. An engine that does not know these routes (a remote one older than they are, whose
 *  version could not be read beforehand) answers "no route": the window says what that means instead. */
const message = (error: unknown): string => {
  const remote = remoteHere()
  if (remote && olderEngine(error)) return portableUpdateText(remote.name, remote.version)
  return error instanceof Error ? error.message : String(error)
}

/** How often a running job is read. */
const READ_EVERY_MS = 700

/** Read `job` until it has ended. */
function useJobWatch<R>(job: Job<R> | null, read: (id: string) => Promise<Job<R>>, set: (job: Job<R>) => void, fail: (text: string) => void): void {
  const running = job?.state === 'running' ? job.id : null
  useEffect(() => {
    if (!running) return
    let over = false
    const timer = window.setInterval(() => {
      read(running).then((next) => { if (!over) set(next) }).catch((error: unknown) => { if (!over) { over = true; fail(message(error)) } })
    }, READ_EVERY_MS)
    return () => { over = true; window.clearInterval(timer) }
    // `read`, `set` and `fail` are the dialog's own for its whole life: only the job's id restarts the reading
  }, [running])
}

function Progress({ job }: { job: Job<unknown> }) {
  const of = job.total > 0 ? `${Math.min(job.nodes, job.total)} of ${job.total} nodes` : ''
  const bytes = job.bytes > 0 ? (job.bytes_total ? `${sizeText(job.bytes)} of ${sizeText(job.bytes_total)}` : sizeText(job.bytes)) : ''
  return <p className="portable-progress" role="status">
    <span>{job.step || 'Starting'}…</span>
    {(of || bytes) && <span className="dim"> {[of, bytes].filter(Boolean).join(', ')}</span>}
  </p>
}

function Tick({ label, checked, disabled, onChange, hint }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; hint?: string }) {
  return <label className="portable-tick" title={hint}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> {label}
  </label>
}

function Scope({ name, subtree, set, disabled }: { name: string; subtree: boolean; set: (subtree: boolean) => void; disabled?: boolean }) {
  return <div className="portable-scope" role="radiogroup" aria-label="How much">
    <label><input type="radio" name="portable-scope" checked={!subtree} disabled={disabled} onChange={() => set(false)} /> Only {name}</label>
    <label><input type="radio" name="portable-scope" checked={subtree} disabled={disabled} onChange={() => set(true)} /> {name} and everything under it</label>
  </div>
}

// ---------------------------------------------------------------- the Export dialog

function ExportDialog({ ask, toast }: { ask: PortableAsk; toast: ToastFn }) {
  const name = ask.node!
  const [subtree, setSubtree] = useState(!!ask.hasTeam)
  const [include, setInclude] = useState<Include>(INCLUDE_ALL)
  const [strip, setStrip] = useState<boolean | null>(null)
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [job, setJob] = useState<Job<ExportResult> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const jobId = useRef<string | null>(null)
  jobId.current = job?.id ?? null

  useEffect(() => {
    let over = false
    setEstimate(null)
    exportEstimate(ask.org, name, subtree, include.retired)
      .then((next) => { if (!over) { setEstimate(next); setStrip((before) => before ?? next.strip_secrets) } })
      .catch((cause: unknown) => { if (!over) setError(message(cause)) })
    return () => { over = true }
  }, [ask.org, name, subtree, include.retired])

  useJobWatch(job, (id) => exportStatus(ask.org, id), setJob, setError)

  const close = useCallback(() => {
    // the file is the engine's until it is saved: closing lets it go
    if (jobId.current) void forgetExport(ask.org, jobId.current).catch(() => {})
    closePortable()
  }, [ask.org])

  const start = (stripNow: boolean) => {
    setBusy(true); setError('')
    const before = jobId.current
    startExport(ask.org, name, { subtree, include, strip: stripNow })
      .then((next) => { setJob(next); if (before) void forgetExport(ask.org, before).catch(() => {}) })
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setBusy(false))
  }
  const keep = () => {
    if (!job) return
    setBusy(true)
    confirmExport(ask.org, job.id).then(setJob).catch((cause: unknown) => setError(message(cause))).finally(() => setBusy(false))
  }
  const tick = (key: keyof Include) => (on: boolean) => setInclude((before) => ({ ...before, [key]: on }))
  const result = job?.result
  // USER 2026-11-23 m84e35b23ed2e: "with no secrets, theres no intermediate modal, an operating system file
  // selector opens automatically when finishing the export (pointed at your downlaods folder with a default
  // name)". The same once the secrets were answered. The link below is only what is left when that fails.
  const [unsaved, setUnsaved] = useState(false)
  const finished = job?.state === 'done' && result ? job : null
  useEffect(() => {
    if (!finished?.result) return
    let over = false
    const { id, name: fileName, result: made } = finished
    downloadFile(document, exportFileUrl(ask.org, id), fileName).then(() => {
      if (over) return
      toast(exportLines(fileName, made))
      // the engine's copy goes when the file is saved, not when this closes
      forgetExportWhenSaved(ask.org, id, fileName, desktop())
      closePortable()
    }).catch((cause: unknown) => { if (!over) { setUnsaved(true); setError(message(cause)) } })
    return () => { over = true }
    // once per finished job
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished?.id])
  const running = job?.state === 'running'
  const choosing = !job || job.state === 'failed'

  return (
    <ProviderDialog title={`Export ${name}`} busy={busy} close={close}>
      <div className="ls-add portable" role="group" aria-label={`Export ${name}`}>
        {choosing && <>
          {(ask.hasTeam || ask.project) && <Scope name={name} subtree={subtree} set={setSubtree} disabled={busy} />}
          <div className="portable-parts" role="group" aria-label="What to take">
            <Tick label="Scratch folders" checked={include.scratch} disabled={busy} onChange={tick('scratch')} />
            {subtree && <Tick label="Team folders" checked={include.team} disabled={busy} onChange={tick('team')} />}
            <Tick label="Transcripts" checked={include.transcript} disabled={busy} onChange={tick('transcript')} />
            <Tick label="CLI session files" checked={include.native_sessions} disabled={busy} onChange={tick('native_sessions')}
              hint="With them, an imported agent goes on with its own session where its harness can carry one." />
            {subtree && <Tick label="Retired agents" checked={include.retired} disabled={busy} onChange={tick('retired')} />}
          </div>
          <p className="portable-estimate" role="status">{estimate ? estimateText(estimate) : 'Measuring…'}</p>
          {estimate && overLimit(estimate) && <p className="ask-warn" role="alert">This is more than the {sizeText(estimate.limit)} one export may hold. Leave a part out, or export a smaller team.</p>}
          <Tick label="Take detected secrets out" checked={strip === true} disabled={busy || strip === null} onChange={setStrip}
            hint="Passwords, tokens, key files and watchdog credentials. The default is in App settings, Runtime." />
          {job?.state === 'failed' && <p className="ask-warn" role="alert">{job.error}</p>}
        </>}
        {running && job && <Progress job={job} />}
        {job?.state === 'confirm' && result && <div className="portable-found ask-warn" role="alertdialog" aria-label="Secrets were found">
          <p><b>This export holds secrets.</b> Whoever has the file can read them.</p>
          <ul>{secretLines(result.secrets).map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="dim">Found in: {secretPlaces(result.secrets).join('; ')}.</p>
          <div className="ls-actions">
            <button type="button" className="acct-secondary-btn" disabled={busy} onClick={() => start(true)}>Export without them</button>
            <button type="button" disabled={busy} onClick={keep}>Keep them</button>
          </div>
        </div>}
        {job?.state === 'done' && result && !unsaved && <p className="portable-progress" role="status">Opening the Save dialog…</p>}
        {job?.state === 'done' && result && unsaved && <div className="portable-done" role="status">
          <p><b>Ready:</b> {nodesText(result.counts)}, {sizeText(result.file_bytes)}.
            {result.secrets.stripped && result.secrets.detected > 0 ? ` ${result.secrets.detected} detected secrets were taken out.` : ''}</p>
          {result.not_included.length > 0 && <details className="portable-notes">
            <summary>{result.not_included.length} thing{result.not_included.length === 1 ? ' is' : 's are'} not in it</summary>
            <ul>{result.not_included.slice(0, 50).map((line) => <li key={line}>{line}</li>)}</ul>
          </details>}
          <a className="portable-save" href={exportFileUrl(ask.org, job.id)} download={job.name}
            onClick={() => toast([`Saving ${job.name}`])}>Save the file…</a>
        </div>}
        {error && <p className="ask-warn" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={busy} onClick={close}>{job?.state === 'done' ? 'Done' : 'Cancel'}</button>
          {choosing && <button type="button" disabled={busy || strip === null || !estimate || overLimit(estimate)} onClick={() => start(strip === true)}>Export</button>}
        </div>
      </div>
    </ProviderDialog>
  )
}

// ---------------------------------------------------------------- the plan, shared by import and duplicate

function PlanView({ plan, dest, beside }: { plan: Plan; dest: string | null; beside?: string }) {
  const notes = planNotes(plan)
  return <div className="portable-plan">
    <p role="status">{planText(plan, dest, beside)}</p>
    {plan.refusal && <p className="ask-warn" role="alert">{plan.refusal}</p>}
    {notes.length > 0 && <details className="portable-notes"><summary>{notes.length} note{notes.length === 1 ? '' : 's'}</summary>
      <ul>{notes.map((line) => <li key={line}>{line}</li>)}</ul></details>}
  </div>
}

// ---------------------------------------------------------------- the Import dialog

function ImportDialog({ ask, toast }: { ask: PortableAsk; toast: ToastFn }) {
  const dest = ask.node
  const [file, setFile] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  const [upload, setUpload] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [resume, setResume] = useState(false)
  const [job, setJob] = useState<Job<ImportResult> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const stop = useRef<(() => void) | null>(null)
  const uploaded = useRef<string | null>(null)
  uploaded.current = upload

  useJobWatch(job, (id) => importStatus(ask.org, id), setJob, setError)

  const close = useCallback(() => {
    stop.current?.()
    // a file that was sent up and not imported is the engine's to drop
    if (uploaded.current) void forgetImport(ask.org, uploaded.current).catch(() => {})
    closePortable()
  }, [ask.org])

  // the strategy for grants that do not fit is the app setting's, never asked here (USER m84e35b23ed2e)
  const ask_plan = useCallback((id: string) => {
    setBusy(true); setError('')
    planImport(ask.org, id, { dest })
      .then(setPlan)
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setBusy(false))
  }, [ask.org, dest])

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    event.target.value = ''
    if (!chosen) return
    setFile(chosen); setSent(0); setPlan(null); setError(''); setBusy(true)
    const sending = sendImportFile(ask.org, chosen, setSent)
    stop.current = sending.stop
    sending.done
      .then((id) => { stop.current = null; setUpload(id); ask_plan(id) })
      .catch((cause: unknown) => { stop.current = null; setBusy(false); setFile(null); setError(message(cause)) })
  }
  const apply = () => {
    if (!upload || !plan) return
    setBusy(true); setError('')
    applyImport(ask.org, upload, { dest, strategy: plan.strategy ?? plan.default_strategy, expect: plan.digest, resume_watchdogs: resume })
      .then((next) => { setJob(next); setUpload(null) })
      .catch((cause: unknown) => { setError(message(cause)); ask_plan(upload) })
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    // done: straight back to the canvas. The toast says it, with Undo as a hire's has.
    if (job?.state !== 'done' || !job.result) return
    toast(resultLines(job.result, false), historyUndo(ask.org, job.result))
    closePortable()
  }, [job?.state, job?.result, toast, ask.org])

  const facts = plan?.file
  const title = dest ? `Import under ${dest}` : 'Import'
  return (
    <ProviderDialog title={title} busy={busy && !!job} close={close}>
      <div className="ls-add portable" role="group" aria-label={title}>
        {!job && <>
          <label className="portable-file">
            <input type="file" accept=".zip,application/zip" disabled={busy} onChange={pick} aria-label="The export file" />
          </label>
          {/* the field is emptied so the same file can be chosen again: the name is said here */}
          {file && plan && <p className="portable-chosen"><b>{file.name}</b> · {sizeText(file.size)}</p>}
          {file && !plan && !error && <p role="status">{upload ? 'Reading the file…' : `Sending ${file.name}: ${sizeText(sent)} of ${sizeText(file.size)}`}</p>}
          {facts?.foreign && <p className="ask-warn" role="alert">This file is from another computer, or was changed. Import it only if you trust it.</p>}
          {plan && <PlanView plan={plan} dest={dest} />}
          {plan && facts && facts.watchdogs > 0 && <Tick label={`Arm its ${facts.watchdogs === 1 ? 'watchdog' : `${facts.watchdogs} watchdogs`}`} checked={resume} disabled={busy} onChange={setResume}
            hint="Left off, every watchdog arrives paused. Ones that watch this computer's files or need credentials stay paused either way." />}
        </>}
        {job?.state === 'running' && <Progress job={job} />}
        {job?.state === 'failed' && <p className="ask-warn" role="alert">{job.error}</p>}
        {error && <p className="ask-warn" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={job?.state === 'running'} onClick={close}>{job?.state === 'failed' ? 'Close' : 'Cancel'}</button>
          {!job && <button type="button" disabled={busy || !plan || !plan.ok} onClick={apply}>Import</button>}
        </div>
      </div>
    </ProviderDialog>
  )
}

// ---------------------------------------------------------------- the Duplicate dialog

function DuplicateDialog({ ask, toast }: { ask: PortableAsk; toast: ToastFn }) {
  const name = ask.node!
  const [subtree, setSubtree] = useState(!!ask.hasTeam)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [job, setJob] = useState<Job<ImportResult> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useJobWatch(job, (id) => importStatus(ask.org, id), setJob, setError)

  const ask_plan = useCallback((whole: boolean) => {
    setBusy(true); setError('')
    planDuplicate(ask.org, name, { subtree: whole })
      .then(setPlan)
      .catch((cause: unknown) => { setPlan(null); setError(message(cause)) })
      .finally(() => setBusy(false))
  }, [ask.org, name])
  useEffect(() => { ask_plan(subtree) }, [ask_plan, subtree])

  const apply = () => {
    if (!plan) return
    setBusy(true); setError('')
    startDuplicate(ask.org, name, { subtree, strategy: plan.strategy ?? plan.default_strategy, expect: plan.digest })
      .then(setJob)
      .catch((cause: unknown) => { setError(message(cause)); ask_plan(subtree) })
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    // done: straight back to the canvas, as an import is
    if (job?.state !== 'done' || !job.result) return
    toast(resultLines(job.result, true), historyUndo(ask.org, job.result))
    closePortable()
  }, [job?.state, job?.result, toast, ask.org])

  // USER 2026-11-23 mf35a72f9c0f1: "remove unnecessary modals". With nobody under it there is nothing to choose,
  // and a plan that fits as it is has nothing to tell: the copy is made at once, and its toast has Undo.
  // Anything else (a refusal, grants trimmed, a note, a failure) is shown and asked.
  const choice = !!(ask.hasTeam || ask.project)
  const plain = !choice && !!plan && plan.ok && !plan.shrunk_by && planNotes(plan).length === 0
  const started = useRef(false)
  useEffect(() => {
    if (!plain || started.current) return
    started.current = true
    apply()
    // once, when the first plan is there
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plain])
  if (!choice && !error && job?.state !== 'failed' && (!plan || plain)) return null
  return (
    <ProviderDialog title={`Duplicate ${name}`} busy={busy && !!job} close={closePortable}>
      <div className="ls-add portable" role="group" aria-label={`Duplicate ${name}`}>
        {!job && <>
          {(ask.hasTeam || ask.project) && <Scope name={name} subtree={subtree} set={setSubtree} disabled={busy} />}
          {!plan && !error && <p role="status">Working out what it takes…</p>}
          {plan && <PlanView plan={plan} dest={null} beside={name} />}
        </>}
        {job?.state === 'running' && <Progress job={job} />}
        {job?.state === 'failed' && <p className="ask-warn" role="alert">{job.error}</p>}
        {error && <p className="ask-warn" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={job?.state === 'running'} onClick={closePortable}>{job?.state === 'failed' ? 'Close' : 'Cancel'}</button>
          {!job && <button type="button" disabled={busy || !plan || !plan.ok} onClick={apply}>Duplicate</button>}
        </div>
      </div>
    </ProviderDialog>
  )
}

/** Mounted once per window: shows the dialog that was asked for. */
export function PortablePanel({ toast }: { toast: ToastFn }): ReactNode {
  const ask = usePortableAsk()
  // a window on a remote engine too old for this: the entry says so and nothing opens, as the Files entry does
  // (scratch-folder.ts). Asked when the entry is chosen: the connection may have learned the version since.
  const remote = ask ? remoteHere() : null
  const older = !!remote && portableNeedsUpdate(remote.version)
  useEffect(() => {
    if (!older || !remote) return
    toast([portableUpdateText(remote.name, remote.version)])
    closePortable()
    // told once per choice: `older` falls when the ask is closed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [older])
  if (!ask || older) return null
  const key = `${ask.kind}/${ask.org}/${ask.node ?? ''}`
  if (ask.kind === 'export') return <ExportDialog key={key} ask={ask} toast={toast} />
  if (ask.kind === 'import') return <ImportDialog key={key} ask={ask} toast={toast} />
  return <DuplicateDialog key={key} ask={ask} toast={toast} />
}
