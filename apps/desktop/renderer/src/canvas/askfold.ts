// canvas/askfold.ts — which request cards the user folded away.
//
// USER 2026-10-29 08:14:03Z mece9d7b275c2: "add collapsible request cards"
// (docket collapsible-request-cards-questions-on-the-user-s). Every request
// card the user answers (a question, a mixed batch with its credit and scope
// tabs, a credit request) and the resolved card a request leaves behind has a
// fold control in its header (asks.tsx). Folded, the card keeps one line: who
// asks, the linked ticket and the first line of the question, or the names of
// its tabs.
//
// ONE STATE PER REQUEST, NOT PER SURFACE. The desk, the inbox, the Attention
// view and the docket draw the same card, so folding it in one folds it in
// all: the user decides once. The key is the organization and the request id,
// which the engine keeps when the request resolves, so a folded request stays
// folded as its answered or withdrawn card.
//
// WHERE IT LIVES. This origin's localStorage, per organization, as the desk's
// tabs and drafts do: it survives a reload and a restart, because the engine
// keeps its port and so the origin. A moved origin or a new profile loses it,
// and every card is then expanded, which is the default. Windows share the
// store through the `storage` event. At most ASK_FOLD_KEEP folds are kept per
// organization; the oldest go first.
//
// WHAT "CHANGED" MEANS. A fold records the request's content signature: its
// questions, options and tickets, its credit numbers and its scope items. Not
// its status, answers, decisions or revision stamps, so resolving a request is
// not a change and neither is a revision bump that left the questions alone.
// When a folded card is amended (a tab added, a question rewritten), it stays
// folded and says it changed. Unfolding clears that, and folding again records
// the content the card has now.
//
// NOTHING HERE ANSWERS. Folding hides the answer controls and leaves every
// draft where it was. Only the card's own submit, ✕ and outcome buttons send
// anything, and none of them can be reached while it is folded.

import { useSyncExternalStore } from 'react'
import type { AskInfo } from '../types'

const KEY = 'orgtree-ask-folds-'
/** the most folds kept per organization; the oldest are dropped first */
export const ASK_FOLD_KEEP = 200

/** one folded request: the content signature it had, and when it was folded */
interface Fold { s: string; t: number }
type Folds = Record<string, Fold>

const cache = new Map<string, Folds>()
/** where folds go when storage refuses them (private mode, quota) */
const fallback = new Map<string, Folds>()
const listeners = new Set<() => void>()
let version = 0

function parse(raw: string | null): Folds {
  let value: unknown
  try { value = JSON.parse(raw ?? '{}') } catch { return {} }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Folds = {}
  for (const [id, fold] of Object.entries(value as Record<string, unknown>)) {
    const f = fold as Partial<Fold> | null
    if (f && typeof f.s === 'string' && typeof f.t === 'number') out[id] = { s: f.s, t: f.t }
  }
  return out
}

function read(slug: string): Folds {
  const kept = fallback.get(slug)
  if (kept) return { ...kept }
  try { return parse(localStorage.getItem(KEY + slug)) } catch { return {} }
}

function folds(slug: string): Folds {
  let m = cache.get(slug)
  if (!m) {
    m = read(slug)
    cache.set(slug, m)
  }
  return m
}

function changed(): void {
  version++
  listeners.forEach((l) => l())
}

/** One request's change, made on what storage holds NOW: another window may
 *  have folded or unfolded other requests since this copy was read. */
function write(slug: string, id: string, fold: Fold | null): void {
  const m = read(slug)
  if (fold) m[id] = fold
  else delete m[id]
  const ids = Object.keys(m)
  if (ids.length > ASK_FOLD_KEEP) {
    ids.sort((a, b) => m[a]!.t - m[b]!.t)
    for (const old of ids.slice(0, ids.length - ASK_FOLD_KEEP)) delete m[old]
  }
  try {
    if (Object.keys(m).length) localStorage.setItem(KEY + slug, JSON.stringify(m))
    else localStorage.removeItem(KEY + slug)
    fallback.delete(slug)
  } catch { fallback.set(slug, m) }
  cache.set(slug, m)
  changed()
}

/** the fold the user left on this request, if any */
export function askFold(slug: string, id: string): Fold | undefined {
  return folds(slug)[id]
}

export function foldAsk(slug: string, id: string, signature: string): void {
  write(slug, id, { s: signature, t: Date.now() })
}

/** a no-op on a request that is not folded */
export function unfoldAsk(slug: string, id: string): void {
  if (askFold(slug, id)) write(slug, id, null)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    // a null key is storage being cleared
    if (e.key !== null && !e.key.startsWith(KEY)) return
    if (e.key === null) cache.clear()
    else cache.delete(e.key.slice(KEY.length))
    changed()
  })
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** re-renders the caller whenever any request is folded or unfolded, in this
 *  window or another */
export function useAskFoldVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** FNV-1a, 32 bits: a short stand-in for the content, never compared across
 *  versions of this file in any way that matters (a mismatch only shows the
 *  "changed" mark) */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

type OptionLike = string | { label?: string; description?: string }
const optionSig = (o: OptionLike) => (typeof o === 'string' ? [o, ''] : [o.label ?? '', o.description ?? ''])
interface Asked { question?: string; header?: string; options?: OptionLike[]; multi?: boolean; work_item?: string }

/** What a request asks, independent of its form and status: the open batch
 *  card and the resolved card it becomes carry the same questions, credit
 *  numbers and scope items, so they sign the same. */
export function askSignature(ask: AskInfo): string {
  const tabs = ask.tabs ?? []
  const asked: Asked[] = ask.questions?.length ? ask.questions
    : tabs.some((t) => t.kind === 'question') ? tabs.filter((t) => t.kind === 'question')
    : ask.question != null ? [{ question: ask.question, header: ask.header, options: ask.options, multi: ask.multi }]
    : []
  const credits = tabs.find((t) => t.kind === 'credits')
  const items = ask.items?.length ? ask.items : tabs.filter((t) => t.kind === 'scope').map((t) => t.item ?? { kind: '' })
  return hash(JSON.stringify([
    asked.map((q) => [q.header ?? '', q.question ?? '', !!q.multi, q.work_item ?? '', (q.options ?? []).map(optionSig)]),
    [ask.old ?? credits?.old ?? null, ask.new ?? credits?.new ?? null],
    items.map((it) => [it.kind, it.path ?? '', it.mode ?? '', it.tool ?? '', it.server ?? '']),
  ]))
}

/** The first line of a question as a folded card shows it: the first line
 *  with words on it, without the block marks that only mean something at the
 *  start of a block (a heading's #, a quote's >, a list bullet). Fence and
 *  display-math delimiter lines are skipped. Inline formatting stays for md(). */
export function firstLine(text: string | null | undefined): string {
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || /^(`{3,}|~{3,})/.test(line) || line === '$$' || /^([-*_]\s*){3,}$/.test(line)) continue
    return line.replace(/^#{1,6}\s+/, '').replace(/^(>\s*)+/, '').replace(/^([-*+]|\d+[.)])\s+/, '')
      .slice(0, 300)
  }
  return ''
}
