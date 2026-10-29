import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode, RefObject } from 'react'
import type { TreeNode, TreePayload, UserMentionInfo } from '../types'
import { markMentionSeen, req } from '../api'
import { TierChip } from './identity'
import { stripMarkdownCode } from './shared'
import { useContextMenu, copyToClipboard } from './contextmenu'
import type { MenuEntry } from './contextmenu'
import { orgMenuEntries, orgTitle } from './orgidentity'
import { requestOpenOrg } from '../shell/openorg'
import { DocIcon, DocketIcon } from '../icons'
import { objectTooltipProps } from './objecttooltip'
import { refToken } from './reflinks'
import { loadMoreMentions, SEARCH_KINDS, useMentionSearch } from './mentionsearch'
import type { SearchKind } from './mentionsearch'
import { RefMark } from './refmarks'
import type { MentionRow } from '../api'
import { NetMark, NetName, ensureNetPicture, hubAddressTitle, netChipClass, netChipLabel, netMention, orgNetAddress, splitScheme, useNetMentionState } from './netmentions'

export interface MentionCandidate {
  id: string
  tier: string
  kind: 'agent' | 'project' | 'ticket' | 'presentation' | 'app' | 'panel'
  /** a ticket's, presentation's, app's or panel's org: completing it inserts its reference */
  org?: string
  /** the name shown and matched as well as the id: a ticket's or
   *  presentation's title, an app's name, a panel's "<app> · <label>" */
  title?: string
  /** the latest of its last mention, use or presenting (ms), when known */
  at?: number
}

/** What completing a candidate inserts: `@<name>` for an agent or project,
 *  else the thing's reference: `@item:<org>/<slug>`, `@doc:<org>/<slug>`,
 *  `@app:<org>/<slug>` or `@panel:<org>/<slug>` (the forms Copy reference
 *  copies). */
export function mentionText(c: MentionCandidate): string {
  if (c.kind === 'ticket' && c.org) return refToken({ kind: 'item', org: c.org, id: c.id })
  if (c.kind === 'presentation' && c.org) return refToken({ kind: 'doc', org: c.org, id: c.id })
  if ((c.kind === 'app' || c.kind === 'panel') && c.org) return refToken({ kind: c.kind, org: c.org, id: c.id })
  return `@${c.id}`
}

/** One entry's identity in the list: a ticket and an agent may share a name. */
const mentionKey = (c: MentionCandidate): string => c.kind + ':' + c.id

/** A kind prefix narrows the list to that kind and lists all of it, newest
 *  first (USER 2026-10-27 mdb3b4aef1062 "if i write @doc: then it should list
 *  all presentations, if i write @item: it should list all tickets, and if i
 *  write @agent: it should list all agents"; m35d9b7cf74f6 "Yes, all kinds").
 *  One line per kind: agents and projects come from the window's own tree,
 *  the rest from the engine's bounded read (`search`, mentionsearch.ts). */
export const MENTION_PREFIXES: Readonly<Record<string, { kind: MentionCandidate['kind']; search?: SearchKind }>> = {
  agent: { kind: 'agent' },
  project: { kind: 'project' },
  item: { kind: 'ticket', search: 'item' },
  doc: { kind: 'presentation', search: 'doc' },
  app: { kind: 'app', search: 'app' },
  panel: { kind: 'panel', search: 'panel' },
}
/** each kind's own reference, as a transcript names it (extractMentionRecency) */
const OWN_TOKEN: Partial<Record<MentionCandidate['kind'], string>> = { ticket: 'item', presentation: 'doc', app: 'app', panel: 'panel' }

/** An engine row as a list entry. */
function rowCandidate(r: MentionRow, org: string): MentionCandidate {
  const kind = r.kind === 'item' ? 'ticket' : r.kind === 'doc' ? 'presentation' : r.kind
  return { id: r.id, kind, tier: kind, org, title: r.label, at: Date.parse(r.at) || 0 }
}

type NodeActivity = { created?: string; last_status?: { at?: unknown } | null; inflight_at?: string | null; turns?: readonly { at: string }[] }
/** When a node last worked, as far as the window knows: its newest turn,
 *  status report or turn in flight, else its creation (ms; 0 when unknown). */
export function nodeActivity(n: NodeActivity): number {
  let at = 0
  const take = (s: unknown) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; if (t > at) at = t }
  take(n.created); take(n.last_status?.at); take(n.inflight_at)
  for (const t of n.turns ?? []) take(t.at)
  return at
}

const orgCandidates = new Map<string, MentionCandidate[]>()
const candidateListeners = new Set<() => void>()
let lastActiveOrg = ''

function notifyCandidates() {
  for (const fn of candidateListeners) fn()
}

export function liveMentionCandidatesFromTree(tree?: TreePayload | null): MentionCandidate[] {
  if (!tree?.roots) return []
  const out: MentionCandidate[] = []
  const seen = new Set<string>()
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.id && n.id !== 'user' && n.state === 'live' && !seen.has(n.id)) {
        seen.add(n.id)
        const kind = n.kind === 'project' ? 'project' : 'agent'
        out.push({ id: n.id, tier: kind === 'project' ? 'project' : (n.tier || 'haiku'), kind, at: nodeActivity(n) })
      }
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree.roots)
  return out
}

