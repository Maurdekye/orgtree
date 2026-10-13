import { PinFrame } from './modalpin'
import { ProviderDialog } from './providerdialog'
import { OpenRouterAddedKeys, OpenRouterKeyDialog, OriginalKeyActive, keyHarness, originalKeyName } from './openrouterkeys'
import { useAppValue } from '../appfeed'
// canvas/openrouter.tsx — the OpenRouter lane's settings surface (user spec
// 2026-09-02, verbatim intent):
//
//   · key entry opened from Providers in its own dialog (user 2026-10-11);
//   · once a key is registered, a separate ROW of model-card icons (the
//     favorites) appears below it — the row highlights as one control, and
//     clicking it opens the MODEL SELECTION modal;
//   · the modal searches the catalog, shows a page of results at a time (the
//     original spec said 5–10; superseded 2026-09-04 — see `PAGE`), each with
//     its icon card, full name, provider (vendor) and cost per 1M tokens in
//     and out; selecting/deselecting adds/removes the model from the row;
//   · the favorites are the models whose TOKENS (chips) can be hired.
//
// THE ROW'S CHIPS SWITCH (user 2026-10-10, "i should be able to click to
// change the models available without editing the entry", for OpenRouter and
// the language servers alike): the row is no longer one button. Each
// favorite is a chip (card and name) that a click deselects at once; it stays
// in its place, dimmed, until the section closes, so a second click selects
// it again. The last chip, "+", opens the picker. With more than eight
// favorites the chips are their cards alone (modelbrowser.tsx ToggleChips).
//
// Cards are MONOGRAMS (user choice): the model's canonical letter on its
// canonical colour, both derived by the backend from the model id, the same
// visual language as the tier chips on the canvas. There is no cap on
// favorites (user choice); the row wraps.
//
// The key is written here and never read back: the document this renders
// says `key_set`, the key's LABEL at openrouter.ai and the credit standing —
// nothing else, by construction of the backend (openrouter.py).
//
// THE KEY ROW IS AN ACCOUNT ROW (2026-09-03). It is built from the accounts
// panel's own parts — `.acct-line` › `.acct-gutter` + `.acct-row` ›
// `.acct-main` (ghost grip · field · 27px icon buttons) + `.acct-provenance`
// — so it sits on the Claude rows' rail and ends on their button column, and
// the standing has two lines the way theirs does: identity + verdict on the
// bold, ellipsised first line; the credit figures dim on the second.
// ⚠ `.acct-btn` IS A 27x27 ICON BUTTON. The first cut put the words
// "refresh", "replace" and "clear" in it, and each label spilled ~35px out of
// a 25px box, over its neighbours and over the wrapped standing line (the
// user's 2026-09-02 screenshot: "$0.16efreeplacclear"). Icons only; the
// words go in `title`. `tests/orrkey_probe.py` measures this in a browser.

import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  addOpenRouterKey, clearOpenRouterKey, getOpenRouter, searchOpenRouterModels, setOpenRouterFavorite,
  setOpenRouterKey, updateOpenRouterKey,
} from '../api'
import { AutorenewIcon, DeleteIcon, EditIcon } from '../icons'
import type {
  OpenRouterDoc, OpenRouterHarness, OpenRouterModel, OpenRouterModelsPage,
  OpenRouterSort, ProviderInfo, ProviderTier,
} from '../types'
import { byOpenrouterPriceDesc, capabilityNote, capabilityNotes, fmtCredits, modelLabel, setOpenRouterTiers } from './shared'
import { BrowserPager, BrowserSelected, ModelCard, ToggleChips } from './modelbrowser'
import { SetToggle } from './settingskit'
import { fmtHm, fmtMonth } from '../timefmt'

type ToastFn = (lines: string[]) => void

/** ONE OpenRouter document for every surface that shows it: whichever
 *  writes, the others re-read nothing and still show the answer. (The
 *  Runtime tab's global harness row it once fed is gone: each key has its
 *  own harness, user 2026-10-13.) */
