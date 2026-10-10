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
// A SERVER IS ONE LINE UNTIL IT IS EDITED (user 2026-10-10: "these per-server
// settings should be minimized and only editable after clicking the edit
// button", "it should look similar to openrouter"): the OpenRouter key row's
// shape — name · preset · harness · address with ⟳ ✎ ✕, a digest line under
// it — and the offered models as chips where OpenRouter has its favorites.
// ✎ opens the settings as a draft that Save applies and Cancel discards.
//
// MODELS ARE CHOSEN IN A BROWSER (lsbrowser.tsx): a server may list hundreds.
//
// A CLICK ON A MODEL'S CHIP OFFERS OR WITHDRAWS IT AT ONCE (user 2026-10-10:
// "i should be able to click to change the models available without editing
// the entry"). The card's chips are every model it knows (offered ones lit,
// withdrawn ones dimmed in place) plus, when the server lists at most
// ROW_MAX models, the ones nobody has offered yet, dimmed. A longer list stays
// behind the last chip, "+N more", which opens the browser saving each change
// at once. Withdrawing only stops new hires: agents on the model keep running
// (route() does not look at `offered`). Without an answer from the server the
// known models can still be switched. More than eight offered and the chips
// are their cards alone (modelbrowser.tsx ToggleChips, as on OpenRouter).
//
// THE WINDOW IS THE TRAP. A local server runs each model with a context window
// it chose (Ollama: 4096 tokens on cards under 24 GB unless told otherwise)
// and silently cuts a longer prompt; an agent's own prompt alone is tens of
// thousands of tokens. So every offered model carries the window agents are
// told, the user can set it, a window under the backend's floor is flagged,
// and wherever the server really runs another window, the card says so
// (user 2026-10-10: the card showed 65536 for a model Ollama ran at 4096).
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
import { AutorenewIcon, DeleteIcon, EditIcon } from '../icons'
import type {
  LangServer, LangServerDoc, LangServerPreset, LangServerProbe, LangServerProbeModel, ProviderInfo,
} from '../types'
import { LangServerBrowser } from './lsbrowser'
import { CHIP_NAMES_MAX, ModelCard, ToggleChips } from './modelbrowser'
import {
  fmtTokens, LANE_CARD_COLOR, monogram, probeFacts, startWindow, variantName, wantsVariant, windowMismatch,
} from './lsmodels'
import { SetRow, SetToggle } from './settingskit'

export { fmtTokens, variantName, wantsVariant } from './lsmodels'

type ToastFn = (lines: string[]) => void

const HARNESS_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex' }

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

/** a probe's answer as the card reads it: an older engine or a stub may leave out the list */
const probeOf = (p: LangServerProbe): LangServerProbe => ({ ...p, models: Array.isArray(p?.models) ? p.models : [] })

/** a seat price as the input may hold it: 0 to the engine's maximum, two decimals */
const clampSeat = (n: number, doc: LangServerDoc): number =>
  Number.isFinite(n) ? Math.round(Math.min(doc.max_seat, Math.max(0, n)) * 100) / 100 : doc.default_seat
const seatHint = (doc: LangServerDoc): string =>
  `Credits each agent on this server's models holds from its superior's grant (0 makes them free; ${doc.default_seat} by default).`
const clampAgents = (n: number): number => Math.min(64, Math.max(1, Math.round(Number(n) || 1)))

/** what the toast says after a model is offered or withdrawn on the card */
const offeredSaid = (id: string): string => `${id} is offered to new hires`
const withdrawnSaid = (id: string): string => `${id} is withdrawn: no new hires on it; agents already on it keep running`

/** offer (a window) or withdraw (null) one model in a draft of picks */
const withPick = (cur: Record<string, number>, id: string, w: number | null): Record<string, number> => {
  const next = { ...cur }
  if (w == null) delete next[id]
  else next[id] = w
  return next
}

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

/** the models a draft offers (the add form, ✎) as chips on the button that
 *  opens the browser; more than CHIP_NAMES_MAX and they are their cards alone */