export function liveMentionCandidatesFromMap(
  map?: ReadonlyMap<string, { id: string; state?: string; tier?: string | null; kind?: string } & NodeActivity> | null,
): MentionCandidate[] {
  if (!map) return []
  const out: MentionCandidate[] = []
  const seen = new Set<string>()
  for (const n of map.values()) {
    if (n.id && n.id !== 'user' && n.state === 'live' && !seen.has(n.id)) {
      seen.add(n.id)
      const kind = n.kind === 'project' ? 'project' : 'agent'
      out.push({ id: n.id, tier: kind === 'project' ? 'project' : (n.tier || 'haiku'), kind, at: nodeActivity(n) })
    }
  }
  return out
}

export function setOrgMentionCandidates(org: string, candidates: MentionCandidate[]): void {
  if (!org) return
  lastActiveOrg = org
  orgCandidates.set(org, candidates)
  notifyCandidates()
}

export function useOrgMentionCandidates(
  org?: string | null,
  tree?: TreePayload | null,
  map?: ReadonlyMap<string, { id: string; state?: string; tier?: string | null; kind?: string } & NodeActivity> | null,
): MentionCandidate[] {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump(n => n + 1)
    candidateListeners.add(fn)
    return () => { candidateListeners.delete(fn) }
  }, [])
  const treeCandidates = useMemo(() => tree ? liveMentionCandidatesFromTree(tree) : null, [tree])
  const mapCandidates = useMemo(() => !tree && map ? liveMentionCandidatesFromMap(map) : null, [tree, map])
  useEffect(() => {
    const slug = tree?.slug || org || ''
    if (slug && treeCandidates) setOrgMentionCandidates(slug, treeCandidates)
    else if (slug && mapCandidates) setOrgMentionCandidates(slug, mapCandidates)
  }, [org, tree?.slug, treeCandidates, mapCandidates])
  if (treeCandidates) return treeCandidates
  if (mapCandidates) return mapCandidates
  const key = org || lastActiveOrg
  return key ? orgCandidates.get(key) ?? [] : []
}

export interface MentionQueryMatch {
  /** the text matched against names and ids (after a kind prefix and any org) */
  query: string
  start: number
  end: number
  /** the kind a prefix (`@doc:`) narrowed the list to */
  kind?: MentionCandidate['kind']
}

/** Match an active `@<prefix>` token immediately before `caret`, or a kind
 *  prefix being typed (`@doc:`, `@doc:week`, `@doc:<org>/week`; MENTION_PREFIXES).
 *  Bare words never match; email-like `a@b` tokens and other `@word:` forms
 *  (`@net:`) never match. */
