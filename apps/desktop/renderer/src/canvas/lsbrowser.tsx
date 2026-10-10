// canvas/lsbrowser.tsx — the Language Server model browser (user 2026-10-10:
// "if there are a lot of models to choose from, then the list after checking
// will get completely overwhelmed. i think it needs some sort of browser like
// openrouter"). The OpenRouter browser's frame and parts (modelbrowser.tsx)
// over one server's own model list: a search, filters where the server reports
// the data (size, trained window, tool use, thinking), a sort, offer or
// withdraw per model, and the offered models pinned at the top. An offered
// model carries the window agents are told, and says so where the server
// really runs it with another one.
//
// Nothing here is saved: every pick goes to `onPick`. The add form or the
// server card's edit form keeps it as a draft until its own Save; opened from
// the card's "+" (`live`), the card saves each pick at once, and a window when
// its field is left or Enter is pressed rather than at every keystroke.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LangServerProbeModel } from '../types'
import { PinFrame } from './modalpin'
import { BrowserPager, BrowserSelected, ModelCard } from './modelbrowser'
import {
  capsOf, fmtBytes, fmtTokens, LANE_CARD_COLOR, monogram, probeFacts, startWindow, windowMismatch,
} from './lsmodels'

const PAGE = 25

type Sort = 'name' | 'size' | 'context'
const DIR_LABEL: Record<Sort, Record<'asc' | 'desc', string>> = {
  name: { asc: 'A to Z', desc: 'Z to A' },
  size: { asc: 'smallest first', desc: 'largest first' },
  context: { asc: 'smallest window first', desc: 'largest window first' },
}
/** the "trained for at least" choices */
const CONTEXT_STEPS = [32768, 65536, 131072, 262144]
/** the "size up to" choices, in bytes */
const SIZE_STEPS = [4e9, 8e9, 16e9, 24e9, 48e9]

interface Row { id: string, m: LangServerProbeModel | null }

