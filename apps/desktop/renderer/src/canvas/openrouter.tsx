import { PinFrame } from './modalpin'
// canvas/openrouter.tsx — the OpenRouter lane's settings surface (user spec
// 2026-09-02, verbatim intent):
//
//   · key entry in the providers list (App settings → Providers);
//   · once a key is registered, a separate ROW of model-card icons (the
//     favorites) appears below it — the row highlights as one control, and
//     clicking it opens the MODEL SELECTION modal;
//   · the modal searches the catalog, shows a page of results at a time (the
//     original spec said 5–10; superseded 2026-09-04 — see `PAGE`), each with
//     its icon card, full name, provider (vendor) and cost per 1M tokens in
//     and out; selecting/deselecting adds/removes the model from the row;
//   · the favorites are the models whose TOKENS (chips) can be hired.
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
import type { CSSProperties, ReactNode } from 'react'
import {
  clearOpenRouterKey, getOpenRouter, searchOpenRouterModels, setOpenRouterFavorite,
  setOpenRouterKey,
} from '../api'
import { AutorenewIcon, CheckIcon, CloseIcon, DeleteIcon, EditIcon } from '../icons'
import type {
  OpenRouterDoc, OpenRouterModel, OpenRouterModelsPage, OpenRouterSort,
  ProviderInfo, ProviderTier,
} from '../types'
import { capabilityNote, capabilityNotes, fmtCredits, isDarkTierColor, modelLabel, setOpenRouterTiers } from './shared'
import { fmtHm, fmtMonth } from '../timefmt'

type ToastFn = (lines: string[]) => void

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

/** the monogram card: letter on colour. One element, styled through `--orr-c`
 *  so the sheet owns every derived shade (border, wash) from one value — plus
 *  `--orr-a`, the rim, on a DARK card whose vendor serves an accent (the
 *  brand palette, 2026-09-03): a near-black fill cannot carry identity, so
 *  the rim does. A light card never draws one; a malformed one is ignored. */