export function matchMentionQuery(value: string, caret: number): MentionQueryMatch | null {
  const pos = Math.max(0, Math.min(value.length, caret))
  const before = value.slice(0, pos)
  const m = /(?:^|[\s([{<"'`])@(?:([a-z]+):([a-z0-9._@/-]*)|([a-z0-9._@-]*))$/i.exec(before)
  if (!m) return null
  if (m[1] !== undefined) {
    const prefix = m[1].toLowerCase()
    const kind = MENTION_PREFIXES[prefix]?.kind
    if (!kind) return null
    const raw = m[2] ?? ''
    return { query: raw.slice(raw.lastIndexOf('/') + 1), start: pos - raw.length - prefix.length - 2, end: pos, kind }
  }
  const query = m[3] ?? ''
  const start = pos - query.length - 1
  return { query, start, end: pos }
}

const TRANSCRIPT_MENTION_RE = /@(?:(agent|project|item|doc|app|panel):([a-z0-9-]+)\/([a-z0-9-]+(?:@[0-9]+)?)|([a-z0-9][a-z0-9_-]*(?:@[0-9]+)?))/gi

function isLeftBoundary(s: string, atIndex: number, lastEnd: number): boolean {
  if (atIndex <= 0 || atIndex === lastEnd) return true
  return !/[0-9A-Za-z._%+-]/.test(s[atIndex - 1]!)
}

function isRightBoundary(s: string, endIndex: number): boolean {
  if (endIndex >= s.length) return true
  const next = s[endIndex]!
  if (/[0-9A-Za-z_/-]/.test(next)) return false
  if (next === '@' && !/^@(?:item|doc|agent|project|app|panel|mail):/i.test(s.slice(endIndex))) return false
  if (next === '.' && endIndex + 1 < s.length && /[0-9A-Za-z]/.test(s[endIndex + 1]!)) return false
  return true
}

/** Extract mention recency (candidate id -> monotonic sequence number, higher = more recent)
 *  from loaded transcript message texts in chronological order (oldest to newest). */
export function extractMentionRecency(texts: Iterable<string>): ReadonlyMap<string, number> {
  const recency = new Map<string, number>()
  let seq = 0
  for (const raw of texts) {
    if (!raw || !raw.includes('@')) continue
    const s = stripMarkdownCode(raw)
    if (!s.includes('@')) continue
    TRANSCRIPT_MENTION_RE.lastIndex = 0
    let lastEnd = -1
    let m: RegExpExecArray | null
    while ((m = TRANSCRIPT_MENTION_RE.exec(s)) !== null) {
      const idx = m.index
      const end = idx + m[0].length
      if (!isLeftBoundary(s, idx, lastEnd) || !isRightBoundary(s, end)) {
        TRANSCRIPT_MENTION_RE.lastIndex = idx + 1
        continue
      }
      lastEnd = end
      if (m[1]) {
        const kind = m[1].toLowerCase()
        const org = m[2]!.toLowerCase()
        const id = m[3]!.toLowerCase()
        seq += 1
        recency.set(id, seq)
        recency.set(`${kind}:${org}/${id}`, seq)
      } else if (m[4]) {
        const id = m[4].toLowerCase()
        if (id !== 'user') {
          seq += 1
          recency.set(id, seq)
        }
      }
    }
  }
  return recency
}

/** The entries matching `query`, best first. Every typed word must appear in
 *  the entry's name or id (a slug's words find it, as a title's do). Things
 *  mentioned in the open conversation come first, the latest mention first;
 *  then everything else newest first by the latest of its last mention (in
 *  mail, by anyone: `mentioned`, for agents and projects; the engine folds it
 *  in for the rest), use or presenting, then by name (USER 2026-10-27
 *  m79e889ce1609 "and ofc sort all items by most recently mentioned / operated
 *  on / presented"). Typing narrows the list; it never reorders it. */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
  recency?: ReadonlyMap<string, number> | null,
  mentioned?: ReadonlyMap<string, number> | null,
): MentionCandidate[] {
  const words = query.toLowerCase().split(/[-_./\s]+/).filter(Boolean)
  const inTranscript: Array<{ c: MentionCandidate; seq: number }> = []
  const rest: Array<{ c: MentionCandidate; at: number; name: string }> = []
  for (const c of candidates) {
    const id = c.id.toLowerCase()
    const name = (c.title ?? c.id).toLowerCase()
    if (!words.every(w => name.includes(w) || id.includes(w))) continue
    // a ticket, presentation, app or panel counts as mentioned by its own reference, never by a same-named agent
    const own = OWN_TOKEN[c.kind]
    const seq = recency?.get(own ? `${own}:${(c.org ?? '').toLowerCase()}/${id}` : id)
    if (seq !== undefined) inTranscript.push({ c, seq })
    else rest.push({ c, name, at: Math.max(c.at ?? 0, own ? 0 : mentioned?.get(id) ?? 0) })
  }
  inTranscript.sort((a, b) => b.seq - a.seq)
  rest.sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || (a.c.kind < b.c.kind ? -1 : a.c.kind > b.c.kind ? 1 : 0) || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0))
  return [...inTranscript.map(x => x.c), ...rest.map(x => x.c)]
}

/** entries drawn at first, and added each time the reader nears the end */
const MENU_STEP = 60

export function useAgentMentions({
  value,
  onChange,
  setValue,
  inputRef,
  candidates,
  disabled,
  transcriptTexts,
  org,
}: {
  value: string
  onChange?: (next: string) => void
  setValue?: (next: string) => void
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  candidates: MentionCandidate[]
  disabled?: boolean
  transcriptTexts?: () => Iterable<string>
  /** the org whose docket tickets (USER 2026-10-22 18:16:44Z), presentations
   *  (USER 2026-10-27 mb21c096e5dc4), apps and panels (m042c82fb0228) the
   *  list also offers; omitted, it offers agents and projects only */
  org?: string | null
}): {
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => boolean
  syncCaret: () => void
  menu: ReactNode
  captureMention: (agentId: string | (() => string)) => (() => void) | null
  noteRightClickDown: () => void
} {
  const emit = onChange ?? setValue
  const valueRef = useRef(value)
  valueRef.current = value
  const emitRef = useRef(emit)
  emitRef.current = emit
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const transcriptTextsRef = useRef(transcriptTexts)
  transcriptTextsRef.current = transcriptTexts
  const recencySessionRef = useRef<{ start: number; recency: ReadonlyMap<string, number> } | null>(null)
  const preRightClickSnapRef = useRef<{ focused: boolean; start: number; end: number; ts: number } | null>(null)
  const [caret, setCaret] = useState(value.length)
  // `pick` holds the highlighted entry itself: tickets arrive after the list
  // opens, and an arrival must not move the highlight to another entry
  const [selection, setSelection] = useState<{ key: string | null; index: number; pick?: string }>({ key: null, index: -1 })
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [rect, setRect] = useState<MentionListPlace | null>(null)

  const syncCaret = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const next = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length
    setCaret(next)
  }, [inputRef])

  const noteRightClickDown = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const doc = el.ownerDocument ?? document
    const focused = doc.activeElement === el
    const len = el.value.length
    const start = focused && typeof el.selectionStart === 'number' ? el.selectionStart : len
    const end = focused && typeof el.selectionEnd === 'number' ? el.selectionEnd : start
    preRightClickSnapRef.current = { focused, start, end, ts: Date.now() }
  }, [inputRef])

  const captureMention = useCallback((agentId: string | (() => string)): (() => void) | null => {
    const readId = () => (typeof agentId === 'function' ? agentId() : agentId).trim().replace(/^@+/, '')
    if (!readId() || disabledRef.current) return null
    const el = inputRef.current
    if (!el || el.disabled) return null
    const doc = el.ownerDocument ?? document
    // ⚠ NOT CONSUMED: one right-click can capture twice (a ticket's own
    // Mention, then its Owner… submenu's, once the ticket has loaded), and
    // both belong at the caret it found. A second is its age limit.
    const pre = preRightClickSnapRef.current
    const usePre = Boolean(pre && Date.now() - pre.ts < 1000 && pre.focused)
    const focusedNow = doc.activeElement === el
    const wasFocused = focusedNow || usePre
    const curVal = el.value ?? valueRef.current
    const rawStart = focusedNow
      ? (typeof el.selectionStart === 'number' ? el.selectionStart : curVal.length)
      : usePre ? pre!.start : curVal.length
    const rawEnd = focusedNow
      ? (typeof el.selectionEnd === 'number' ? el.selectionEnd : rawStart)
      : usePre ? pre!.end : rawStart
    return () => {
      const id = readId()
      if (!id) return
      const target = inputRef.current
      if (!target || target.disabled || disabledRef.current) return
      const current = target.value ?? valueRef.current
      const token = `@${id} `
      let nextValue: string
      let nextCaret: number
      if (wasFocused) {
        const start = Math.max(0, Math.min(rawStart, current.length))
        const end = Math.max(start, Math.min(rawEnd, current.length))
        const before = current.slice(0, start)
        const after = current.slice(end)
        nextValue = before + token + after
        nextCaret = before.length + token.length
      } else {
        const sep = current.length > 0 && !/\s$/.test(current) ? ' ' : ''
        nextValue = current + sep + token
        nextCaret = nextValue.length
      }
      try {
        target.value = nextValue
      } catch { /* ignore */ }
      emitRef.current?.(nextValue)
      setCaret(nextCaret)
      try {
        target.focus({ preventScroll: true })
        target.setSelectionRange(nextCaret, nextCaret)
      } catch { /* ignore */ }
      queueMicrotask(() => {
        const latest = inputRef.current
        if (!latest) return
        try {
          latest.focus({ preventScroll: true })
          latest.setSelectionRange(nextCaret, nextCaret)
        } catch { /* ignore */ }
      })
    }
  }, [inputRef])

  useEffect(() => {
    const el = inputRef.current
    if (!el) {
      setCaret(value.length)
      return
    }
    const next = typeof el.selectionStart === 'number' ? el.selectionStart : value.length
    setCaret(next)
  }, [value, inputRef])

  const activeQuery = useMemo(() => matchMentionQuery(value, caret), [value, caret])
  const queryKey = activeQuery ? `${activeQuery.start}:${activeQuery.kind ?? ''}:${activeQuery.query}` : null
  const canShow = !disabled && activeQuery !== null && dismissedKey !== queryKey

  if (!canShow) {
    recencySessionRef.current = null
  } else if (recencySessionRef.current === null || recencySessionRef.current.start !== activeQuery.start) {
    const texts = transcriptTextsRef.current ? transcriptTextsRef.current() : []
    recencySessionRef.current = {
      start: activeQuery.start,
      recency: extractMentionRecency(texts),
    }
  }
  const activeRecency = recencySessionRef.current?.recency ?? null
  // Agents and projects are the window's own; tickets, presentations, apps and
  // panels come from the engine's one bounded read, ranked there. A kind
  // prefix asks for that kind only, and the read pages as the list is read.
  const prefix = activeQuery?.kind
  const searchKinds = useMemo<readonly SearchKind[] | null>(() => {
    if (!prefix) return SEARCH_KINDS
    const search = Object.values(MENTION_PREFIXES).find(p => p.kind === prefix)?.search
    return search ? [search] : null
  }, [prefix])
  const searchText = canShow && activeQuery && org ? activeQuery.query : null
  const found = useMentionSearch(org, searchKinds, searchText)
  const offered = useMemo(() => {
    const local = prefix ? candidates.filter(c => c.kind === prefix) : candidates
    return found.rows.length && org ? [...local, ...found.rows.map(r => rowCandidate(r, org))] : local
  }, [candidates, found.rows, prefix, org])
  const [shown, setShown] = useState(MENU_STEP)

  useEffect(() => {
    if (selection.key !== null && selection.key !== queryKey) {
      setSelection({ key: null, index: -1 })
    }
    if (dismissedKey && dismissedKey !== queryKey) setDismissedKey(null)
    setShown(MENU_STEP)
  }, [queryKey, dismissedKey, selection.key])

  const ranked = useMemo(
    () => (canShow && activeQuery ? filterMentionCandidates(offered, activeQuery.query, activeRecency, found.nodes) : []),
    [canShow, activeQuery, offered, activeRecency, found.nodes],
  )
  // drawn bottom-up (the best match last, next to the box), the oldest first
  const matches = useMemo(() => ranked.slice(0, shown).reverse(), [ranked, shown])
  const more = ranked.length > shown || found.more
  /** Nearing the oldest entry drawn: draw more, and ask the engine for its
   *  next page once the rows it sent are all drawn. */
  const extend = useCallback(() => {
    if (!more) return
    setShown(n => n + MENU_STEP)
    if (found.more && org && searchKinds && searchText !== null && ranked.length <= shown + MENU_STEP) loadMoreMentions(org, searchKinds, searchText)
  }, [more, found.more, org, searchKinds, searchText, ranked.length, shown])
  if (!matches.length) {
    recencySessionRef.current = null
  }

  const open = !disabled && matches.length > 0 && activeQuery !== null
  const picked = selection.key === queryKey && selection.pick
    ? matches.findIndex(c => mentionKey(c) === selection.pick) : -1
  const clampedIndex = matches.length === 0
    ? 0
    : picked >= 0 ? picked
    : selection.key === queryKey && selection.index >= 0 && selection.index < matches.length
      ? selection.index
      : matches.length - 1

  useLayoutEffect(() => {
    if (!open) return
    const el = inputRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const win = el.ownerDocument?.defaultView ?? window
      setRect(placeMentionList(r, win.innerHeight))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, inputRef, value])

  const complete = useCallback((candidate: MentionCandidate) => {
    if (!activeQuery) return
    const after = value.slice(activeQuery.end)
    const insert = `${mentionText(candidate)}${after.startsWith(' ') ? '' : ' '}`
    const nextValue = value.slice(0, activeQuery.start) + insert + after
    const nextCaret = activeQuery.start + insert.length
    emit?.(nextValue)
    setCaret(nextCaret)
    setDismissedKey(`${activeQuery.start}:${activeQuery.query}`)
    queueMicrotask(() => {
      const el = inputRef.current
      if (el) {
        try {
          el.focus()
          el.setSelectionRange(nextCaret, nextCaret)
        } catch { /* input may not support selectionRange */ }
      }
    })
  }, [activeQuery, value, emit, inputRef])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      const pick = matches[clampedIndex]
      if (!pick) return false
      e.preventDefault()
      e.stopPropagation()
      complete(pick)
      return true
    }
    // the arrows follow the screen: a list below its box shows the entries
    // the other way up (the best match next to the box), so they swap
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const step = (e.key === 'ArrowDown') === !rect?.below ? 1 : -1
      const next = (clampedIndex + step + matches.length) % matches.length
      setSelection({ key: queryKey, index: next, pick: mentionKey(matches[next]!) })
      // the oldest entries are drawn first: walking toward them draws more
      if (next <= 2) extend()
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setSelection({ key: null, index: -1 })
      if (queryKey) setDismissedKey(queryKey)
      return true
    }
    return false
  }, [open, matches, clampedIndex, complete, queryKey, rect?.below, extend])

  const menuRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return
    const active = menuRef.current.querySelector('.agent-mention-item.active') as HTMLElement | null
    active?.scrollIntoView?.({ block: 'nearest' })
  }, [open, clampedIndex, queryKey])
  // scrolled to the oldest end (the marker drawn before the oldest entry)
  const moreRef = useRef<HTMLDivElement | null>(null)
  const extendRef = useRef(extend)
  extendRef.current = extend
  useEffect(() => {
    const root = menuRef.current, marker = moreRef.current
    const Observer = root?.ownerDocument?.defaultView?.IntersectionObserver
    if (!open || !more || !root || !marker || !Observer) return
    const seen = new Observer(entries => { if (entries.some(e => e.isIntersecting)) extendRef.current() }, { root })
    seen.observe(marker)
    return () => seen.disconnect()
  }, [open, more, matches.length])

  const portalBody = inputRef.current?.ownerDocument?.body ?? (typeof document !== 'undefined' ? document.body : null)
  const menu = open && portalBody
    ? createPortal(
        <div
          ref={menuRef}
          className={'agent-mentions' + (rect?.below ? ' below' : '')}
          role="listbox"
          aria-label="Mentions: agents, projects, tickets, presentations, apps and panels"
          style={rect ? {
            position: 'fixed', left: rect.left, minWidth: rect.width, maxHeight: rect.maxHeight, zIndex: 10000,
            ...(rect.below ? { top: rect.top } : { bottom: rect.bottom }),
          } : undefined}
        >
          {more && <div ref={moreRef} className="agent-mention-more" aria-hidden="true" />}
          {matches.map((c, idx) => (
            <button
              key={mentionKey(c)}
              type="button"
              role="option"
              aria-selected={idx === clampedIndex}
              className={'agent-mention-item' + (c.kind === 'agent' || c.kind === 'project' ? '' : ` mention-${c.kind}`)
                + (idx === clampedIndex ? ' active on' : '')}
              // a ticket hovers with the one ticket identity every ticket link shows, a presentation with its own;
              // an app or panel with the reference it inserts
              {...(c.kind === 'ticket' ? { ...objectTooltipProps('ticket', c.id, c.org), 'aria-label': `ticket ${c.title || c.id}` }
                : c.kind === 'presentation' ? { ...objectTooltipProps('document', c.id, c.org), 'aria-label': `presentation ${c.title || c.id}` }
                  : c.kind === 'app' || c.kind === 'panel' ? { title: mentionText(c), 'aria-label': `${c.kind} ${c.title || c.id}` } : {})}
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation()
                complete(c)
              }}
            >
              {c.kind === 'ticket'
                ? <span className="mention-ticket-mark" aria-hidden="true"><DocketIcon fontSize="inherit" /></span>
                : c.kind === 'presentation'
                  ? <span className="mention-presentation-mark" aria-hidden="true"><DocIcon fontSize="inherit" /></span>
                  : c.kind === 'app' || c.kind === 'panel'
                    ? <span className={`mention-${c.kind}-mark`} aria-hidden="true"><RefMark kind={c.kind} /></span>
                    : <TierChip tier={c.kind === 'project' ? 'project' : c.tier} />}
              {/* a ticket (by its full title, USER 2026-10-27 m3eb804e5023a), presentation, app or panel is shown by
                  its name; completing it inserts its slug's reference */}
              <span className="agent-mention-name">{c.kind === 'agent' || c.kind === 'project' ? '@' + c.id : c.title || c.id}</span>
            </button>
          ))}
        </div>,
        portalBody,
      )
    : null

  return { onKeyDown, syncCaret, menu, captureMention, noteRightClickDown }
}