export function LangServerBrowser({ title, live, models, missing, picked, minContext, defaultContext, ollama, busy,
  reading, error, variant, onPick, onClose }: {
  title: string
  /** each pick is saved at once (the server card's "+"), not kept in a draft */
  live?: boolean
  /** what the server lists (the latest probe) */
  models: LangServerProbeModel[]
  /** offered models the server no longer lists: shown, so they can be withdrawn */
  missing?: string[]
  /** the offered models and the window agents are told (the caller's draft) */
  picked: Record<string, number>
  minContext: number
  defaultContext: number
  /** an Ollama server: the default-window caveat applies */
  ollama: boolean
  busy: boolean
  /** the server is being asked for its models */
  reading?: boolean
  error?: string | null
  /** the 64K-version button, for an Ollama model that wants one */
  variant?: (m: LangServerProbeModel) => ReactNode
  /** offer a model with this window, or withdraw it (null) */
  onPick: (id: string, window: number | null) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<Sort>('name')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const [tools, setTools] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [minCtx, setMinCtx] = useState(0)
  const [maxSize, setMaxSize] = useState(0)
  // the models offered when the browser opened lead the list; a model offered
  // now stays where it is, so a click never moves the row out from under it
  const [pinned] = useState(() => new Set(Object.keys(picked)))
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  // filters only for what this server reports
  const has = useMemo(() => ({
    size: models.some((m) => (m.size ?? 0) > 0),
    context: models.some((m) => (m.max_context ?? 0) > 0),
    tools: models.some((m) => m.tools != null || capsOf(m).length > 0),
    thinking: models.some((m) => capsOf(m).includes('thinking')),
  }), [models])

  const all = useMemo<Row[]>(() => [
    ...models.map((m) => ({ id: m.id, m })),
    ...(missing ?? []).filter((id) => !models.some((m) => m.id === id)).map((id) => ({ id, m: null })),
  ], [models, missing])
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const keep = (r: Row): boolean => {
      if (needle && ![r.id, r.m?.family, r.m?.parameters, r.m?.quantization]
        .some((v) => String(v ?? '').toLowerCase().includes(needle))) return false
      if (!r.m) return true
      if (tools && !(r.m.tools === true || capsOf(r.m).includes('tools'))) return false
      if (thinking && !capsOf(r.m).includes('thinking')) return false
      if (minCtx && (r.m.max_context ?? 0) < minCtx) return false
      if (maxSize && !((r.m.size ?? 0) > 0 && (r.m.size ?? 0) <= maxSize)) return false
      return true
    }
    const key = (r: Row): number | string =>
      sort === 'size' ? r.m?.size ?? -1 : sort === 'context' ? r.m?.max_context ?? -1 : r.id.toLowerCase()
    const cmp = (a: Row, b: Row): number => {
      const x = key(a), y = key(b)
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)
      return (order === 'asc' ? c : -c) || a.id.localeCompare(b.id)
    }
    const shown = all.filter(keep)
    return [...shown.filter((r) => pinned.has(r.id)).sort(cmp), ...shown.filter((r) => !pinned.has(r.id)).sort(cmp)]
  }, [all, q, tools, thinking, minCtx, maxSize, sort, order, pinned])
  const page = rows.slice(offset, offset + PAGE)
  const filtered = !!(q.trim() || tools || thinking || minCtx || maxSize)
  const offered = Object.keys(picked)
  const reset = () => setOffset(0)

  return (
    <PinFrame dialogLabel="Language Server model selection" kind="langserver-browser" title={title}
      panel="settings orr-picker ls-browser" close={onClose} pinnable={false}>
      <h3>{title}
        <span className="dim"> · {offered.length} offered{live ? ' · each change is saved at once' : ''}</span></h3>
      <BrowserSelected busy={busy} label="offered models"
        empty="nothing offered yet: search below and offer the models that can be hired"
        removeVerb="withdraw"
        removeTitle="withdraw: it can no longer be hired; agents already on it keep running"
        chips={offered.map((id) => ({
          key: id, letter: monogram(id), color: LANE_CARD_COLOR, label: id,
          title: `${id} · agents are told ${fmtTokens(picked[id])}`,
          onRemove: () => onPick(id, null),
        }))} />
      <input ref={inputRef} className="orr-search" type="search"
        placeholder="search the models: name, family, size…"
        aria-label="search the server's models"
        value={q} onChange={(e) => { setQ(e.target.value); reset() }} />
      <div className="orr-sortbar ls-filters">
        <label>
          <span className="dim">sort</span>
          <select value={sort} aria-label="sort the models"
            onChange={(e) => {
              const s = e.target.value as Sort
              setSort(s); reset()
              // names read A to Z; a size or a window reads largest first
              setOrder(s === 'name' ? 'asc' : 'desc')
            }}>
            <option value="name">name</option>
            {has.size && <option value="size">size</option>}
            {has.context && <option value="context">trained window</option>}
          </select>
        </label>
        <button type="button" className="orr-dir"
          title={`showing ${DIR_LABEL[sort][order]}: click to reverse`}
          aria-label={`sort direction: ${DIR_LABEL[sort][order]}`}
          onClick={() => { setOrder(order === 'asc' ? 'desc' : 'asc'); reset() }}>
          {order === 'asc' ? '↑' : '↓'} {DIR_LABEL[sort][order]}
        </button>
        {has.context && (
          <label>
            <span className="dim">trained for</span>
            <select value={minCtx} aria-label="trained window at least"
              onChange={(e) => { setMinCtx(Number(e.target.value)); reset() }}>
              <option value={0}>any window</option>
              {CONTEXT_STEPS.map((c) => <option key={c} value={c}>{fmtTokens(c)} or more</option>)}
            </select>
          </label>
        )}
        {has.size && (
          <label>
            <span className="dim">size</span>
            <select value={maxSize} aria-label="size at most"
              onChange={(e) => { setMaxSize(Number(e.target.value)); reset() }}>
              <option value={0}>any size</option>
              {SIZE_STEPS.map((b) => <option key={b} value={b}>up to {fmtBytes(b)}</option>)}
            </select>
          </label>
        )}
        {has.tools && (
          <label className="ls-check">
            <input type="checkbox" checked={tools} aria-label="tool use only"
              onChange={(e) => { setTools(e.target.checked); reset() }} />
            tool use
          </label>
        )}
        {has.thinking && (
          <label className="ls-check">
            <input type="checkbox" checked={thinking} aria-label="thinking only"
              onChange={(e) => { setThinking(e.target.checked); reset() }} />
            thinking
          </label>
        )}
      </div>
      {error && <div className="ask-warn">could not read the server's models: {error}</div>}
      {!error && (all.length > 0 || !reading) && (
        <div className="orr-note dim ls-count">
          {filtered ? `${rows.length} of ${all.length} models match` : `${all.length} model${all.length === 1 ? '' : 's'} on the server`}
          {reading ? ' · asking the server again…' : ''}
        </div>
      )}
      <div className="orr-list">
        {reading && !all.length && <div className="dim">asking the server…</div>}
        {!reading && !error && !all.length && <div className="dim">the server lists no models</div>}
        {all.length > 0 && !rows.length && <div className="dim">no models match</div>}
        {page.map((r) => {
          const on = r.id in picked
          const w = picked[r.id]
          const mismatch = on && w != null ? windowMismatch(w, r.m, ollama) : null
          return (
            <div key={r.id} className={'orr-row ls-brow' + (on ? ' on' : '')}>
              <ModelCard letter={monogram(r.id)} color={LANE_CARD_COLOR} />
              <span className="orr-name">
                <b className="mono">{r.id}</b>
                <span className="dim" title={r.m ? probeFacts(r.m) : undefined}>
                  {r.m ? probeFacts(r.m) || 'the server says nothing more about it' : 'the server no longer lists it'}</span>
                {mismatch && <span className="ask-warn ls-mismatch">{mismatch}</span>}
              </span>
              {on && w != null
                ? <WindowInput id={r.id} value={w} min={minContext} busy={busy} live={live}
                  onChange={(v) => onPick(r.id, v)} />
                : <span />}
              <button type="button" className="ls-offer" aria-pressed={on}
                disabled={busy || (!on && !r.m)}
                title={on ? 'withdraw: it can no longer be hired; agents already on it keep running' : 'offer this model to new hires'}
                onClick={() => onPick(r.id, on ? null : startWindow(r.m!, defaultContext))}>
                {on ? '✓ offered' : 'offer'}</button>
              {r.m && variant?.(r.m)}
            </div>
          )
        })}
      </div>
      <BrowserPager offset={offset} size={PAGE} shown={page.length} total={rows.length}
        onOffset={setOffset} onDone={onClose} />
    </PinFrame>
  )
}