const docListeners = new Set<(d: OpenRouterDoc) => void>()
function shareDoc(d: OpenRouterDoc): void {
  for (const l of docListeners) l(d)
}
function useSharedDoc(adopt: (d: OpenRouterDoc) => void): void {
  const ref = useRef(adopt)
  ref.current = adopt
  const pushed = useAppValue<OpenRouterDoc>('openrouter')
  useEffect(() => { if (pushed) ref.current(pushed) }, [pushed])
  useEffect(() => {
    const l = (d: OpenRouterDoc) => ref.current(d)
    docListeners.add(l)
    return () => { docListeners.delete(l) }
  }, [])
}

/** rows per page (user ask 2026-09-04: "increase the results per page, and
 *  compress their height so more can be fit onto the same page at once").
 *  Was 8, which was the old "5–10 at a time" spec; that spec is retired.
 *  25 is ~3x the old page, and at the compressed 39.9px row (measured) the
 *  list's 60vh box shows ~12 at once, so a page is about two screenfuls of
 *  scrolling — enough that most searches are a single page, while the
 *  unfiltered 426 still pages (18 of them) instead of arriving all at once.
 *  The backend clamps to `PAGE_MIN..PAGE_MAX`; this is the opinion. */
const PAGE = 25

const money = (v: number | null | undefined, digits = 2): string =>
  v == null || Number.isNaN(v) ? '—' : `$${v.toFixed(digits)}`
/** per-million price, trimmed: $0.14 · $2 · $10 */
const perM = (v: number): string =>
  `$${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1).replace(/\.0$/, '')}`
const knownPerM = (v: number | undefined, unknown: string[] | undefined,
  field: 'prompt' | 'completion'): string =>
  unknown?.includes(field) || v == null ? '—' : perM(v)
const ctxK = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
/** "Sep 2026" from the catalog's unix release stamp */
const released = (secs: number): string => fmtMonth(secs)
/** how each sort reads in a sentence, and what each DIRECTION means in it —
 *  "ascending" is meaningless to read, "cheapest first" is not */
const SORT_LABEL: Record<OpenRouterSort, string> = {
  relevance: 'best match', input: 'input price',
  output: 'output price', recency: 'release date',
}
const DIR_LABEL: Record<OpenRouterSort, Record<'asc' | 'desc', string>> = {
  relevance: { asc: 'best match', desc: 'best match' },
  input: { asc: 'cheapest first', desc: 'dearest first' },
  output: { asc: 'cheapest first', desc: 'dearest first' },
  recency: { asc: 'oldest first', desc: 'newest first' },
}
/** "checked 01:20" — when the key was last verified, on the local clock */
const clock = (iso: string): string => fmtHm(iso) || iso

/** the credit standing as the row's second line: one short phrase per figure,
 *  only the figures openrouter.ai actually reported */
function standingOf(doc: OpenRouterDoc): string[] {
  const c = doc.credits
  if (!doc.connected || !c) return []
  const out = [c.limit_remaining != null
    ? `${money(c.limit_remaining)} of ${money(c.limit)} left`
    : `${money(c.usage)} spent`]
  if (c.usage_daily != null) out.push(`today ${money(c.usage_daily)}`)
  if (c.usage_weekly != null) out.push(`week ${money(c.usage_weekly)}`)
  if (c.usage_monthly != null) out.push(`month ${money(c.usage_monthly)}`)
  if (c.is_free_tier) out.push('free tier')
  if (c.checked_at) out.push(`checked ${clock(c.checked_at)}`)
  return out
}

/** the monogram card (canvas/modelbrowser.tsx), still importable from here */
export { ModelCard }

/** the card's tooltip: the label the hire surfaces print, the full display
 *  name, the vendor (once — it is no longer part of either name), prices, seat */
const tierTitle = (t: ProviderTier): string =>
  `${t.label ?? modelLabel(t.model)} · ${t.name ?? ''} — ${t.vendor ?? ''} · `
  + `${knownPerM(t.prompt, t.price_unknown, 'prompt')} in / `
  + `${knownPerM(t.completion, t.price_unknown, 'completion')} out per 1M`
  + `${t.price_unknown?.length ? ' · incomplete catalog pricing' : ''}`
  + ` · seat ${fmtCredits(t.seat)}`
  + ` · ${capabilityNotes(t)}`

/** what a click on a favorite's chip does */
const CHIP_DESELECT = 'click to deselect: it can no longer be hired; agents already on it keep running'
const CHIP_RESELECT = 'click to select it again'