/** Where the @ list sits: above its box, the best match (the last entry)
 *  next to the box; or, with too little room above, below it, the other way
 *  up (`.agent-mentions.below`, column-reverse) so the best match is next to
 *  the box again. Quick chat in the window's header has no room above (alpha.5
 *  hands-on check 2026-10-27: the list opened off the top of the window). */
export interface MentionListPlace {
  left: number; width: number; maxHeight: number; below: boolean
  /** from the window's bottom edge, above the box */
  bottom?: number
  /** from the window's top edge, below the box */
  top?: number
}
/** the list's tallest (styles.css `.agent-mentions` max-height) */
export const MENTION_LIST_MAX = 220

export function placeMentionList(box: { left: number; top: number; bottom: number; width: number }, viewHeight: number): MentionListPlace {
  const room = { above: box.top - 12, below: viewHeight - box.bottom - 12 }
  // a box with no height has no layout (jsdom, a hidden composer): above, as ever
  const below = box.bottom > box.top && room.above < MENTION_LIST_MAX && room.below > room.above
  return {
    left: Math.max(8, box.left),
    width: Math.max(180, Math.min(320, box.width || 220)),
    maxHeight: Math.max(48, Math.min(MENTION_LIST_MAX, below ? room.below : room.above)),
    below,
    ...(below ? { top: box.bottom + 4 } : { bottom: Math.max(8, viewHeight - box.top + 4) }),
  }
}

