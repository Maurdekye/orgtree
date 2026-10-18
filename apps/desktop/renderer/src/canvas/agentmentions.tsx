import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode, RefObject } from 'react'
import type { TreeNode, TreePayload, UserMentionInfo } from '../types'
import { markMentionSeen } from '../api'
import { TierChip } from './identity'
import { requestOpenOrg } from '../shell/openorg'

export interface MentionCandidate {
  id: string
  tier: string
  kind: 'agent' | 'project'
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
        out.push({ id: n.id, tier: kind === 'project' ? 'project' : (n.tier || 'haiku'), kind })
      }
      if (n.children?.length) walk(n.children)
    }
  }
  walk(tree.roots)
  return out
}

export function liveMentionCandidatesFromMap(
  map?: ReadonlyMap<string, { id: string; state?: string; tier?: string; kind?: string }> | null,
): MentionCandidate[] {
  if (!map) return []
  const out: MentionCandidate[] = []
  const seen = new Set<string>()
  for (const n of map.values()) {
    if (n.id && n.id !== 'user' && n.state === 'live' && !seen.has(n.id)) {
      seen.add(n.id)
      const kind = n.kind === 'project' ? 'project' : 'agent'
      out.push({ id: n.id, tier: kind === 'project' ? 'project' : (n.tier || 'haiku'), kind })
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
  map?: ReadonlyMap<string, { id: string; state?: string; tier?: string; kind?: string }> | null,
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
  return (key && orgCandidates.get(key)) ?? []
}

export interface MentionQueryMatch {
  query: string
  start: number
  end: number
}

/** Match an active `@<prefix>` token immediately before `caret`.
 *  Bare words never match; email-like `a@b` tokens never match. */
export function matchMentionQuery(value: string, caret: number): MentionQueryMatch | null {
  const pos = Math.max(0, Math.min(value.length, caret))
  const before = value.slice(0, pos)
  const m = /(?:^|[\s([{<"'`])@([a-z0-9._@-]*)$/i.exec(before)
  if (!m) return null
  const query = m[1] ?? ''
  const start = pos - query.length - 1
  return { query, start, end: pos }
}

export function filterMentionCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.toLowerCase()
  const prefix: MentionCandidate[] = []
  const substring: MentionCandidate[] = []
  for (const c of candidates) {
    const id = c.id.toLowerCase()
    if (!q || id.startsWith(q)) prefix.push(c)
    else if (id.includes(q)) substring.push(c)
  }
  return [...prefix, ...substring]
}

export function useAgentMentions({
  value,
  onChange,
  setValue,
  inputRef,
  candidates,
  disabled,
}: {
  value: string
  onChange?: (next: string) => void
  setValue?: (next: string) => void
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  candidates: MentionCandidate[]
  disabled?: boolean
}): {
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => boolean
  syncCaret: () => void
  menu: ReactNode
} {
  const emit = onChange ?? setValue
  const [caret, setCaret] = useState(value.length)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [rect, setRect] = useState<{ left: number; bottom: number; width: number } | null>(null)

  const syncCaret = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const next = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length
    setCaret(next)
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
  const queryKey = activeQuery ? `${activeQuery.start}:${activeQuery.query}` : null

  useEffect(() => {
    setSelectedIndex(0)
    if (dismissedKey && dismissedKey !== queryKey) setDismissedKey(null)
  }, [queryKey, dismissedKey])

  const matches = useMemo(
    () => (!disabled && activeQuery && dismissedKey !== queryKey ? filterMentionCandidates(candidates, activeQuery.query) : []),
    [disabled, activeQuery, candidates, dismissedKey, queryKey],
  )

  const open = !disabled && matches.length > 0 && activeQuery !== null
  const clampedIndex = matches.length ? Math.min(selectedIndex, matches.length - 1) : 0

  useLayoutEffect(() => {
    if (!open) return
    const el = inputRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const win = el.ownerDocument?.defaultView ?? window
      setRect({
        left: Math.max(8, r.left),
        bottom: Math.max(8, win.innerHeight - r.top + 4),
        width: Math.max(180, Math.min(320, r.width || 220)),
      })
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
    const insert = `@${candidate.id}${after.startsWith(' ') ? '' : ' '}`
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
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex(i => (i + 1) % matches.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setSelectedIndex(i => (i - 1 + matches.length) % matches.length)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (queryKey) setDismissedKey(queryKey)
      return true
    }
    return false
  }, [open, matches, clampedIndex, complete, queryKey])

  const portalBody = inputRef.current?.ownerDocument?.body ?? (typeof document !== 'undefined' ? document.body : null)
  const menu = open && portalBody
    ? createPortal(
        <div
          className="agent-mentions"
          role="listbox"
          aria-label="Agent and project mentions"
          style={rect ? { position: 'fixed', left: rect.left, bottom: rect.bottom, minWidth: rect.width, zIndex: 10000 } : undefined}
        >
          {matches.map((c, idx) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={idx === clampedIndex}
              className={'agent-mention-item' + (idx === clampedIndex ? ' active' : '')}
              onMouseDown={e => {
                e.preventDefault()
                e.stopPropagation()
                complete(c)
              }}
            >
              <TierChip tier={c.kind === 'project' ? 'project' : c.tier} />
              <span className="agent-mention-name">{'@' + c.id}</span>
            </button>
          ))}
        </div>,
        portalBody,
      )
    : null

  return { onKeyDown, syncCaret, menu }
}

// ------------------------------------------------------------ @net: / @org: Hub contact links

const knownOrgSlugs = new Set<string>()
let hubchatPcInstalled = false
const hubStateListeners = new Set<() => void>()

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

export function resolveHubAddressAction(
  address: string,
  extraLocalOrgs?: ReadonlySet<string> | null,
): { kind: 'org'; slug: string; title: string } | { kind: 'hubchat'; url: string; title: string } | { kind: 'inert'; title: string } {
  if (address.startsWith('@org:')) {
    const slug = address.slice('@org:'.length).trim()
    if (slug && (knownOrgSlugs.has(slug) || extraLocalOrgs?.has(slug))) {
      return { kind: 'org', slug, title: `Open organization ${slug} in a new window` }
    }
  }
  if (hubchatPcInstalled) {
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

export function useHubAddressState(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick(n => n + 1)
    hubStateListeners.add(fn)
    return () => { hubStateListeners.delete(fn) }
  }, [])
  return tick
}

export function HubContactChip({ address, className }: { address: string; className?: string }) {
  useHubAddressState()
  const action = resolveHubAddressAction(address)
  const inert = action.kind === 'inert'
  const cls = ['ref-chip', 'ref-hub', inert ? 'inert' : 'live', className].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={cls}
      data-hub-address={address}
      data-hub-ref={address}
      aria-disabled={inert ? 'true' : undefined}
      title={action.title}
      onClick={e => {
        e.stopPropagation()
        if (!inert) triggerHubAddress(address)
      }}
    >
      <span className="ref-id">{address}</span>
    </button>
  )
}

const mentionSeenLocally = new Map<string, Set<string>>()
const mentionHighlights = new Map<string, { mentionId: string; eventId?: string }>()
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
    mentionHighlights.set(`${org}:${nodeId}`, { mentionId, eventId })
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
  mentionHighlights.set(`${org}:${nodeId}`, { mentionId, eventId })
  notifySeen()
}

export function useMentionHighlight(
  slug: string,
  nodeId: string,
): { mentionId: string; eventId?: string } | null {
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
  notifySeen()
}