/** the chips already shown keep their places (the current record of each
 *  favorite, or the last one seen of a deselected model); new favorites follow */
const keepPlaces = (prev: ProviderTier[], tiers: ProviderTier[]): ProviderTier[] => {
  const now = new Map(tiers.map((t) => [t.model, t]))
  return [...prev.map((t) => now.get(t.model) ?? t), ...tiers.filter((t) => !prev.some((p) => p.model === t.model))]
}

/** the whole section: head (label, switch), key row, favorites row, picker */
export function OpenRouterSection({ provider, headRight, toast, pickerOpen,
  setPickerOpen, onChanged }: {
  /** the /api/providers entry — for the on/off switch state and the head */
  provider: ProviderInfo | undefined
  /** the ProviderSwitch, rendered by the panel that owns `toggleProvider` */
  headRight?: ReactNode
  toast: ToastFn
  /** the picker is a modal INSIDE the App settings modal: the panel tracks
   *  whether it is open so its own Escape handler closes only the top layer */
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  /** something durable changed (key, favorites) — the panel refetches the
   *  providers payload so its other consumers see it without waiting a poll */
  onChanged?: () => void
}) {
  const [doc, setDoc] = useState<OpenRouterDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [addingKey, setAddingKey] = useState(false)

  const adopt = (d: OpenRouterDoc) => {
    setDoc(d); setErr(null)
    setOpenRouterTiers(d.tiers)
  }
  useSharedDoc(adopt)
  const load = (force = false) => getOpenRouter(force).then(shareDoc)
    .catch((e: Error) => setErr(e.message))
  useEffect(() => { void load() }, [])

  const run = (p: Promise<OpenRouterDoc>, ok: string) => {
    setBusy(true)
    p.then((d) => { shareDoc(d); if (ok) toast([ok]); onChanged?.() })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }
  const saveKey = () => {
    const k = keyDraft.trim()
    if (!k) return
    run(setOpenRouterKey(k), 'OpenRouter key saved')
    setKeyDraft(''); setEditingKey(false)
  }

  const off = provider?.user_enabled === false
  const keySet = !!doc?.key_set
  // any key at all (the original may be gone while added keys remain): the
  // favorites and the lane's state follow it, the original's row `keySet`
  const anyKey = !!(doc?.any_key ?? keySet)
  // an older backend serves no `harness` at all, and the head's clause simply
  // does not appear for it. The CHOICE is each key's own, in its settings
  // dialog (user 2026-10-13); the head only reports it.
  const harness = doc?.harness
  const keyHarnesses = [...new Set((doc?.keys ?? []).map((k) => k.harness).filter((h): h is string => !!h))]
  const original = doc?.keys?.find((k) => k.original)
  const favorites = doc?.tiers ?? []
  // the chips as shown since the section opened: a model deselected here or in
  // the picker keeps its place, dimmed, and a new favorite joins at the end.
  // Merged while rendering too, so the first paint already has every chip.
  const [seen, setSeen] = useState<ProviderTier[]>([])
  useEffect(() => { if (doc) setSeen((prev) => keepPlaces(prev, doc.tiers ?? [])) }, [doc])
  // the dearest first (the one listing rule for the chosen models), a model just
  // deselected keeping the place its price gives it
  const shown = keepPlaces(seen, favorites).sort(byOpenrouterPriceDesc)
  const standing = doc ? standingOf(doc) : []
  // line 1's verdict word, and the tone it reads in
  const verdict = doc?.connected ? 'connected'
    : doc?.reason ? 'not connected' : 'not checked yet'
  const verdictClass = doc?.connected || !doc?.reason ? 'dim' : 'ask-warn-inline'

  return (
    <div className="set-group">
      <div className={'set-group-head acct-provider-head prov-openrouter'
        + (off ? ' provider-off' : '')}>
        OpenRouter
        {/* the subtitle used to assert "runs on Claude Code" unconditionally.
            That was true while there was one harness and became a false
            claim the moment there were two — the head is exactly where a
            person looks to learn what this lane is. */}
        <span className="dim"> · REST API{harness && keyHarnesses.length === 1
          ? `, runs on ${labelOf(harness, keyHarnesses[0])}`
          : keyHarnesses.length > 1 ? ', each key on its own harness' : ''}</span>
        <span className="set-head-right">
          {doc && <button type="button" className="acct-secondary-btn"
            disabled={busy} aria-haspopup="dialog"
            onClick={() => anyKey ? setAddingKey(true) : setEditingKey(true)}>
            {anyKey ? 'Add another OpenRouter key' : 'Add OpenRouter key'}
          </button>}
          {!off && anyKey && !provider?.hire_enabled
            && <span className="acct-preview-tag">preview</span>}
          {headRight}
        </span>
      </div>
      {err && <div className="dim acct-prov-note">could not read OpenRouter state: {err}</div>}
      {!doc && !err && <div className="dim acct-prov-note">reading OpenRouter state…</div>}

      {doc && addingKey && <OpenRouterKeyDialog title="Add another OpenRouter key" keyRequired
        initialName="" harness={harness && keyHarness(harness, harness.stored)}
        busy={busy} close={() => setAddingKey(false)}
        save={(name, key, h) => { run(addOpenRouterKey(key, name, h), 'OpenRouter key added'); setAddingKey(false) }} />}
      {doc && editingKey && keySet && <OpenRouterKeyDialog title="Replace OpenRouter key"
        keyRequired={false} initialName={original?.label ?? ''}
        harness={harness && original?.harness
          ? keyHarness(harness, original.harness, original.pinned_seats) : undefined}
        busy={busy} close={() => setEditingKey(false)}
        save={(name, key, h) => {
          const moved = h && h !== original?.harness ? { harness: h } : {}
          run(updateOpenRouterKey('openrouter-key', key ? { label: name, key, ...moved } : { label: name, ...moved }),
            key ? 'OpenRouter key saved' : moved.harness && harness
              ? `OpenRouter key now runs on ${labelOf(harness, moved.harness)}` : 'OpenRouter key renamed')
          setEditingKey(false)
        }} />}
      {doc && editingKey && !keySet && (
        <ProviderDialog title="Add OpenRouter key"
          busy={busy} close={() => { setEditingKey(false); setKeyDraft('') }}>
          <div className="provider-key-form">
            <label htmlFor="openrouter-key-draft">API key</label>
            <input type="password" autoComplete="off" spellCheck={false}
              id="openrouter-key-draft" placeholder={keySet
                ? 'paste the new OpenRouter API key'
                : 'paste an OpenRouter API key (sk-or-\u2026)'}
              aria-label="OpenRouter API key"
              value={keyDraft} disabled={busy}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveKey() }} />
            <div className="ls-actions">
              <button type="button" className="acct-secondary-btn"
                title={keySet ? 'replace the key' : 'set the key'}
                disabled={busy || !keyDraft.trim()} onClick={saveKey}>Save</button>
              <button type="button" className="acct-secondary-btn" title="keep the current key"
                disabled={busy}
                onClick={() => { setEditingKey(false); setKeyDraft('') }}>Cancel</button>
            </div>
          </div>
          <div className="acct-provenance">
            <span>stored on this machine, never shown again</span>
            <span>get one at openrouter.ai/keys</span>
          </div>
        </ProviderDialog>
      )}

      {/* the KEY row — identity + verdict, then the credit standing, then
          three icon buttons: re-check · replace · forget */}
      {doc && keySet && (
        <div className="acct-line">
          <span className="acct-gutter" />
          <div className="acct-row orr-keyrow">
            <div className="acct-main">
              <span className="acct-grip acct-ghost">⠿</span>
              <span className="acct-email orr-standing"
                title={[`${originalKeyName(doc)} · ${verdict}`,
                  ...(doc.connected ? standing : [doc.reason ?? ''])]
                  .filter(Boolean).join(' · ')}>
                {originalKeyName(doc)}
                <span className={verdictClass}> · {verdict}</span>
                {harness && original?.harness
                  && <span className={original.harness_installed === false ? 'ask-warn-inline' : 'dim'}>
                    {' · '}{labelOf(harness, original.harness)}{original.harness_installed === false ? ' (not installed)' : ''}</span>}
              </span>
              <button className="acct-btn"
                title="re-check the key and its credit standing at openrouter.ai"
                disabled={busy} onClick={() => run(getOpenRouter(true), '')}>
                <AutorenewIcon fontSize="inherit" /></button>
              <button className="acct-btn" title="replace the key — the favorites stay"
                disabled={busy} aria-haspopup="dialog" onClick={() => setEditingKey(true)}>
                <EditIcon fontSize="inherit" /></button>
              <button className="acct-btn acct-del"
                title="forget the key — nothing on OpenRouter can be hired until a new one is set; the favorites stay"
                disabled={busy}
                onClick={() => run(clearOpenRouterKey(), 'OpenRouter key cleared')}>
                <DeleteIcon fontSize="inherit" /></button>
            </div>
            <div className="acct-provenance">
              {doc.connected
                ? standing.map((s) => <span key={s}>{s}</span>)
                : <span className={doc.reason ? 'acct-dead' : ''}>
                  {doc.reason ?? 'not checked at openrouter.ai yet — re-check to see the credit standing'}
                </span>}
            </div>
            <OriginalKeyActive doc={doc} busy={busy} run={run} />
          </div>
        </div>
      )}
      {/* several keys at once: each added key's row and settings */}
      {doc && <OpenRouterAddedKeys doc={doc} busy={busy} run={run} />}

      {/* the favorites ROW: a chip per favorite that a click deselects (or,
          dimmed, selects again), then "+" for the picker. Rendered only once
          a key exists. */}
      {doc && anyKey && (
        <ToggleChips busy={busy} label="OpenRouter models that can be hired"
          chips={shown.map((t) => {
            const on = favorites.some((f) => f.model === t.model)
            const label = t.label ?? modelLabel(t.model)
            return {
              key: t.tier, letter: t.letter, color: t.color ?? '#9aa0a6', accent: t.accent, label, on,
              title: `${tierTitle(t)}\n${on ? CHIP_DESELECT : CHIP_RESELECT}`,
              onToggle: () => run(setOpenRouterFavorite(t.model, !on), `${on ? 'removed' : 'added'} ${t.name ?? label}`),
            }
          })}
          more={{
            text: favorites.length ? undefined : 'pick the models that can be hired',
            title: 'search the OpenRouter catalog for more models that can be hired',
            open: pickerOpen, onClick: () => setPickerOpen(true),
          }} />
      )}
      {doc && anyKey && !off && provider?.reason && provider.hire_enabled === false
        && favorites.length > 0
        && <div className="dim acct-prov-note">{provider.reason}</div>}

      {pickerOpen && doc && (
        <ModelPicker doc={doc} busy={busy}
          onToggle={(m, selected) =>
            run(setOpenRouterFavorite(m.id, selected),
                `${selected ? 'added' : 'removed'} ${m.name}`)}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}

export function labelOf(h: OpenRouterHarness, id: string | null): string {
  return h.harnesses.find((x) => x.id === id)?.label ?? (id ?? '')
}

/** the model-selection modal (user spec): search → a page of results with card,
 *  full name, vendor, $/1M in and out → select/deselect — and (user ask
 *  2026-09-03) the SELECTED list on the modal itself: every favorite at a
 *  glance, each with a ✕ that deselects it without searching for it first. */
export function ModelPicker({ doc, busy, onToggle, onClose }: {
  doc: OpenRouterDoc
  busy: boolean
  /** id + display name are all a toggle needs — a search row hands over its
   *  catalog entry, a chip in the selected list hands over its tier */
  onToggle: (m: Pick<OpenRouterModel, 'id' | 'name'>, selected: boolean) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<OpenRouterModelsPage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // the ordering controls (user spec 2026-09-04). They live on the SERVER —
  // the page is 8 rows of 426, so sorting here would reorder a page, not a
  // catalog. `grouped` is deliberately perpendicular to `sort`: it re-groups
  // the same ordering rather than replacing it.
  const [sort, setSort] = useState<OpenRouterSort>('relevance')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [grouped, setGrouped] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // request guard: a slow page for an old query must not land over a fast
  // one for the current query
  const seq = useRef(0)
  // THE ONLY AUTHORITY on "selected" is the live doc — the favorites the
  // backend returned from the last PUT. A search page also carries a
  // `selected` flag per item, but that flag is the server's answer AT FETCH
  // TIME and the page is not refetched on a toggle: OR-ing it in (the first
  // cut) meant a row fetched as selected could never render deselected —
  // the user's 2026-09-03 bug. The flag is not read here at all.
  const selected = new Set(doc.tiers.map((t) => t.model))

  useEffect(() => {
    const id = ++seq.current
    const timer = setTimeout(() => {
      searchOpenRouterModels(q, offset, PAGE, sort, order, grouped)
        .then((p) => { if (seq.current === id) { setPage(p); setErr(null) } })
        .catch((e: Error) => { if (seq.current === id) setErr(e.message) })
    }, q ? 200 : 0)
    return () => clearTimeout(timer)
  }, [q, offset, sort, order, grouped])
  useEffect(() => { inputRef.current?.focus() }, [])

  const total = page?.total ?? 0
  return (
    <PinFrame dialogLabel="OpenRouter model selection" kind="openrouter-picker" title="OpenRouter models" panel="settings orr-picker" close={onClose} pinnable={false}>
        <h3>OpenRouter models
          <span className="dim"> · {doc.tiers.length} selected</span></h3>
        {/* the SELECTED list: the same models the section's favorites row
            shows, here as editable chips — card, label, ✕. Order is the
            user's own (the doc's), so a chip stays where it was. */}
        <BrowserSelected busy={busy}
          empty="nothing selected yet — search below and select the models that can be hired"
          removeVerb="deselect"
          removeTitle="deselect — it can no longer be hired; agents already on it keep running"
          chips={doc.tiers.map((t) => {
            const label = t.label ?? modelLabel(t.model)
            return { key: t.tier, letter: t.letter, color: t.color ?? '#9aa0a6', accent: t.accent, label,
              title: tierTitle(t), onRemove: () => onToggle({ id: t.model, name: t.name ?? label }, false) }
          })} />
        <input ref={inputRef} className="orr-search" type="search"
          placeholder="search the catalog — name, vendor, id…"
          aria-label="search OpenRouter models"
          value={q} onChange={(e) => { setQ(e.target.value); setOffset(0) }} />
        {/* ordering controls (user spec 2026-09-04): a sort dropdown, and a
            group-by-provider checkbox PERPENDICULAR to it — grouping makes
            the vendor the primary key and leaves the chosen sort as the
            secondary one, so the two compose instead of competing. */}
        <div className="orr-sortbar">
          <label>
            <span className="dim">sort</span>
            <select value={sort} aria-label="sort the catalog"
              onChange={(e) => {
                const s = e.target.value as OpenRouterSort
                setSort(s); setOffset(0)
                // each sort has a useful end: cheapest first for a price,
                // newest first for a date. Carrying the previous direction
                // across would land the user on "the dearest models".
                setOrder(s === 'recency' ? 'desc' : 'asc')
              }}>
              <option value="relevance">best match</option>
              <option value="input">input price</option>
              <option value="output">output price</option>
              <option value="recency">release date</option>
            </select>
          </label>
          {sort !== 'relevance' && (
            <button type="button" className="orr-dir"
              title={`showing ${DIR_LABEL[sort][order]} — click to reverse`}
              aria-label={`sort direction: ${DIR_LABEL[sort][order]}`}
              onClick={() => { setOrder(order === 'asc' ? 'desc' : 'asc'); setOffset(0) }}>
              {order === 'asc' ? '↑' : '↓'} {DIR_LABEL[sort][order]}
            </button>
          )}
        </div>
        <SetToggle label="group by provider" checked={grouped}
          hint="Show models under a heading for each provider."
          onChange={next => { setGrouped(next); setOffset(0) }} />
        {/* ⚠ an explicit sort DISPLACES the id-over-name relevance ranking.
            Saying so beats letting the rows quietly stop answering what was
            typed — and the way back is one click, not a puzzle. */}
        {page?.relevance_displaced && (
          <div className="orr-note dim">
            ordered by {SORT_LABEL[page.sort]}, not by how well rows match “{page.query}”
            {' '}<button type="button" className="linkish"
              onClick={() => { setSort('relevance'); setOffset(0) }}>
              sort by best match</button>
          </div>
        )}
        {/* costs nothing to say, and it turns "we added a sort" into "we
            labelled the order you already had" */}
        {page && sort === 'recency' && order === 'desc' && !page.relevance_displaced && (
          <div className="orr-note dim">newest first — the catalog's own order</div>
        )}
        {err && <div className="ask-warn">could not read the catalog: {err}</div>}
        <div className="orr-list">
          {!page && !err && <div className="dim">reading the catalog…</div>}
          {page && !page.items.length && <div className="dim">no models match</div>}
          {page?.items.map((m, i) => {
            const on = selected.has(m.id)
            // a group heading is drawn when the vendor changes. At the TOP of
            // a page the comparison is against `prev_vendor` — the row before
            // this page — so a group split across a page boundary says
            // "continued" instead of pretending to start again there.
            const before = i === 0 ? page.prev_vendor : page.items[i - 1]?.vendor
            const head = page.group_by_vendor && m.vendor !== before
            const cont = page.group_by_vendor && i === 0 && m.vendor === before
            return (
              <Fragment key={m.id}>
              {head && <div className="orr-vendor">{m.vendor}</div>}
              {cont && <div className="orr-vendor">{m.vendor} <span className="dim">· continued</span></div>}
              <button type="button"
                className={'orr-row' + (on ? ' on' : '')}
                /* the dim line below prints the note only where it is
                   news (declared-tool-less, or unknown), keeping the
                   density the user asked for across ~425 rows; the
                   tooltip states it for ALL THREE so a row with no
                   visible note is never ambiguous about which it is —
                   and carries all three declarations (tools, image
                   input, reasoning parameter) since unit C. */
                title={capabilityNotes(m)}
                aria-pressed={on} disabled={busy}
                onClick={() => onToggle(m, !on)}>
                {/* the card drops to the 26px size the favorites row uses:
                    at the compressed height a 34px card was the tallest
                    thing in the row and set the floor for every other one */}
                <ModelCard letter={m.letter} color={m.color} accent={m.accent} />
                <span className="orr-name">
                  {/* the display forms (user ask 2026-09-03): the name without
                      its `Vendor: ` prefix, the id without its namespace; the
                      vendor stands alone on the dim line, so two vendors'
                      same-named models still read apart */}
                  <b>{m.name}</b>
                  <span className="dim">{m.vendor} · {m.label ?? modelLabel(m.id)}
                    {m.context ? ` · ${ctxK(m.context)} ctx` : ''}
                    {/* the sort key is shown while it is IN FORCE: a recency
                        sort the user cannot check is a recency sort the user
                        has to take on faith */}
                    {sort === 'recency' && m.created ? ` · ${released(m.created)}` : ''}
                    {/* was `!m.tools ? ' · no tool use' : ''}`, which printed
                        the SAME thing for a model the catalog declared
                        tool-less and one it said nothing readable about.
                        Three states, one shared formatter. */}
                    {m.tools === true ? '' : ` · ${capabilityNote('tools', m.tools)}`}
                    {/* image input inline on the same rule — news when
                        declared-not or unknown, silent when supported.
                        The reasoning parameter stays title-only here
                        (reviewer decision, unit C): the picker is dense. */}
                    {m.image === true ? '' : ` · ${capabilityNote('image', m.image)}`}
                  </span>
                </span>
                {/* ONE line, was three. The price cell was the tallest thing
                    in the row — "$2 in / $10 out / per 1M" stacked — so it is
                    what had to give for the density the user asked for. The
                    "per 1M" line is the only thing dropped; it is the same
                    for every row, so it moved to the cell's tooltip rather
                    than being repeated 25 times down the page. */}
                <span className="orr-price" title="$ per 1M tokens">
                  {m.free ? 'free'
                    : <>{knownPerM(m.prompt, m.price_unknown, 'prompt')} in · {' '}
                      {knownPerM(m.completion, m.price_unknown, 'completion')} out</>}
                </span>
                <span className="orr-check">{on ? '✓ selected' : 'select'}</span>
              </button>
              </Fragment>
            )
          })}
        </div>
        <BrowserPager offset={offset} size={PAGE} shown={page ? page.items.length : null} total={total}
          onOffset={setOffset} onDone={onClose} />
    </PinFrame>
  )
}