export const DESK_MENTION_ATTR = 'data-desk-mention-scope'
const deskMentionScopes = new WeakMap<Element, (agentId: string | (() => string)) => (() => void) | null>()

export function useDeskMentionScope(
  captureMention: ((agentId: string | (() => string)) => (() => void) | null) | null,
  noteRightClickDown?: () => void,
) {
  const fnRef = useRef(captureMention)
  fnRef.current = captureMention
  const downRef = useRef(noteRightClickDown)
  downRef.current = noteRightClickDown
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return
    deskMentionScopes.set(el, (agentId: string | (() => string)) => (fnRef.current ? fnRef.current(agentId) : null))
  }, [])
  const onRightDown = useCallback((e: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) => {
    if (e.button === 2) downRef.current?.()
  }, [])
  return {
    ref,
    [DESK_MENTION_ATTR]: captureMention ? '' : undefined,
    onPointerDownCapture: onRightDown,
    onMouseDownCapture: onRightDown,
  }
}

export function captureDeskMentionAt(
  target: EventTarget | null,
  agentId: string | (() => string) | null | undefined,
): (() => void) | null {
  if (!agentId || !target || typeof (target as Element).closest !== 'function') return null
  const scope = (target as Element).closest(`[${DESK_MENTION_ATTR}]`)
  if (!scope) return null
  const handler = deskMentionScopes.get(scope)
  return handler ? handler(agentId) : null
}