function ModelChips({ ids, windows, hint, label, onOpen, open }: {
  ids: string[]
  /** the window agents are told, per model (the chip's tooltip) */
  windows: Record<string, number>
  hint: string
  label: string
  onOpen: () => void
  open?: boolean
}) {
  const iconsOnly = ids.length > CHIP_NAMES_MAX
  return (
    <button type="button" className={'orr-favs ls-favs' + (open ? ' on' : '') + (iconsOnly ? ' icons' : '')}
      aria-haspopup="dialog" aria-expanded={!!open} aria-label={label} onClick={onOpen}>
      {ids.map((id) => (
        <span key={id} className="orr-sel ls-chip" title={`${id} · agents are told ${fmtTokens(windows[id])}`}>
          <ModelCard letter={monogram(id)} color={LANE_CARD_COLOR} />
          {!iconsOnly && <span className="orr-sel-name">{id}</span>}
        </span>
      ))}
      <span className="orr-hint">{hint}</span>
    </button>
  )
}

/** a server listing at most this many models shows them all on its card;
 *  a longer list stays behind "+N more" (the browser) */
const ROW_MAX = 12

/** per offered model, where the server runs another window than agents are told */
function MismatchLines({ items }: { items: { id: string, text: string }[] }) {
  if (!items.length) return null
  return (
    <div className="ls-mismatches" role="status">
      {items.map((x) => (
        <div key={x.id} className="ls-mismatch-line">
          <span className="mono">{x.id}</span>: <span className="ask-warn">{x.text}</span>
        </div>
      ))}
    </div>
  )
}

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
  const [browsing, setBrowsing] = useState(false)

  // a new preset brings its own address and harness; what was found is stale
  const choosePreset = (id: LangServerPreset['id']) => {
    const p = doc.presets.find((x) => x.id === id)
    setPresetId(id)
    setAddress(p?.address ?? '')
    setHarness(firstHarness(p))
    setProbe(null); setPicked({}); setBrowsing(false)
  }
  const harnessOk = preset?.harnesses.find((h) => h.id === harness)?.available === true
  const findModels = () => {
    setProbing(true)
    probeLangServer({ preset: presetId, address, harness, base_path: basePath || undefined,
      key: key.trim() || undefined })
      .then((p) => {
        setProbe(p)
        if (!p.reachable) return
        // one model: offer it; several: the browser chooses
        if (p.models.length === 1) {
          const m = p.models[0]!
          setPicked({ [m.id]: startOf(m) })
        } else if (p.models.length > 1) {
          setBrowsing(true)
        }
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setProbing(false))
  }
  const startOf = (m: LangServerProbeModel) => startWindow(m, doc.default_context)
  // the 64K version takes the original's place in what will be offered
  const makeVariant = (m: LangServerProbeModel) =>
    createOllamaVariant({ address, key: key.trim() || undefined, model: m.id })
      .then((r) => {
        setProbe(r.probe)
        setPicked((cur) => withPick(withPick(cur, m.id, null), r.created, r.context))
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
  const found = probe?.reachable ? probe.models : []
  const mismatches = Object.entries(picked).flatMap(([id, w]) => {
    const text = windowMismatch(w, found.find((m) => m.id === id), presetId === 'ollama')
    return text ? [{ id, text }] : []
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
          onChange={(e) => { setAddress(e.target.value); setProbe(null); setBrowsing(false) }} />
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
          onChange={(e) => setMaxAgents(clampAgents(Number(e.target.value)))} />
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
      {probe?.reachable && probe.models.length > 0 && (
        <ModelChips ids={Object.keys(picked)} windows={picked} label="models to offer"
          open={browsing} onOpen={() => setBrowsing(true)}
          hint={Object.keys(picked).length
            ? `${Object.keys(picked).length} to offer · click to change`
            : `+ choose the models to offer (${probe.models.length} on the server)`} />
      )}
      <MismatchLines items={mismatches} />
      <div className="ls-actions">
        <button type="button" className="acct-secondary-btn" disabled={busy || !address.trim() || !harnessOk}
          title={harnessOk ? 'add this server' : 'no installed harness can drive this kind of server'}
          onClick={submit}>Add server</button>
        <button type="button" className="acct-secondary-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        {!models.length && <span className="dim">No model picked yet: you can find and offer models later.</span>}
      </div>
      {browsing && probe?.reachable && (
        <LangServerBrowser title={`Models on ${label.trim() || preset?.label || 'the server'}`}
          models={probe.models} picked={picked} minContext={doc.min_context} defaultContext={doc.default_context}
          ollama={presetId === 'ollama'} busy={busy}
          variant={(m) => presetId === 'ollama' && wantsVariant(m, probe.models)
            ? <VariantButton model={m.id} busy={busy} onCreate={() => makeVariant(m)} /> : null}
          onPick={(id, w) => setPicked((cur) => withPick(cur, id, w))}
          onClose={() => setBrowsing(false)} />
      )}
    </div>
  )
}

// ─── ONE SERVER ──────────────────────────────────────────────────────────────

/** a server's settings while ✎ is open: nothing is sent until Save */
interface Draft {
  label: string
  address: string
  basePath: string
  enabled: boolean
  maxAgents: number
  seat: number
  /** a new key to store ('' keeps the stored one) */
  key: string
  forgetKey: boolean
  /** the offered models and the window agents are told */
  picked: Record<string, number>
}

function ServerCard({ server: s, doc, busy, toast, run }: {
  server: LangServer
  doc: LangServerDoc
  busy: boolean
  toast: ToastFn
  run: Runner
}) {
  const preset = doc.presets.find((p) => p.id === s.preset)
  const ollama = s.preset === 'ollama'
  const recorded = Object.values(s.models)
  const offered = recorded.filter((m) => m.offered).sort((a, b) => a.id.localeCompare(b.id))
  const told = Object.fromEntries(offered.map((m) => [m.id, m.context_in_use]))
  const recordedIds = recorded.map((m) => m.id).sort((a, b) => a.localeCompare(b))

  // what the server itself says about the models the card knows (their real
  // windows) and, when it lists at most ROW_MAX, about all of them, each a
  // chip: asked when the card shows and by ⟳; it loads no model
  const [check, setCheck] = useState<LangServerProbe | null>(null)
  /** `check` describes every model the server lists, not only the known ones */
  const [whole, setWhole] = useState(false)
  const [checking, setChecking] = useState(false)
  const checkNow = () => {
    setChecking(true)
    const only = recordedIds.length ? recordedIds : undefined
    probeLangServer({ server: s.id, only }).then(probeOf)
      .then((p) => {
        const listed = p.listed ?? p.models.length
        if (only && p.reachable && listed <= ROW_MAX && listed > p.models.length) {
          return probeLangServer({ server: s.id }).then(probeOf).then((all) => { setCheck(all); setWhole(all.reachable) })
        }
        setCheck(p); setWhole(p.reachable && (!only || listed <= p.models.length))
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setChecking(false))
  }
  const recordedKey = recordedIds.join('\n')
  useEffect(() => { checkNow() }, [s.id, s.address, recordedKey])

  // ✎: the draft; and the browser over the server's whole list, for the draft
  // or, from the card's "+", saving each change at once
  const [draft, setDraft] = useState<Draft | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [found, setFound] = useState<LangServerProbe | null>(null)
  const [finding, setFinding] = useState(false)
  const edit = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const startEdit = () => {
    setBrowsing(false)
    setDraft({
      label: s.label, address: s.address, basePath: s.base_path, enabled: s.enabled, maxAgents: s.max_agents,
      seat: s.seat, key: '', forgetKey: false, picked: { ...told },
    })
  }
  const cancel = () => { setDraft(null); setBrowsing(false) }
  const find = () => {
    setFinding(true)
    probeLangServer({ server: s.id }).then(probeOf)
      .then(setFound)
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setFinding(false))
  }
  const openBrowser = () => {
    setBrowsing(true)
    if (!found) {
      if (whole && check?.reachable) setFound(check)
      else find()
    }
  }

  // the card's chips: a click offers or withdraws a model at once
  const said = check?.reachable ? check.models : null
  const listed = check?.reachable ? check.listed ?? check.models.length : null
  const fresh = whole && said && listed != null && listed <= ROW_MAX ? said.filter((m) => !(m.id in s.models)) : []
  // a withdrawn model the server no longer lists is left out once it answers
  const chipIds = [
    ...recorded.filter((m) => m.offered || !said || said.some((x) => x.id === m.id)).map((m) => m.id),
    ...fresh.map((m) => m.id),
  ].sort((a, b) => a.localeCompare(b))
  const shownListed = said ? chipIds.filter((id) => said.some((m) => m.id === id)).length : 0
  const more = said ? Math.max(0, (whole ? said.length : listed ?? 0) - shownListed) : 0
  const chipTitle = (id: string, on: boolean): string => {
    const pm = said?.find((m) => m.id === id)
    const about = on ? `agents are told ${fmtTokens(told[id])}` : pm ? probeFacts(pm) : ''
    return `${id}${about ? ` · ${about}` : ''}\n${on ? 'click to withdraw it: no new hires on it; agents already on it keep running'
      : 'click to offer it to new hires'}`
  }
  /** offer a model (a known one keeps its window; a new one starts with the
   *  window the browser would give it) or withdraw it */
  const toggle = (id: string, on: boolean) => {
    const pm = said?.find((m) => m.id === id)
    const pick: LangServerModelPick = on ? { id, offered: false }
      : id in s.models ? { id, offered: true }
      : { id, offered: true, context: pm ? startWindow(pm, doc.default_context) : doc.default_context }
    void run(updateLangServer(s.id, { models: [pick] }), on ? withdrawnSaid(id) : offeredSaid(id), (v) => v.doc)
  }
  /** the browser opened from "+": each offer, withdrawal and window is saved at once */
  const pickNow = (id: string, w: number | null) => {
    const pick: LangServerModelPick = w == null ? { id, offered: false } : { id, offered: true, context: w }
    const msg = w == null ? withdrawnSaid(id) : id in told ? `${id}: agents are told ${fmtTokens(w)}` : offeredSaid(id)
    void run(updateLangServer(s.id, { models: [pick] }), msg, (v) => v.doc)
  }
  // on a server the version is listed with the others found, to offer (ruling 2026-10-10)
  const makeVariant = (m: LangServerProbeModel) =>
    createOllamaVariant({ server: s.id, model: m.id })
      .then((r) => {
        setFound(r.probe)
        toast([`created ${r.created} in your Ollama: offer it in the list`])
      })
      .catch((e: Error) => toast([`error: ${e.message}`]))

  /** what Save sends: only what the draft changed */
  const changes = (d: Draft) => {
    const body: Parameters<typeof updateLangServer>[1] = {}
    if (d.label.trim() !== s.label) body.label = d.label.trim()
    if (d.address.trim() !== s.address) body.address = d.address.trim()
    if (s.preset === 'custom' && d.basePath.trim() !== s.base_path) body.base_path = d.basePath.trim()
    if (d.enabled !== s.enabled) body.enabled = d.enabled
    if (d.maxAgents !== s.max_agents) body.max_agents = d.maxAgents
    if (d.seat !== s.seat) body.seat = d.seat
    const models: LangServerModelPick[] = []
    for (const m of recorded) {
      const w = d.picked[m.id]
      if ((w != null) !== m.offered || (w != null && w !== m.context_in_use)) {
        models.push(w != null ? { id: m.id, offered: true, context: w } : { id: m.id, offered: false })
      }
    }
    for (const [id, w] of Object.entries(d.picked)) if (!(id in s.models)) models.push({ id, offered: true, context: w })
    if (models.length) body.models = models
    return body
  }
  const save = async () => {
    if (!draft) return
    const body = changes(draft)
    let said = `saved ${draft.label.trim() || s.label}`
    if (Object.keys(body).length) {
      const ok = await run(updateLangServer(s.id, body).then((v) => {
        // a new price reaches the agents already on this server's models: say how many, and where it could not
        const moved = (v.repriced ?? []).reduce((n, o) => n + (o.repriced?.length ?? 0), 0)
        const stuck = (v.repriced ?? []).filter((o) => o.error)
        if (moved) said += ` · ${moved} agent${moved === 1 ? '' : 's'} repriced`
        if (stuck.length) said += ` · kept old seats in ${stuck.map((o) => `${o.org} (${o.error})`).join(', ')}`
        return v
      }), '', (v) => v.doc)
      if (!ok) return
    }
    const key = draft.key.trim()
    if (key || draft.forgetKey) {
      const ok = await run(setLangServerKey(s.id, key), '', (d) => d)
      if (!ok) return
      said += key ? ' · key stored' : ' · key cleared'
    }
    toast([said])
    cancel()
  }

  const mismatches = said ? offered.flatMap((m) => {
    const pm = said.find((x) => x.id === m.id)
    const text = pm ? windowMismatch(m.context_in_use, pm, ollama) : 'the server no longer lists it'
    return text ? [{ id: m.id, text }] : []
  }) : []
  const digest = [
    s.enabled ? 'on' : 'off', `${s.max_agents} at once`,
    `${offered.length} model${offered.length === 1 ? '' : 's'}`, `key: ${s.key_set ? 'set' : 'none'}`, `seat ${s.seat}`,
  ]

  return (
    <div className={'ls-server' + (s.enabled ? '' : ' ls-off') + (draft ? ' ls-editing' : '')}>
      <div className="acct-line">
        <span className="acct-gutter" />
        <div className="acct-row ls-server-row">
          <div className="acct-main">
            <span className="acct-grip acct-ghost">⠿</span>
            <span className="acct-email ls-server-head">
              <b>{s.label}</b>
              <span className="dim">
                {' · '}{preset?.label ?? s.preset}{' · '}{HARNESS_LABEL[s.harness] ?? s.harness}{' · '}
                <span className="mono">{s.base_url}</span>
              </span>
            </span>
            <button type="button" className="acct-btn" disabled={busy || checking}
              title="ask the server whether it answers, and the windows it runs the offered models with (loads no model)"
              onClick={checkNow}><AutorenewIcon fontSize="inherit" className={checking ? 'cc-spin' : undefined} /></button>
            <button type="button" className={'acct-btn' + (draft ? ' on' : '')} disabled={busy}
              aria-pressed={!!draft} title={draft ? 'close without saving' : 'edit this server'}
              onClick={() => (draft ? cancel() : startEdit())}>
              <EditIcon fontSize="inherit" /></button>
            <button type="button" className="acct-btn acct-del" disabled={busy}
              title={'remove this server — agents hired on its models stay, and their next turn says the model is '
                + 'gone until they are switched to another tier'}
              onClick={() => { void run(removeLangServer(s.id), `removed ${s.label}`, (d) => d) }}>
              <DeleteIcon fontSize="inherit" /></button>
          </div>
          <div className="acct-provenance ls-digest">
            {digest.map((d) => <span key={d}>{d}</span>)}
            {checking && <span>asking the server…</span>}
            {!checking && check && (check.reachable
              ? <span>answering{check.version ? ` · version ${String(check.version)}` : ''}
                {listed != null ? ` · ${listed} model${listed === 1 ? '' : 's'} on the server` : ''}</span>
              : <span className="acct-dead">not answering: {check.error}</span>)}
          </div>
        </div>
      </div>
      {!draft && (
        <ToggleChips busy={busy} label={`${s.label} models`} className="ls-toggles"
          chips={chipIds.map((id) => {
            const on = s.models[id]?.offered === true
            return {
              key: id, letter: monogram(id), color: LANE_CARD_COLOR, label: id, on,
              title: chipTitle(id, on), onToggle: () => toggle(id, on),
            }
          })}
          more={said ? {
            text: more ? `${more} more` : undefined,
            title: (more ? `${more} more model${more === 1 ? '' : 's'} on the server. ` : '')
              + 'Browse the server’s models: search, filters, the window agents are told; each change is saved at once',
            open: browsing, onClick: openBrowser,
          } : undefined}
          hint={chipIds.length ? '' : said ? (said.length || more ? '' : 'the server lists no models') : 'no model offered yet'} />
      )}
      {!draft && <MismatchLines items={mismatches} />}
      {draft && (
        <div className="ls-add ls-edit" role="group" aria-label={`edit ${s.label}`}>
          <SetRow label="Name">
            <input type="text" aria-label="server name" value={draft.label} disabled={busy}
              onChange={(e) => edit({ label: e.target.value })} />
          </SetRow>
          <SetRow label="Address">
            <input type="text" aria-label="server address" spellCheck={false} value={draft.address} disabled={busy}
              onChange={(e) => edit({ address: e.target.value })} />
          </SetRow>
          {s.preset === 'custom' && <SetRow label="Base path">
            <input type="text" aria-label="base path" spellCheck={false} value={draft.basePath} disabled={busy}
              onChange={(e) => edit({ basePath: e.target.value })} />
          </SetRow>}
          <SetToggle label="offer this server’s models to new hires" checked={draft.enabled} disabled={busy}
            hint="Off: nothing new is hired on it, and its agents wait until it is back on."
            onChange={(v) => edit({ enabled: v })} />
          <SetRow label="Agents at once" hint="Turns beyond this wait for one to finish.">
            <input type="number" aria-label="agents at once" min={1} max={64} value={draft.maxAgents} disabled={busy}
              onChange={(e) => edit({ maxAgents: clampAgents(Number(e.target.value)) })} />
          </SetRow>
          <SetRow label="Seat price" hint={seatHint(doc)}>
            <input type="number" aria-label="seat price" min={0} max={doc.max_seat} step={0.5} value={draft.seat}
              disabled={busy} onChange={(e) => edit({ seat: clampSeat(Number(e.target.value), doc) })} />
          </SetRow>
          <SetRow label="API key"
            hint={s.key_set ? 'A key is stored (never shown). Paste a new one to replace it.' : 'Optional: only for servers that ask for one.'}>
            <input type="password" aria-label="API key" autoComplete="off" spellCheck={false} value={draft.key}
              placeholder={s.key_set ? 'stored' : 'none'} disabled={busy || draft.forgetKey}
              onChange={(e) => edit({ key: e.target.value })} />
            {s.key_set && <label className="ls-check">
              <input type="checkbox" checked={draft.forgetKey} disabled={busy}
                onChange={(e) => edit({ forgetKey: e.target.checked, key: '' })} /> forget it</label>}
          </SetRow>
          <div className="ls-edit-models">
            <div className="acct-provider-tier-title">Models</div>
            <ModelChips ids={Object.keys(draft.picked)} windows={draft.picked} label={`choose ${s.label}'s models`}
              open={browsing} onOpen={openBrowser}
              hint={Object.keys(draft.picked).length ? 'click to change' : '+ choose the models to offer'} />
          </div>
          <div className="ls-actions">
            <button type="button" className="acct-secondary-btn"
              disabled={busy || !draft.label.trim() || !draft.address.trim()} onClick={() => { void save() }}>Save</button>
            <button type="button" className="acct-secondary-btn" disabled={busy} onClick={cancel}>Cancel</button>
            {(Object.keys(changes(draft)).length > 0 || !!draft.key.trim() || draft.forgetKey)
              && <span className="dim">unsaved changes</span>}
          </div>
        </div>
      )}
      {browsing && (
        <LangServerBrowser title={`Models on ${draft?.label.trim() || s.label}`} live={!draft}
          models={found?.reachable ? found.models : []}
          missing={found?.reachable
            ? Object.keys(draft ? draft.picked : told).filter((id) => !found.models.some((m) => m.id === id)) : []}
          picked={draft ? draft.picked : told} minContext={doc.min_context} defaultContext={doc.default_context}
          ollama={ollama} busy={busy} reading={finding}
          error={found && !found.reachable ? found.error ?? 'the server did not answer' : null}
          variant={(m) => ollama && wantsVariant(m, found?.models ?? [])
            ? <VariantButton model={m.id} busy={busy} onCreate={() => makeVariant(m)} /> : null}
          onPick={draft ? (id, w) => setDraft((d) => (d ? { ...d, picked: withPick(d.picked, id, w) } : d)) : pickNow}
          onClose={() => setBrowsing(false)} />
      )}
    </div>
  )
}
