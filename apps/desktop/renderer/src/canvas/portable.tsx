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
  INCLUDE_ALL, STRATEGIES, applyImport, closePortable, confirmExport, creditText, estimateText, exportEstimate, exportFileUrl, exportStatus,
  forgetExport, forgetImport, importStatus, nodesText, overLimit, planDuplicate, planImport, planRow, resultText, secretLines, secretPlaces,
  portableNeedsUpdate, portableUpdateText, sendImportFile, sizeText, startDuplicate, startExport, usePortableAsk,
} from '../portable'
import type { Estimate, ExportResult, ImportResult, Include, Job, Plan, PortableAsk, Strategy } from '../portable'
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
  const running = job?.state === 'running'
  const choosing = !job || job.state === 'failed'

  return (
    <ProviderDialog title={`Export ${name}`} busy={busy} close={close}>
      <div className="ls-add portable" role="group" aria-label={`Export ${name}`}>
        {choosing && <>
          <p className="dim portable-lead">One zip file with everything of {ask.project ? 'this project' : 'this agent'}: settings, credits, folders, transcript and history.
            It can be imported into this or another organization. Nobody is interrupted.</p>
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
          <p><b>This export holds secrets, and nothing was taken out.</b> Whoever has the file can read them.</p>
          <ul>{secretLines(result.secrets).map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="dim">Found in: {secretPlaces(result.secrets).join('; ')}.</p>
          {result.secrets.watchdog_credentials > 0 && <p>The credentials of {result.secrets.watchdog_credentials} watchdog{result.secrets.watchdog_credentials === 1 ? '' : 's'} are in the file, so the watchdogs work again after an import.</p>}
          <div className="ls-actions">
            <button type="button" className="acct-secondary-btn" disabled={busy} onClick={() => start(true)}>Export again without them</button>
            <button type="button" disabled={busy} onClick={keep}>Keep them in the file</button>
          </div>
        </div>}
        {job?.state === 'done' && result && <div className="portable-done" role="status">
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

function PlanView({ plan, dest, strategy, setStrategy, busy }: {
  plan: Plan; dest: string | null; strategy: Strategy; setStrategy: (strategy: Strategy) => void; busy: boolean
}) {
  const shrinkable = !!plan.shrunk_by || (!!plan.refusal && /strategy/.test(plan.refusal))
  return <div className="portable-plan">
    <p role="status">{nodesText(plan)} will be created. {creditText(plan, dest)}</p>
    {(shrinkable || plan.shrunk_by) && <label className="portable-strategy">Take spare credits away{' '}
      <select value={strategy} disabled={busy} onChange={(event) => setStrategy(event.target.value as Strategy)}
        title={STRATEGIES.find((s) => s.value === strategy)?.hint}>
        {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
    </label>}
    {plan.refusal && <p className="ask-warn" role="alert">{plan.refusal}</p>}
    <ul className="portable-nodes" aria-label="What will be created">
      {plan.nodes.map((node) => <li key={node.name} className={node.retired ? 'retired' : undefined}>
        <span>{planRow(node)}</span>
        {node.retired_why && <span className="dim"> {node.retired_why}</span>}
        {node.warnings.length > 0 && <ul className="portable-warnings">{node.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </li>)}
    </ul>
  </div>
}

function ResultView({ result, copy }: { result: ImportResult; copy: boolean }) {
  const notes = [...result.notes, ...result.watchdogs.notes]
  return <div className="portable-done" role="status">
    <p><b>{resultText(result, copy)}</b> The agents are idle; they run when someone writes to them.
      {result.history_entry ? ' Undo takes it back.' : ''}</p>
    {result.watchdogs.created > 0 && <p className="dim">{result.watchdogs.created} watchdog{result.watchdogs.created === 1 ? '' : 's'} came along, {result.watchdogs.paused} paused.</p>}
    {result.leftovers.length > 0 && <div className="ask-warn" role="alert">
      <p>Some parts could not be brought in:</p>
      <ul>{result.leftovers.map((line) => <li key={line}>{line}</li>)}</ul>
      {result.held.length > 0 && <p>Still held, because their transcript is missing: {result.held.join(', ')}. Unhalt them to let them run without it.</p>}
    </div>}
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
  const [strategy, setStrategy] = useState<Strategy | null>(null)
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

  const ask_plan = useCallback((id: string, with_strategy: Strategy | null) => {
    setBusy(true); setError('')
    planImport(ask.org, id, { dest, ...(with_strategy ? { strategy: with_strategy } : {}) })
      .then((next) => { setPlan(next); setStrategy(next.strategy ?? next.default_strategy) })
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
      .then((id) => { stop.current = null; setUpload(id); ask_plan(id, null) })
      .catch((cause: unknown) => { stop.current = null; setBusy(false); setFile(null); setError(message(cause)) })
  }
  const change = (next: Strategy) => { setStrategy(next); if (upload) ask_plan(upload, next) }
  const apply = () => {
    if (!upload || !plan || !strategy) return
    setBusy(true); setError('')
    applyImport(ask.org, upload, { dest, strategy, expect: plan.digest, resume_watchdogs: resume })
      .then((next) => { setJob(next); setUpload(null) })
      .catch((cause: unknown) => { setError(message(cause)); ask_plan(upload, strategy) })
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    // the toast of an action in the undo history offers Undo, as a hire's does
    if (job?.state === 'done' && job.result) toast([resultText(job.result, false)], historyUndo(ask.org, job.result))
  }, [job?.state, job?.result, toast, ask.org])

  const where = dest ? `under ${dest}` : 'at the top level'
  const facts = plan?.file
  const title = dest ? `Import under ${dest}` : 'Import'
  return (
    <ProviderDialog title={title} busy={busy && !!job} close={close}>
      <div className="ls-add portable" role="group" aria-label={title}>
        {!job && <>
          <p className="dim portable-lead">Choose a file made by Export. What it holds is created {where}, with its history and files.</p>
          <label className="portable-file">
            <input type="file" accept=".zip,application/zip" disabled={busy} onChange={pick} aria-label="The export file" />
          </label>
          {/* the field is emptied so the same file can be chosen again: the name is said here */}
          {file && plan && <p className="portable-chosen"><b>{file.name}</b> · {sizeText(file.size)}</p>}
          {file && !plan && !error && <p role="status">{upload ? 'Reading the file…' : `Sending ${file.name}: ${sizeText(sent)} of ${sizeText(file.size)}`}</p>}
          {facts && <p className="portable-facts">From <b>{facts.from.organization || 'an organization'}</b>, exported {new Date(facts.exported_at).toLocaleString()} by {facts.from.by || 'someone'} with Orgtree {facts.orgtree_version}: {sizeText(facts.unpacked_bytes)} unpacked.</p>}
          {facts?.foreign && <p className="ask-warn" role="alert">This file was made on another computer, or was changed since it was made. Import it only if you trust where it came from: the agents in it bring their own instructions and files.</p>}
          {facts && facts.secrets.detected > 0 && !facts.secrets.stripped && <p className="dim">{facts.secrets.detected} secrets were detected when it was exported and left in the file.</p>}
          {plan && strategy && <PlanView plan={plan} dest={dest} strategy={strategy} setStrategy={change} busy={busy} />}
          {plan && facts && facts.watchdogs > 0 && <Tick label={`Arm the watchdogs that can run anywhere (${facts.watchdogs} in the file)`} checked={resume} disabled={busy} onChange={setResume}
            hint="Left off, every watchdog arrives paused. Ones that watch this computer's files or need credentials stay paused either way." />}
        </>}
        {job?.state === 'running' && <Progress job={job} />}
        {job?.state === 'failed' && <p className="ask-warn" role="alert">{job.error}</p>}
        {job?.state === 'done' && job.result && <ResultView result={job.result} copy={false} />}
        {error && <p className="ask-warn" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={job?.state === 'running'} onClick={close}>{job && job.state !== 'running' ? 'Done' : 'Cancel'}</button>
          {!job && <button type="button" disabled={busy || !plan || !plan.ok || !strategy} onClick={apply}>Import</button>}
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
  const [strategy, setStrategy] = useState<Strategy | null>(null)
  const [job, setJob] = useState<Job<ImportResult> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useJobWatch(job, (id) => importStatus(ask.org, id), setJob, setError)

  const ask_plan = useCallback((whole: boolean, with_strategy: Strategy | null) => {
    setBusy(true); setError('')
    planDuplicate(ask.org, name, { subtree: whole, ...(with_strategy ? { strategy: with_strategy } : {}) })
      .then((next) => { setPlan(next); setStrategy(next.strategy ?? next.default_strategy) })
      .catch((cause: unknown) => { setPlan(null); setError(message(cause)) })
      .finally(() => setBusy(false))
  }, [ask.org, name])
  useEffect(() => { ask_plan(subtree, null) }, [ask_plan, subtree])

  const change = (next: Strategy) => { setStrategy(next); ask_plan(subtree, next) }
  const apply = () => {
    if (!plan || !strategy) return
    setBusy(true); setError('')
    startDuplicate(ask.org, name, { subtree, strategy, expect: plan.digest })
      .then(setJob)
      .catch((cause: unknown) => { setError(message(cause)); ask_plan(subtree, strategy) })
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    if (job?.state === 'done' && job.result) toast([resultText(job.result, true)], historyUndo(ask.org, job.result))
  }, [job?.state, job?.result, toast, ask.org])

  const beside = plan?.nodes[0]?.parent ?? null
  return (
    <ProviderDialog title={`Duplicate ${name}`} busy={busy && !!job} close={closePortable}>
      <div className="ls-add portable" role="group" aria-label={`Duplicate ${name}`}>
        {!job && <>
          <p className="dim portable-lead">A second {ask.project ? 'project' : 'agent'} beside this one, with the same settings, credits, folders, transcript and documents.
            Its docket items, its cost history and its mail are not copied. {name} is not interrupted.</p>
          {(ask.hasTeam || ask.project) && <Scope name={name} subtree={subtree} set={setSubtree} disabled={busy} />}
          {!plan && !error && <p role="status">Working out what it takes…</p>}
          {plan && strategy && <PlanView plan={plan} dest={beside} strategy={strategy} setStrategy={change} busy={busy} />}
        </>}
        {job?.state === 'running' && <Progress job={job} />}
        {job?.state === 'failed' && <p className="ask-warn" role="alert">{job.error}</p>}
        {job?.state === 'done' && job.result && <ResultView result={job.result} copy />}
        {error && <p className="ask-warn" role="alert">{error}</p>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={job?.state === 'running'} onClick={closePortable}>{job && job.state !== 'running' ? 'Done' : 'Cancel'}</button>
          {!job && <button type="button" disabled={busy || !plan || !plan.ok || !strategy} onClick={apply}>Duplicate</button>}
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