// ------------------------------------------------------------ @net: / @org: Hub contact links

const knownOrgSlugs = new Set<string>()
let hubchatPcInstalled = false
const hubStateListeners = new Set<() => void>()
const HUBCHAT_FRESH_MS = 60_000
let hubchatCheckedAt = -Infinity
let hubchatRevision = 0
let hubchatRequest: Promise<void> | null = null
/** The Hubchat person this install links as the user (Connect your phone), as `@net:<address>` in lower case. */
let userAccount: string | null = null

// Chip consumers must discover this without the phone panel. Share one read
// across Markdown/prose/tool chips; focus refreshes a stale answer, without a
// per-chip poll or repeatedly running the engine's cached Windows probes.
function refreshHubchatInstalled(): void {
  if (hubchatRequest || Date.now() - hubchatCheckedAt < HUBCHAT_FRESH_MS) return
  hubchatCheckedAt = Date.now()
  const revision = hubchatRevision
  hubchatRequest = req<{ hubchat_pc?: unknown; link?: unknown } | null>('/api/desktop/phone')
    .then(v => {
      // A newer phone-panel read wins over this request's older snapshot.
      if (typeof v?.hubchat_pc === 'boolean' && revision === hubchatRevision) { setHubchatInstalled(v.hubchat_pc); noteUserAccountLink(v.link) }
    })
    .catch(() => { /* preserve the known state; a later focus can retry */ })
    .finally(() => { hubchatRequest = null })
}

function notifyHubState() {
  for (const fn of hubStateListeners) fn()
}

export function noteKnownOrg(slug: string | null | undefined): void {
  if (!slug || knownOrgSlugs.has(slug)) return
  knownOrgSlugs.add(slug)
  notifyHubState()
}

