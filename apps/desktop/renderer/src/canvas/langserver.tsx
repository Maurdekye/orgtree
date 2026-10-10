// canvas/langserver.tsx — App settings › Providers › Language Server: the
// user's own model servers (user spec 2026-10-01).
//
// A language server is a model server on this machine or the network —
// Ollama, LM Studio, llama.cpp, vLLM, or anything with an Anthropic- or
// OpenAI-compatible API — that one of the installed harnesses is pointed at:
// Claude Code speaks Anthropic Messages, Codex speaks the OpenAI Responses
// API. Each model the user offers on a server becomes a hireable tier.
//
// THE FORM IS THE USER'S SPEC. Adding a server starts from a dropdown of
// presets; a preset asks only for the server address and the harness, chosen
// from the harnesses actually installed AND served by that kind of server
// (the backend decides both and says why in `why`). "Custom…" shows the rest:
// API style, base path, API key, model ids, context size.
//
// ONE HARNESS PER SERVER (coordinator ruling 2026-10-09): an agent's session
// cannot move between Claude Code and Codex, so a server keeps the harness it
// was added with. The other harness is a second entry with the same address.
//
// THE WINDOW IS THE TRAP. A local server runs each model with a context window
// it chose (Ollama: 4096 tokens on cards under 24 GB unless told otherwise)
// and silently cuts a longer prompt; an agent's own prompt alone is tens of
// thousands of tokens. So every model row shows the window agents are told,
// lets the user set it, and warns below the backend's floor.
//
// AN OLLAMA MODEL CAN CARRY ITS OWN WINDOW (coordinator ruling 2026-10-10):
// never made automatically, but a model found on an Ollama server whose
// Modelfile sets no 64K window offers "Create a 64K version of this model",
// which says before the click that it adds an entry to the user's Ollama.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  addLangServer, createOllamaVariant, getLangServers, probeLangServer, removeLangServer,
  setLangServerKey, updateLangServer,
} from '../api'
import type { LangServerModelPick } from '../api'
import { useAppValue } from '../appfeed'
import { AutorenewIcon, CheckIcon, DeleteIcon, EditIcon } from '../icons'
import type {
  LangServer, LangServerDoc, LangServerModel, LangServerPreset, LangServerProbe,
  LangServerProbeModel, ProviderInfo,
} from '../types'
import { SetRow, SetToggle } from './settingskit'

type ToastFn = (lines: string[]) => void

const HARNESS_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex' }

/** 65536 → "64K", 262144 → "256K" */
export const fmtTokens = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n) || n <= 0) return '?'
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