/** the window agents are told, with the floor below which an agent cannot
 *  work. `live`: held here while typed, sent when the field is left or Enter
 *  is pressed (each sent value is saved) */
function WindowInput({ id, value, min, busy, live, onChange }: {
  id: string
  value: number
  min: number
  busy: boolean
  live?: boolean
  onChange: (w: number) => void
}) {
  const [typed, setTyped] = useState<string | null>(null)
  const tokens = (s: string): number => Math.max(0, Number(s) || 0)
  const shown = typed == null ? value : tokens(typed)
  const send = () => {
    if (typed != null && tokens(typed) !== value) onChange(tokens(typed))
    setTyped(null)
  }
  return (
    <span className="ls-window">
      <input type="number" aria-label={`${id} context window in tokens`} min={1024} step={1024}
        value={typed ?? value} disabled={busy}
        onChange={(e) => (live ? setTyped(e.target.value) : onChange(tokens(e.target.value)))}
        onBlur={live ? send : undefined}
        onKeyDown={live ? (e) => { if (e.key === 'Enter') send() } : undefined} />
      <span className="dim">tokens</span>
      {shown < min && <span className="ask-warn"
        title={`An agent's own prompt takes about 35K tokens, so it needs a window of at least ${fmtTokens(min)} to work`}>
        too small for an agent</span>}
    </span>
  )
}