export function setKnownOrgs(slugs: Iterable<string>): void {
  const next = new Set<string>()
  for (const s of slugs) if (s) next.add(s)
  let changed = next.size !== knownOrgSlugs.size
  if (!changed) {
    for (const s of next) if (!knownOrgSlugs.has(s)) { changed = true; break }
  }
  if (!changed) return
  knownOrgSlugs.clear()
  for (const s of next) knownOrgSlugs.add(s)
  notifyHubState()
}

export function isKnownLocalOrg(slug: string): boolean {
  return knownOrgSlugs.has(slug)
}

export function setHubchatInstalled(installed: boolean): void {
  hubchatCheckedAt = Date.now()
  hubchatRevision++
  if (hubchatPcInstalled === installed) return
  hubchatPcInstalled = installed
  notifyHubState()
}

export function isHubchatInstalled(): boolean {
  return hubchatPcInstalled
}

export function hubchatDeepLink(address: string): string {
  return `hubchat://chat?to=${encodeURIComponent(address)}`
}

export const HUBCHAT_NOT_INSTALLED_TOOLTIP = "Hubchat isn't installed"
export const OWN_ACCOUNT_CHAT_TOOLTIP = 'Open your chat with this org in Hubchat'
export const NO_ORG_ADDRESS_TOOLTIP = 'This org has no network address yet, so there is no chat to open'

/** A phone-state read's `link` (the linked Hubchat person, or null when unlinked). A malformed or missing
 *  `link` keeps what was known, like a failed availability read. */
export function noteUserAccountLink(link: unknown): void {
  let next = userAccount
  if (link === null) next = null
  else if (typeof link === 'object') {
    const address = (link as { address?: unknown }).address
    const bare = typeof address === 'string' ? address.trim().toLowerCase().replace(/^@net:/, '') : ''
    if (bare) next = '@net:' + bare
  }
  if (next === userAccount) return
  userAccount = next
  notifyHubState()
}

/** The user's own account. Hubchat answers a self-target with the personal settings page. */
function isUserAccount(address: string): boolean {
  const a = address.trim().toLowerCase()
  return userAccount !== null && a === userAccount
}

export function resolveHubAddressAction(
  address: string,
  extraLocalOrgs?: ReadonlySet<string> | null,
): { kind: 'org'; slug: string; title: string } | { kind: 'hubchat'; url: string; title: string } | { kind: 'inert'; title: string } {
  if (address.startsWith('@org:')) {
    const slug = address.slice('@org:'.length).trim()
    if (slug && (knownOrgSlugs.has(slug) || extraLocalOrgs?.has(slug))) {
      return { kind: 'org', slug, title: orgTitle(slug) }
    }
  }
  if (hubchatPcInstalled) {
    // The user's own account opens the DM with the org the link is shown in (the org on screen: an org switch
    // remounts every surface), the place a DM with it starts when none exists; USER 2026-10-27 m17f65d1effdf.
    if (isUserAccount(address)) {
      const org = orgNetAddress()
      return org ? { kind: 'hubchat', url: hubchatDeepLink(org), title: OWN_ACCOUNT_CHAT_TOOLTIP } : { kind: 'inert', title: NO_ORG_ADDRESS_TOOLTIP }
    }
    return { kind: 'hubchat', url: hubchatDeepLink(address), title: `Open ${address} in Hubchat` }
  }
  return { kind: 'inert', title: HUBCHAT_NOT_INSTALLED_TOOLTIP }
}

export function triggerHubAddress(address: string, extraLocalOrgs?: ReadonlySet<string> | null): boolean {
  const action = resolveHubAddressAction(address, extraLocalOrgs)
  if (action.kind === 'org') {
    requestOpenOrg(action.slug)
    return true
  }
  if (action.kind === 'hubchat') {
    window.open(action.url, '_blank', 'noopener')
    return true
  }
  return false
}

/** An address in the hub's namespaces: wherever it names a party, it is drawn as `HubContactChip`. */
export const isHubAddress = (id: string): boolean => id.startsWith('@net:') || id.startsWith('@org:')

/** The link's other destination, the org inbox's view of the address (USER 2026-10-29 m14ad537c5eb8
 *  "these addresses should also be embedded hubchat / outbox links"). The canvas that owns this
 *  window's org inbox panel registers it; pins and pop-outs render in the same realm, so every
 *  surface of the window reaches it. `closed` is the org's Closed off inbox mode. */
export interface OrgInboxOpener { closed: boolean; open: (address: string) => void }
let orgInboxOpener: OrgInboxOpener | null = null
export const ORG_INBOX_CLOSED_TOOLTIP = 'The org inbox is closed off'

/** Register this window's org inbox; the returned function unregisters it. The latest registration wins. */
export function registerOrgInboxOpener(opener: OrgInboxOpener): () => void {
  orgInboxOpener = opener
  return () => { if (orgInboxOpener === opener) orgInboxOpener = null }
}

/** One contact identity menu, including its local-org resolution. Mention is
 * captured only from a real composer; Open never changes installation state.
 * Open in org inbox is offered where a canvas registered this window's org
 * inbox: a window without one (no org on screen) has no inbox to open, so the
 * entry is left out there instead of shown dead. A local org keeps its own
 * org menu. */