const fmtBytes = (n: number | null | undefined): string | null =>
  n == null || n <= 0 ? null : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`

/** the window a model found on a server should start with: the one its
 *  Modelfile sets (Ollama: every request that names none gets it), else the
 *  one it runs with now, else the default (never more than it was trained for) */
const startWindow = (m: LangServerProbeModel, dflt: number): number => {
  if (m.configured_context && m.configured_context > 0) return m.configured_context
  if (m.loaded_context && m.loaded_context > 0) return m.loaded_context
  if (m.max_context && m.max_context > 0) return Math.min(m.max_context, dflt)
  return dflt
}

/** the window of the version the button makes (langserver.rs VARIANT_CONTEXT) */
const VARIANT_CONTEXT = 65536

/** the name the 64K version gets: the window added to the tag
 *  (`qwen3.8:27b` → `qwen3.8:27b-64k`); mirrors langserver.rs `variant_name` */
export const variantName = (model: string): string => {
  const m = model.trim()
  const at = m.lastIndexOf('/') + 1
  const colon = m.slice(at).lastIndexOf(':')
  const [base, tag] = colon >= 0 ? [m.slice(0, at + colon), m.slice(at + colon + 1)] : [m, 'latest']
  return `${base}:${tag.slice(0, 76)}-64k`
}

/** an Ollama model whose Modelfile sets no 64K window, that was trained for
 *  one, and has no 64K version on the server yet */
export const wantsVariant = (m: LangServerProbeModel, all: LangServerProbeModel[]): boolean =>
  !(m.configured_context && m.configured_context >= VARIANT_CONTEXT)
  && !(m.max_context && m.max_context < VARIANT_CONTEXT)
  && !all.some((x) => x.id === variantName(m.id))

/** "Create a 64K version of this model": says what it adds to the user's
 *  Ollama before the click, and does nothing without one */
function VariantButton({ model, busy, onCreate }: {
  model: string
  busy: boolean
  onCreate: () => Promise<unknown>
}) {
  const [working, setWorking] = useState(false)
  return (
    <div className="ls-variant">
      <button type="button" className="acct-secondary-btn" disabled={busy || working}
        onClick={() => { setWorking(true); void onCreate().finally(() => setWorking(false)) }}>
        {working ? 'creating…' : 'Create a 64K version of this model'}</button>
      <span className="dim">
        adds <span className="mono">{variantName(model)}</span> to your Ollama: the same model with its own
        64K window, nothing downloaded</span>
    </div>
  )
}

/** the document as this section reads it: an older engine (no such route)
 *  or a stub answering another route's shape must not take the whole
 *  settings panel down with it */
export const langServerDoc = (d: unknown): LangServerDoc | null => {
  if (!d || typeof d !== 'object') return null
  const x = d as Partial<LangServerDoc>
  return {
    servers: Array.isArray(x.servers) ? x.servers.filter((s) => s && typeof s === 'object' && s.models && typeof s.models === 'object') : [],
    presets: Array.isArray(x.presets) ? x.presets.filter((p) => p && Array.isArray(p.harnesses)) : [],
    default_seat: typeof x.default_seat === 'number' ? x.default_seat : 1,
    max_seat: typeof x.max_seat === 'number' ? x.max_seat : 100,
    min_context: typeof x.min_context === 'number' ? x.min_context : 65536,
    default_context: typeof x.default_context === 'number' ? x.default_context : 65536,
    user_enabled: x.user_enabled !== false,
  }
}

/** a seat price as the input may hold it: 0 to the engine's maximum, two decimals */
const clampSeat = (n: number, doc: LangServerDoc): number =>
  Number.isFinite(n) ? Math.round(Math.min(doc.max_seat, Math.max(0, n)) * 100) / 100 : doc.default_seat
const seatHint = (doc: LangServerDoc): string =>
  `Credits each agent on this server's models holds from its superior's grant (0 makes them free; ${doc.default_seat} by default).`

const probeFacts = (m: LangServerProbeModel): string => [
  m.parameters, m.quantization, fmtBytes(m.size),
  m.max_context ? `trained for ${fmtTokens(m.max_context)}` : null,
  m.configured_context ? `its Modelfile sets ${fmtTokens(m.configured_context)}` : null,
  m.loaded_context ? `running with ${fmtTokens(m.loaded_context)}` : null,
  m.tools === false ? 'no tool use declared' : null,
].filter(Boolean).join(' · ')

export function LanguageServerSection({ provider, headRight, toast, onChanged }: {
  /** the /api/providers entry — present once a server exists */
  provider: ProviderInfo | undefined
  /** the ProviderSwitch, rendered by the panel that owns `toggleProvider` */
  headRight?: ReactNode
  toast: ToastFn
  /** something durable changed — the panel refetches the providers payload */
  onChanged?: () => void
}) {
  const pushed = useAppValue<LangServerDoc>('langservers')
  const [doc, setDoc] = useState<LangServerDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    getLangServers().then((d) => { setDoc(langServerDoc(d)); setErr(null) })
      .catch((e: Error) => setErr(e.message))
  }, [])
  useEffect(() => { const next = langServerDoc(pushed); if (next) setDoc(next) }, [pushed])

  /** one write: busy while it runs, the answer's doc adopted, a toast */
  const run = <T,>(p: Promise<T>, ok: string, docOf: (v: T) => LangServerDoc): Promise<boolean> => {
    setBusy(true)
    return p.then((v) => {
      setDoc(langServerDoc(docOf(v))); setErr(null)
      if (ok) toast([ok])
      onChanged?.()
      return true
    }).catch((e: Error) => { toast([`error: ${e.message}`]); return false })
      .finally(() => setBusy(false))
  }

  const off = provider?.user_enabled === false
  return (
    <div className="set-group ls-section">
      <div className={'set-group-head acct-provider-head prov-langserver' + (off ? ' provider-off' : '')}>
        Language Server
        <span className="dim"> · models on your own servers</span>
        <span className="set-head-right">
          <button type="button" className="acct-secondary-btn" disabled={busy || adding || !doc?.presets.length}
            title="add a model server: Ollama, LM Studio, llama.cpp, vLLM or a custom one"
            onClick={() => setAdding(true)}>Add server</button>
        </span>
      </div>
      {headRight}
      {err && <div className="dim acct-prov-note">could not read the language servers: {err}</div>}
      {!doc && !err && <div className="dim acct-prov-note">reading language servers…</div>}
      {doc && doc.servers.length === 0 && !adding && (
        <p className="dim acct-prov-note">
          Run agents on models served from this machine or your network: Ollama, LM Studio,
          llama.cpp, vLLM, or any server with an Anthropic- or OpenAI-compatible API. Claude Code
          or Codex drives them; nothing is billed and no usage limit applies.
        </p>
      )}
      {doc?.servers.map((s) => (
        <ServerCard key={s.id} server={s} doc={doc} busy={busy} toast={toast}
          run={run} />
      ))}
      {adding && doc && (
        <AddServerForm doc={doc} busy={busy} toast={toast}
          onCancel={() => setAdding(false)}
          onAdd={(body) => {
            void run(addLangServer(body), `added ${body.label || 'the server'}`, (v) => v.doc)
              .then((ok) => { if (ok) setAdding(false) })
          }} />
      )}
    </div>
  )
}

type Runner = <T>(p: Promise<T>, ok: string, docOf: (v: T) => LangServerDoc) => Promise<boolean>

// ─── ADDING A SERVER ─────────────────────────────────────────────────────────

interface AddBody {
  preset: string
  address: string
  harness: string
  label?: string
  base_path?: string
  max_agents?: number
  seat?: number
  key?: string
  models?: LangServerModelPick[]
}

function AddServerForm({ doc, busy, toast, onCancel, onAdd }: {
  doc: LangServerDoc
  busy: boolean
  toast: ToastFn
  onCancel: () => void
  onAdd: (body: AddBody) => void
}) {
  const [presetId, setPresetId] = useState<LangServerPreset['id']>('ollama')
  const preset = doc.presets.find((p) => p.id === presetId) ?? doc.presets[0]
  const custom = presetId === 'custom'
  const [address, setAddress] = useState(preset?.address ?? '')
  const firstHarness = (p: LangServerPreset | undefined) =>
    p?.harnesses.find((h) => h.available)?.id ?? 'claude-code'
  const [harness, setHarness] = useState<string>(firstHarness(preset))
  const [label, setLabel] = useState('')
  const [basePath, setBasePath] = useState('')
  const [key, setKey] = useState('')
  const [typed, setTyped] = useState('')
  const [ctxSize, setCtxSize] = useState(doc.default_context)
  const [maxAgents, setMaxAgents] = useState(1)
  const [seat, setSeat] = useState(doc.default_seat)
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<LangServerProbe | null>(null)
  const [picked, setPicked] = useState<Record<string, number>>({})

  // a new preset brings its own address and harness; what was found is stale
  const choosePreset = (id: LangServerPreset['id']) => {
    const p = doc.presets.find((x) => x.id === id)
    setPresetId(id)
    setAddress(p?.address ?? '')
    setHarness(firstHarness(p))
    setProbe(null); setPicked({})
  }
  const harnessOk = preset?.harnesses.find((h) => h.id === harness)?.available === true
  const findModels = () => {
    setProbing(true)
    probeLangServer({ preset: presetId, address, harness, base_path: basePath || undefined,
      key: key.trim() || undefined })
      .then((p) => {
        setProbe(p)
        if (!p.reachable) return
        // one model: offer it; several: let the person choose
        if (p.models.length === 1) {
          const m = p.models[0]!
          setPicked({ [m.id]: startWindow(m, doc.default_context) })
        }
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setProbing(false))
  }
  // the 64K version takes the original's place in what will be offered
  const makeVariant = (m: LangServerProbeModel) =>
    createOllamaVariant({ address, key: key.trim() || undefined, model: m.id })
      .then((r) => {
        setProbe(r.probe)
        setPicked((cur) => {
          const next = { ...cur }
          delete next[m.id]
          next[r.created] = r.context
          return next
        })
        toast([`created ${r.created} in your Ollama`])
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
  const typedIds = typed.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  const models: LangServerModelPick[] = [
    ...Object.entries(picked).map(([id, context]) => ({ id, context })),
    ...(custom ? typedIds.filter((id) => !(id in picked)).map((id) => ({ id, context: ctxSize })) : []),
  ]
  const submit = () => onAdd({
    preset: presetId, address, harness, label: label.trim() || undefined,
    base_path: custom ? basePath.trim() || undefined : undefined,
    max_agents: maxAgents, seat, key: key.trim() || undefined, models,
  })

  return (
    <div className="ls-add" role="group" aria-label="add a language server">
      <SetRow label="Server"
        hint={preset?.note}>
        <select aria-label="kind of server" value={presetId} disabled={busy}
          onChange={(e) => choosePreset(e.target.value as LangServerPreset['id'])}>
          {doc.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </SetRow>
      <SetRow label="Address"
        hint={custom ? 'The server’s base address, e.g. https://models.example.net' : undefined}>
        <input type="text" aria-label="server address" spellCheck={false} value={address}
          placeholder="http://127.0.0.1:11434" disabled={busy}
          onChange={(e) => { setAddress(e.target.value); setProbe(null) }} />
      </SetRow>
      {custom
        ? <SetRow label="API style"
            hint="Anthropic-compatible servers are driven by Claude Code; OpenAI-compatible ones (the Responses API) by Codex.">
            <select aria-label="API style" value={harness} disabled={busy}
              onChange={(e) => setHarness(e.target.value)}>
              {preset?.harnesses.map((h) => (
                <option key={h.id} value={h.id} disabled={!h.available}>
                  {h.id === 'codex-cli' ? 'OpenAI-compatible (Codex)' : 'Anthropic-compatible (Claude Code)'}
                  {h.available ? '' : ` — ${h.why}`}
                </option>
              ))}
            </select>
          </SetRow>
        : <SetRow label="Harness"
            hint={preset?.harnesses.find((h) => h.id === harness && !h.available)?.why
              || 'The CLI that drives this server’s agents. It stays with the server.'}>
            <select aria-label="harness" value={harness} disabled={busy}
              onChange={(e) => setHarness(e.target.value)}>
              {preset?.harnesses.map((h) => (
                <option key={h.id} value={h.id} disabled={!h.available} title={h.why || undefined}>
                  {h.label}{h.available ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
          </SetRow>}
      {custom && <>
        <SetRow label="Base path" hint="Added to the address, e.g. v1 or api/anthropic. Leave empty if the address already ends there.">
          <input type="text" aria-label="base path" spellCheck={false} value={basePath} disabled={busy}
            onChange={(e) => { setBasePath(e.target.value); setProbe(null) }} />
        </SetRow>
        <SetRow label="API key" hint="Optional. Stored on this machine and never shown again.">
          <input type="password" aria-label="API key" autoComplete="off" spellCheck={false} value={key}
            disabled={busy} onChange={(e) => setKey(e.target.value)} />
        </SetRow>
        <SetRow label="Model ids" hint="As the server names them, separated by spaces or commas (or find them below).">
          <input type="text" aria-label="model ids" spellCheck={false} value={typed} disabled={busy}
            onChange={(e) => setTyped(e.target.value)} />
        </SetRow>
        <SetRow label="Context size" hint="Tokens. Must match what the server runs the models with.">
          <input type="number" aria-label="context size" min={1024} step={1024} value={ctxSize} disabled={busy}
            onChange={(e) => setCtxSize(Math.max(0, Number(e.target.value) || 0))} />
        </SetRow>
      </>}
      <SetRow label="Agents at once"
        hint="How many agents may run a turn on this server at the same time; the others wait. One GPU serves only a few.">
        <input type="number" aria-label="agents at once" min={1} max={64} value={maxAgents} disabled={busy}
          onChange={(e) => setMaxAgents(Math.min(64, Math.max(1, Number(e.target.value) || 1)))} />
      </SetRow>
      <SetRow label="Seat price" hint={seatHint(doc)}>
        <input type="number" aria-label="seat price" min={0} max={doc.max_seat} step={0.5} value={seat} disabled={busy}
          onChange={(e) => setSeat(clampSeat(Number(e.target.value), doc))} />
      </SetRow>
      <SetRow label="Name" hint="How this server is named in menus (optional).">
        <input type="text" aria-label="server name" value={label} placeholder={preset?.label} disabled={busy}
          onChange={(e) => setLabel(e.target.value)} />
      </SetRow>
      <div className="ls-find">
        <button type="button" className="acct-secondary-btn" disabled={busy || probing || !address.trim()}
          onClick={findModels}>
          {probing ? 'asking the server…' : probe ? 'ask again' : 'Find models'}
        </button>
        {probe && !probe.reachable && <span className="ask-warn">{probe.error}</span>}
        {probe?.reachable && <span className="dim">
          {probe.models.length
            ? `${probe.models.length} model${probe.models.length === 1 ? '' : 's'} on the server${probe.version ? ` · version ${String(probe.version)}` : ''}`
            : 'the server lists no models'}
        </span>}
      </div>
      {probe?.reachable && probe.note && <p className="dim acct-prov-note">{probe.note}</p>}
      {probe?.reachable && probe.models.map((m) => (
        <ProbeModelRow key={m.id} m={m} doc={doc} busy={busy}
          ctx={picked[m.id]}
          onPick={(w) => setPicked((cur) => {
            const next = { ...cur }
            if (w == null) delete next[m.id]
            else next[m.id] = w
            return next
          })}
          variant={presetId === 'ollama' && wantsVariant(m, probe.models)
            ? <VariantButton model={m.id} busy={busy} onCreate={() => makeVariant(m)} />
            : null} />
      ))}
      <div className="ls-actions">
        <button type="button" className="acct-secondary-btn" disabled={busy || !address.trim() || !harnessOk}
          title={harnessOk ? 'add this server' : 'no installed harness can drive this kind of server'}
          onClick={submit}>Add server</button>
        <button type="button" className="acct-secondary-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        {!models.length && <span className="dim">No model picked yet: you can find and offer models later.</span>}
      </div>
    </div>
  )
}

/** one model the server listed: offer it (with the window agents are told) or not */
function ProbeModelRow({ m, doc, busy, ctx, onPick, variant }: {
  m: LangServerProbeModel
  doc: LangServerDoc
  busy: boolean
  /** the window, when picked */
  ctx: number | undefined
  onPick: (ctx: number | null) => void
  /** the 64K-version button, for an Ollama model that wants one */
  variant?: ReactNode
}) {
  const on = ctx != null
  return (
    <div className="ls-model">
      <label className="ls-model-pick">
        <input type="checkbox" checked={on} disabled={busy}
          onChange={(e) => onPick(e.target.checked ? startWindow(m, doc.default_context) : null)} />
        <span className="mono">{m.id}</span>
      </label>
      <span className="dim ls-model-facts">{probeFacts(m)}</span>
      {on && <WindowInput value={ctx} min={doc.min_context} busy={busy} onChange={(w) => onPick(w)} />}
      {variant}
    </div>
  )
}

function WindowInput({ value, min, busy, onChange }: {
  value: number
  min: number
  busy: boolean
  onChange: (w: number) => void
}) {
  return (
    <span className="ls-window">
      <input type="number" aria-label="context window in tokens" min={1024} step={1024} value={value}
        disabled={busy} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
      <span className="dim">tokens</span>
      {value < min && <span className="ask-warn" title={`An agent's own prompt takes about 35K tokens, so it needs a window of at least ${fmtTokens(min)} to work`}>
        too small for an agent</span>}
    </span>
  )
}