export function ModelCard({ letter, color, accent, title, large }: {
  letter: string
  color: string
  accent?: string | null
  title?: string
  large?: boolean
}) {
  const dark = isDarkTierColor(color)
  const style: Record<string, string> = { '--orr-c': color }
  if (dark && accent && /^#[0-9a-f]{6}$/i.test(accent)) style['--orr-a'] = accent
  return (
    <span className={'orr-card' + (large ? ' lg' : '') + (dark ? ' dark' : '')}
      title={title} style={style as CSSProperties} aria-hidden={!title}>
      {letter}
    </span>
  )
}

/** the card's tooltip: the label the hire surfaces print, the full display
 *  name, the vendor (once — it is no longer part of either name), prices, seat */
const tierTitle = (t: ProviderTier): string =>
  `${t.label ?? modelLabel(t.model)} · ${t.name ?? ''} — ${t.vendor ?? ''} · `
  + `${knownPerM(t.prompt, t.price_unknown, 'prompt')} in / `
  + `${knownPerM(t.completion, t.price_unknown, 'completion')} out per 1M`
  + `${t.price_unknown?.length ? ' · incomplete catalog pricing' : ''}`
  + ` · seat ${fmtCredits(t.seat)}`
  + ` · ${capabilityNotes(t)}`

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
  const [replacing, setReplacing] = useState(false)

  const adopt = (d: OpenRouterDoc) => {
    setDoc(d); setErr(null)
    setOpenRouterTiers(d.tiers)
  }
  const load = (force = false) => getOpenRouter(force).then(adopt)
    .catch((e: Error) => setErr(e.message))
  useEffect(() => { void load() }, [])

  const run = (p: Promise<OpenRouterDoc>, ok: string) => {
    setBusy(true)
    p.then((d) => { adopt(d); if (ok) toast([ok]); onChanged?.() })
      .catch((e: Error) => toast([`error: ${e.message}`]))
      .finally(() => setBusy(false))
  }
  const saveKey = () => {
    const k = keyDraft.trim()
    if (!k) return
    run(setOpenRouterKey(k), 'OpenRouter key saved')
    setKeyDraft(''); setReplacing(false)
  }

  const off = provider?.user_enabled === false
  const keySet = !!doc?.key_set
  const favorites = doc?.tiers ?? []
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
        <span className="dim"> · REST API, runs on Claude Code</span>
        <span className="set-head-right">
          {!off && keySet && !provider?.hire_enabled
            && <span className="acct-preview-tag">preview</span>}
          {headRight}
        </span>
      </div>

      {err && <div className="dim acct-prov-note">could not read OpenRouter state: {err}</div>}
      {!doc && !err && <div className="dim acct-prov-note">reading OpenRouter state…</div>}

      {/* the ENTRY row — the Claude section's "paste a new key" row, same
          columns: ghost grip · field · ✓ spanning the two button columns
          (+ ✕ while replacing, so the current key is kept with one click) */}
      {doc && (!keySet || replacing) && (
        <div className="acct-line">
          <span className="acct-gutter" />
          <div className="acct-row acct-new orr-keyrow">
            <div className="acct-main">
              <span className="acct-grip acct-ghost">⠿</span>
              <input type="password" autoComplete="off" spellCheck={false}
                placeholder={replacing
                  ? 'paste the new OpenRouter API key'
                  : 'paste an OpenRouter API key (sk-or-…)'}
                aria-label="OpenRouter API key"
                value={keyDraft} disabled={busy}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveKey() }} />
              <button className="acct-btn acct-add"
                title={replacing ? 'replace the key' : 'set the key'}
                disabled={busy || !keyDraft.trim()} onClick={saveKey}>
                <CheckIcon fontSize="inherit" /></button>
              {replacing && <button className="acct-btn" title="keep the current key"
                disabled={busy}
                onClick={() => { setReplacing(false); setKeyDraft('') }}>
                <CloseIcon fontSize="inherit" /></button>}
            </div>
            <div className="acct-provenance">
              <span>stored on this machine, never shown again</span>
              <span>get one at openrouter.ai/keys</span>
            </div>
          </div>
        </div>
      )}

      {/* the KEY row — identity + verdict, then the credit standing, then
          three icon buttons: re-check · replace · forget */}
      {doc && keySet && !replacing && (
        <div className="acct-line">
          <span className="acct-gutter" />
          <div className="acct-row orr-keyrow">
            <div className="acct-main">
              <span className="acct-grip acct-ghost">⠿</span>
              <span className="acct-email orr-standing"
                title={[`${doc.label ?? 'OpenRouter key'} · ${verdict}`,
                  ...(doc.connected ? standing : [doc.reason ?? ''])]
                  .filter(Boolean).join(' · ')}>
                {doc.label ?? 'OpenRouter key'}
                <span className={verdictClass}> · {verdict}</span>
              </span>
              <button className="acct-btn"
                title="re-check the key and its credit standing at openrouter.ai"
                disabled={busy} onClick={() => run(getOpenRouter(true), '')}>
                <AutorenewIcon fontSize="inherit" /></button>
              <button className="acct-btn" title="replace the key — the favorites stay"
                disabled={busy} onClick={() => setReplacing(true)}>
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
          </div>
        </div>
      )}

      {/* the favorites ROW — one control (user spec): highlight on hover /
          focus, click opens the picker. Rendered only once a key exists. */}
      {doc && keySet && (
        <button type="button"
          className={'orr-favs' + (pickerOpen ? ' on' : '')}
          aria-haspopup="dialog" aria-expanded={pickerOpen}
          title="choose which OpenRouter models can be hired"
          onClick={() => setPickerOpen(true)}>
          {favorites.map((t) => (
            <ModelCard key={t.tier} letter={t.letter} color={t.color ?? '#9aa0a6'}
              accent={t.accent} title={tierTitle(t)} />
          ))}
          <span className="orr-hint">
            {favorites.length
              ? `${favorites.length} model${favorites.length === 1 ? '' : 's'} hireable · click to change`
              : '+ pick the models that can be hired'}
          </span>
        </button>
      )}
      {doc && keySet && !off && provider?.reason && provider.hire_enabled === false
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
  const from = total ? offset + 1 : 0
  const to = page ? Math.min(offset + page.items.length, total) : 0
  return (
    <PinFrame dialogLabel="OpenRouter model selection" kind="openrouter-picker" title="OpenRouter models" panel="settings orr-picker" close={onClose} pinnable={false}>
        <h3>OpenRouter models
          <span className="dim"> · {doc.tiers.length} selected</span></h3>
        {/* the SELECTED list: the same models the section's favorites row
            shows, here as editable chips — card, label, ✕. Order is the
            user's own (the doc's), so a chip stays where it was. */}
        <div className="orr-selected" role="group" aria-label="selected models">
          {!doc.tiers.length && (
            <span className="dim">nothing selected yet — search below and select the models that can be hired</span>
          )}
          {doc.tiers.map((t) => {
            const label = t.label ?? modelLabel(t.model)
            return (
              <span key={t.tier} className="orr-sel" title={tierTitle(t)}>
                <ModelCard letter={t.letter} color={t.color ?? '#9aa0a6'} accent={t.accent} />
                <span className="orr-sel-name">{label}</span>
                <button type="button" className="orr-sel-x" disabled={busy}
                  aria-label={`deselect ${label}`}
                  title="deselect — it can no longer be hired; agents already on it keep running"
                  onClick={() => onToggle({ id: t.model, name: t.name ?? label }, false)}>
                  <CloseIcon fontSize="inherit" />
                </button>
              </span>
            )
          })}
        </div>
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
          <label className="orr-group" title="show the models under a heading per provider">
            <input type="checkbox" checked={grouped}
              onChange={(e) => { setGrouped(e.target.checked); setOffset(0) }} />
            <span>group by provider</span>
          </label>
        </div>
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
        <div className="orr-pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ‹ prev</button>
          <button disabled={!page || to >= total} onClick={() => setOffset(offset + PAGE)}>
            next ›</button>
          <span className="dim">{total ? `${from}–${to} of ${total}` : ''}</span>
          <button className="primary" type="button" onClick={onClose}>done</button>
        </div>
    </PinFrame>
  )
}