export function hubAddressMenuEntries(anchor: Element, address: string): MenuEntry[] {
  const action = resolveHubAddressAction(address)
  if (action.kind === 'org') return orgMenuEntries(anchor, action.slug, () => { triggerHubAddress(address) })
  const mention = captureDeskMentionAt(anchor, address)
  const inbox = orgInboxOpener
  return [...(mention ? [{ label: 'Mention', onSelect: mention }] : []),
    { label: 'Open in Hubchat', disabled: action.kind === 'inert', title: action.kind === 'inert' ? action.title : undefined,
      onSelect: () => { triggerHubAddress(address) } },
    ...(inbox ? [{ label: 'Open in org inbox', disabled: inbox.closed, title: inbox.closed ? ORG_INBOX_CLOSED_TOOLTIP : undefined,
      onSelect: () => { if (!inbox.closed) inbox.open(address) } }] : []),
    { label: 'Copy identity', title: address, onSelect: () => { void copyToClipboard(anchor, address) } }]
}

export function useHubAddressState(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick(n => n + 1)
    hubStateListeners.add(fn)
    if (hubStateListeners.size === 1) window.addEventListener('focus', refreshHubchatInstalled)
    refreshHubchatInstalled()
    return () => {
      hubStateListeners.delete(fn)
      if (!hubStateListeners.size) window.removeEventListener('focus', refreshHubchatInstalled)
    }
  }, [])
  return tick
}

export function HubContactChip({ address, className }: { address: string; className?: string }) {
  const menu = useContextMenu()
  useHubAddressState()
  useNetMentionState()
  useEffect(() => { ensureNetPicture(address) })
  const action = resolveHubAddressAction(address)
  const inert = action.kind === 'inert'
  const info = netMention(address)
  const [scheme, rest] = splitScheme(address)
  const cls = ['ref-chip', 'ref-hub', inert ? 'inert' : 'live', netChipClass(info), className].filter(Boolean).join(' ')
  return (
    <><button
      type="button"
      className={cls}
      onContextMenu={e => menu.open(e, hubAddressMenuEntries(e.currentTarget, address))}
      data-hub-address={address}
      data-hub-ref={address}
      data-net-kind={info.kind}
      data-net-icon={info.icon}
      aria-disabled={inert ? 'true' : undefined}
      aria-label={netChipLabel(info)}
      title={hubAddressTitle(address)}
      onClick={e => {
        e.stopPropagation()
        if (!inert) triggerHubAddress(address)
      }}
    >
      <NetMark info={info} />
      <span className="ref-id">{scheme && <span className="net-scheme">{scheme}</span>}{rest}</span>
      <NetName info={info} />
    </button>{menu.node}</>
  )
}

let mentionHighlightSeq = 0
const mentionSeenLocally = new Map<string, Set<string>>()
const mentionHighlights = new Map<string, { mentionId: string; eventId?: string; seq?: number }>()
const seenListeners = new Set<() => void>()

function notifySeen() {
  for (const fn of seenListeners) fn()
}

export function useSeenMentions(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick(n => n + 1)
    seenListeners.add(fn)
    return () => { seenListeners.delete(fn) }
  }, [])
  return tick
}

export function hasUnseenUserMention(
  node?: { id: string; user_mention?: UserMentionInfo | null } | null,
  slug?: string,
): boolean {
  const m = node?.user_mention
  if (!node?.id || !m?.id) return false
  const org = slug || lastActiveOrg
  const key = `${node.id}:${m.id}`
  if (org && mentionSeenLocally.get(org)?.has(key)) return false
  for (const set of mentionSeenLocally.values()) {
    if (set.has(key)) return false
  }
  return true
}

export function dismissUserMention(
  slug: string,
  nodeId: string,
  mentionId: string,
  eventId?: string,
  opts?: { highlight?: boolean },
): Promise<{ ok: boolean }> {
  const org = slug || lastActiveOrg
  let set = mentionSeenLocally.get(org)
  if (!set) {
    set = new Set()
    mentionSeenLocally.set(org, set)
  }
  set.add(`${nodeId}:${mentionId}`)
  if (opts?.highlight !== false) {
    mentionHighlightSeq += 1
    mentionHighlights.set(`${org}:${nodeId}`, { mentionId, eventId, seq: mentionHighlightSeq })
  }
  notifySeen()
  if (!org) return Promise.resolve({ ok: true })
  return markMentionSeen(org, nodeId, mentionId).catch(() => ({ ok: false }))
}

export function requestMentionHighlight(
  slug: string,
  nodeId: string,
  mentionId: string,
  eventId?: string,
): void {
  const org = slug || lastActiveOrg
  mentionHighlightSeq += 1
  mentionHighlights.set(`${org}:${nodeId}`, { mentionId, eventId, seq: mentionHighlightSeq })
  notifySeen()
}

export function useMentionHighlight(
  slug: string,
  nodeId: string,
): { mentionId: string; eventId?: string; seq?: number } | null {
  useSeenMentions()
  const org = slug || lastActiveOrg
  return mentionHighlights.get(`${org}:${nodeId}`) ?? null
}

export function clearMentionHighlight(slug: string, nodeId: string): void {
  const org = slug || lastActiveOrg
  if (mentionHighlights.delete(`${org}:${nodeId}`)) {
    notifySeen()
  }
}

export function resetSeenMentions(): void {
  mentionSeenLocally.clear()
  mentionHighlights.clear()
  mentionHighlightSeq = 0
  notifySeen()
}