// ─── ONE SERVER ──────────────────────────────────────────────────────────────

function ServerCard({ server: s, doc, busy, toast, run }: {
  server: LangServer
  doc: LangServerDoc
  busy: boolean
  toast: ToastFn
  run: Runner
}) {
  const preset = doc.presets.find((p) => p.id === s.preset)
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(s.label)
  const [address, setAddress] = useState(s.address)
  const [basePath, setBasePath] = useState(s.base_path)
  const [keyDraft, setKeyDraft] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<LangServerProbe | null>(null)
  const models = Object.values(s.models).sort((a, b) => a.tier.localeCompare(b.tier))
  const known = new Set(models.map((m) => m.id))
  const fresh = (probe?.models ?? []).filter((m) => !known.has(m.id))

  const patch = (body: Parameters<typeof updateLangServer>[1], ok: string) =>
    run(updateLangServer(s.id, body), ok, (v) => v.doc)
  // a new price reaches the agents already on this server's models: say how many, and where it could not
  const repriceTo = (seat: number) => {
    let said = `${s.label}: seat ${seat}`
    return run(updateLangServer(s.id, { seat }).then((v) => {
      const moved = (v.repriced ?? []).reduce((n, o) => n + (o.repriced?.length ?? 0), 0)
      const stuck = (v.repriced ?? []).filter((o) => o.error)
      if (moved) said += ` · ${moved} agent${moved === 1 ? '' : 's'} repriced`
      if (stuck.length) said += ` · kept old seats in ${stuck.map((o) => `${o.org} (${o.error})`).join(', ')}`
      return v
    }), '', (v) => v.doc).then((ok) => { if (ok) toast([said]); return ok })
  }
  const check = () => {
    setProbing(true)
    probeLangServer({ server: s.id })
      .then(setProbe)
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setProbing(false))
  }
  const save = () => {
    void patch({ label, address, ...(s.preset === 'custom' ? { base_path: basePath } : {}) },
      `saved ${label}`).then((ok) => { if (ok) setEditing(false) })
  }
  // after a check: the 64K-version button for an Ollama model that wants one;
  // the version it makes is listed below with the others found, to offer
  const variantFor = (id: string): ReactNode => {
    const found = probe?.reachable ? probe.models : []
    const m = found.find((x) => x.id === id)
    if (s.preset !== 'ollama' || !m || !wantsVariant(m, found)) return null
    return <VariantButton model={id} busy={busy} onCreate={() =>
      createOllamaVariant({ server: s.id, model: id })
        .then((r) => { setProbe(r.probe); toast([`created ${r.created} in your Ollama: offer it below`]) })
        .catch((e: Error) => toast([`error: ${e.message}`]))} />
  }

  return (
    <div className={'ls-server' + (s.enabled ? '' : ' ls-off')}>
      <div className="ls-server-head">
        <b>{s.label}</b>
        <span className="dim">
          {' · '}{preset?.label ?? s.preset}{' · '}{HARNESS_LABEL[s.harness] ?? s.harness}{' · '}
          <span className="mono">{s.base_url}</span>
        </span>
        <span className="ls-server-tools">
          <button type="button" className="acct-btn" disabled={busy || probing}
            title="ask the server whether it answers and which models it has (loads no model)"
            onClick={check}><AutorenewIcon fontSize="inherit" className={probing ? 'cc-spin' : undefined} /></button>
          <button type="button" className="acct-btn" disabled={busy}
            title="rename or move this server" onClick={() => setEditing((v) => !v)}>
            <EditIcon fontSize="inherit" /></button>
          <button type="button" className="acct-btn acct-del" disabled={busy}
            title={'remove this server — agents hired on its models stay, and their next turn says the model is '
              + 'gone until they are switched to another tier'}
            onClick={() => { void run(removeLangServer(s.id), `removed ${s.label}`, (d) => d) }}>
            <DeleteIcon fontSize="inherit" /></button>
        </span>
      </div>
      {probe && <div className={probe.reachable ? 'dim acct-prov-note' : 'ask-warn'}>
        {probe.reachable
          ? `answering${probe.version ? ` · version ${String(probe.version)}` : ''} · ${probe.models.length} model${probe.models.length === 1 ? '' : 's'} on the server`
          : `not answering: ${probe.error}`}
      </div>}
      {probe?.reachable && probe.note && <p className="dim acct-prov-note">{probe.note}</p>}
      {editing && <>
        <SetRow label="Name">
          <input type="text" aria-label="server name" value={label} disabled={busy}
            onChange={(e) => setLabel(e.target.value)} />
        </SetRow>
        <SetRow label="Address">
          <input type="text" aria-label="server address" spellCheck={false} value={address} disabled={busy}
            onChange={(e) => setAddress(e.target.value)} />
        </SetRow>
        {s.preset === 'custom' && <SetRow label="Base path">
          <input type="text" aria-label="base path" spellCheck={false} value={basePath} disabled={busy}
            onChange={(e) => setBasePath(e.target.value)} />
        </SetRow>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" disabled={busy || !label.trim() || !address.trim()}
            onClick={save}>Save</button>
          <button type="button" className="acct-secondary-btn" disabled={busy}
            onClick={() => { setEditing(false); setLabel(s.label); setAddress(s.address); setBasePath(s.base_path) }}>
            Cancel</button>
        </div>
      </>}
      <SetToggle label="offer this server’s models to new hires" checked={s.enabled} disabled={busy}
        hint="Off: nothing new is hired on it, and its agents wait until it is back on."
        onChange={(v) => { void patch({ enabled: v }, `${s.label} ${v ? 'on' : 'off'}`) }} />
      <SetRow label="Agents at once" hint="Turns beyond this wait for one to finish.">
        <input type="number" aria-label="agents at once" min={1} max={64} defaultValue={s.max_agents}
          key={s.max_agents} disabled={busy}
          onBlur={(e) => {
            const n = Math.min(64, Math.max(1, Number(e.target.value) || 1))
            if (n !== s.max_agents) void patch({ max_agents: n }, `${s.label}: ${n} agent${n === 1 ? '' : 's'} at once`)
          }} />
      </SetRow>
      <SetRow label="Seat price" hint={seatHint(doc)}>
        <input type="number" aria-label="seat price" min={0} max={doc.max_seat} step={0.5} defaultValue={s.seat}
          key={s.seat} disabled={busy}
          onBlur={(e) => {
            const n = clampSeat(Number(e.target.value), doc)
            if (n !== s.seat) void repriceTo(n)
          }} />
      </SetRow>
      <SetRow label="API key"
        hint={s.key_set ? 'A key is stored (never shown). Paste a new one to replace it.' : 'Optional: only for servers that ask for one.'}>
        <input type="password" aria-label="API key" autoComplete="off" spellCheck={false} value={keyDraft}
          placeholder={s.key_set ? 'stored' : 'none'} disabled={busy}
          onChange={(e) => setKeyDraft(e.target.value)} />
        <button type="button" className="acct-btn acct-add" disabled={busy || !keyDraft.trim()}
          title="store the key" onClick={() => {
            void run(setLangServerKey(s.id, keyDraft.trim()), 'key stored', (d) => d)
              .then((ok) => { if (ok) setKeyDraft('') })
          }}><CheckIcon fontSize="inherit" /></button>
        {s.key_set && <button type="button" className="acct-btn acct-del" disabled={busy}
          title="forget the key" onClick={() => { void run(setLangServerKey(s.id, ''), 'key cleared', (d) => d) }}>
          <DeleteIcon fontSize="inherit" /></button>}
      </SetRow>
      <div className="ls-models" aria-label={`${s.label} models`}>
        <div className="acct-provider-tier-title">Models</div>
        {!models.length && <p className="dim acct-prov-note">
          No model offered yet. Use ↻ to ask the server which models it has.</p>}
        {models.map((m) => (
          <ModelRow key={m.id} m={m} doc={doc} busy={busy} variant={variantFor(m.id)}
            onOffer={(v) => { void patch({ models: [{ id: m.id, offered: v }] }, `${m.label} ${v ? 'offered' : 'withdrawn'}`) }}
            onWindow={(w) => { void patch({ models: [{ id: m.id, context: w }] }, `${m.label}: ${fmtTokens(w)} tokens`) }} />
        ))}
        {fresh.map((m) => (
          <div className="ls-model" key={m.id}>
            <span className="mono">{m.id}</span>
            <span className="dim ls-model-facts">{probeFacts(m)}</span>
            <button type="button" className="acct-secondary-btn" disabled={busy}
              title="offer this model to new hires"
              onClick={() => {
                void patch({ models: [{ id: m.id, context: startWindow(m, doc.default_context), offered: true }] },
                  `${m.id} offered`)
              }}>offer</button>
            {variantFor(m.id)}
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelRow({ m, doc, busy, onOffer, onWindow, variant }: {
  m: LangServerModel
  doc: LangServerDoc
  busy: boolean
  onOffer: (offered: boolean) => void
  onWindow: (w: number) => void
  /** the 64K-version button, after a check found it wants one */
  variant?: ReactNode
}) {
  const [w, setW] = useState(m.context_in_use)
  useEffect(() => { setW(m.context_in_use) }, [m.context_in_use])
  return (
    <div className="ls-model">
      <label className="ls-model-pick" title={`hired as tier ${m.tier}`}>
        <input type="checkbox" checked={m.offered} disabled={busy} onChange={(e) => onOffer(e.target.checked)} />
        <span className="mono">{m.id}</span>
      </label>
      <span className="ls-window">
        <input type="number" aria-label={`${m.id} context window in tokens`} min={1024} step={1024} value={w}
          disabled={busy} onChange={(e) => setW(Math.max(0, Number(e.target.value) || 0))}
          onBlur={() => { if (w > 0 && w !== m.context_in_use) onWindow(w) }} />
        <span className="dim">tokens</span>
        {w < doc.min_context && <span className="ask-warn"
          title={`An agent's own prompt takes about 35K tokens, so it needs a window of at least ${fmtTokens(doc.min_context)} to work`}>
          too small for an agent</span>}
      </span>
      {variant}
    </div>
  )
}
