// canvas/reflinks.tsx — a canonical reference (`@item:org/slug`) rendered as
// something you can click, or as an explicit statement of why you cannot.
//
// The MATCHER lives in `workrefs.tsx` and the FORMAT in `backend/orgtree/refs.py`.
// This file is only the middle step nobody had written: deciding, for one token
// on one surface, WHICH OF THESE FIVE IS TRUE.
//
//   ready     — this org, and something here can open it
//   pending   — this org, but the index that would confirm it has not arrived
//   absent    — this org, an authoritative index has arrived, it is NOT in it
//   foreign   — another org's token; NEVER resolved against what is on screen
//   elsewhere — real as far as we know, but THIS panel has no way to open it
//
// ⚠ THE FOUR THAT ARE NOT `ready` ARE THE FEATURE. An emitter that writes a
// canonical token is CLAIMING a target exists, so rendering a failed one as
// ordinary prose turns a broken pointer into text nobody can tell from a
// typo. Every outcome says which one it is, on the chip, in words.
//
// ⚠ AND `pending` IS NOT `absent`. "I have not looked yet" and "I looked and it
// is not there" are the same picture if you only track a boolean, and the wrong
// one of the two is a lie that appears while the page is still loading — which
// is exactly when a user is most likely to read it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HubContactChip } from './agentmentions'
import { NodeLink, nodeTierOf } from './identity'
import { objectNavProps } from './objectnav'
import { WorkRefText, parseRef, scanRefs } from './workrefs'
import { splitInlineCodeSpans } from './shared'
import { useHistoricalWorkReferences } from './workrefresolve'
import { agentReferences } from '../api'
import type { TreePayload } from '../types'
import type { MentionIndex, RefKind, TypedRef } from './workrefs'

export type RefOutcome =
  'ready' | 'pending' | 'absent' | 'foreign' | 'elsewhere'

/** What a surface knows about one family of targets.
 *
 *  `undefined`   this surface holds NO authoritative list — do not judge.
 *                The chip stays clickable and the DESTINATION reports the
 *                outcome, because it is the one that actually looked.
 *  `'loading'`   a list is coming. → `pending`
 *  a Map         the list, complete. Membership decides, and the value is the
 *                trustworthy label (§9) — a document's real title beats its id.
 *
 *  ⚠ `undefined` VS AN EMPTY MAP IS THE WHOLE DISTINCTION. An empty Map says
 *  "there are none of these here", which makes every ref absent. Pass one only
 *  when you mean it. */
export type RefIndexOf<V = string> = ReadonlyMap<string, V> | 'loading' | undefined

export interface RefWorld {
  boundedItems?: boolean
  workRevision?: string
  /** Exact per-name results for a foreground-only index. */
  itemOutcome?: (id: string) => RefOutcome
  /** the org actually on screen. A token naming any other org is `foreign`. */
  org: string
  items?: RefIndexOf
  /** Copy text is separate from the chip label: docket chips display slugs. */
  itemTitles?: ReadonlyMap<string, string>
  docs?: RefIndexOf
  agents?: RefIndexOf
  /** Exact per-agent result for a SELECTED tree, where absence from `agents`
   *  is only omission. Overrides `agents` for the judgement, not the label. */
  agentOutcome?: (id: string) => RefOutcome
  /** mail is not a list this side holds — the boxes are fetched per box, so a
   *  surface answers for the BOX (can I address it at all?) and the mail list
   *  answers for the message once it has loaded one. */
  mail?: (ref: TypedRef) => RefOutcome
  /** THE AGENT WHOSE SURFACE THIS IS, when the surface has one.
   *
   *  A reference to the agent whose focused desk you are already reading is
   *  not a destination, so it renders as identity without a control — the
   *  same rule `AgentName` follows, and now the same MECHANISM rather than a
   *  second one: the surface says where it is, and the resolver decides.
   *
   *  ⚠ THIS IS A PROPERTY OF THE SURFACE, NOT OF THE KIND. A pinned window, a
   *  switchboard panel and a lineage card all show an agent's own name and all
   *  must still navigate — the click takes you to its focused desk, somewhere
   *  you are not. Only the focused desk itself passes its own id here. */
  destination?: string | null
  /** an agent's CURRENT model, for the icon beside its name. A RESOLVER, not
   *  a map: a caller that cannot answer omits it and no icon is drawn, which
   *  is the honest outcome rather than a guessed one — and an unknown model
   *  never disables a known identity. */
  tierOf?: (id: string) => string | null | undefined
  /** which kinds THIS panel can actually open. Omitted means all of them.
   *
   *  ⚠ THIS IS NOT THE SAME QUESTION AS WHETHER THE TARGET EXISTS, and
   *  collapsing the two is the mistake worth naming. The docket can jump to an
   *  item and focus an agent; it owns no mail reader and no document reader.
   *  Rendering a real document as `absent` there would state, in words, that
   *  it does not exist — a lie about the data caused by a limit of the panel.
   *  `elsewhere` says the true thing instead: it is there, just not from
   *  here. */
  handles?: ReadonlySet<RefKind>
}

export interface ResolvedRef {
  ref: TypedRef
  /** the literal token, kept so a caller can always fall back to showing it */
  token: string
  outcome: RefOutcome
  /** what to put on the chip: a real title where we have one, never a guess */
  label: string
  /** The exact ticket title, only when an authoritative index supplied it. */
  copyTitle?: string
  /** why, in words, for the tooltip and for the unavailable chip */
  why: string
  /** an AGENT's current model, when the surface can say. Absent = no icon,
   *  never a guess, and never a reason to withhold the control. */
  tier?: string | null
  /** this reference names the agent whose surface you are already on: real,
   *  resolvable, and not somewhere to go */
  atDestination?: boolean
}

const KIND_WORD: Record<TypedRef['kind'], string> = {
  item: 'docket item', doc: 'document', agent: 'agent', mail: 'mail',
}

function boxWord(ref: TypedRef): string {
  if (ref.box === 'user') return "the user's inbox"
  if (ref.box === 'org') return "the org inbox"
  return ref.node ? `${ref.node}'s inbox` : 'a mailbox'
}

function judge(index: RefIndexOf, id: string): [RefOutcome, string | null] {
  if (index === undefined) return ['ready', null]
  if (index === 'loading') return ['pending', null]
  const label = index.get(id)
  return label === undefined ? ['absent', null] : ['ready', label]
}

/** One token, decided. Pure — no fetching, no React, so the whole outcome
 *  table is testable without a DOM. */
export function resolveRef(ref: TypedRef, world: RefWorld): ResolvedRef {
  const token = refToken(ref)
  const kind = KIND_WORD[ref.kind]
  // ⚠ ORG FIRST, ALWAYS, BEFORE ANY LOOKUP. Prose gets copied between orgs and
  // two orgs can hold the same item slug, document id or agent name, so a
  // token from elsewhere that happened to match locally would open a
  // DIFFERENT, UNRELATED object and look like it had worked.
  if (ref.org !== world.org) {
    return { ref, token, outcome: 'foreign', label: ref.id,
      why: `this ${kind} belongs to the org “${ref.org}”, not to this one — `
        + 'it is not opened from here' }
  }
  // ⚠ SECOND, AND STILL BEFORE ANY LOOKUP: can this panel open this kind at
  // all? Asked after the index, a document the docket cannot open would be
  // reported `absent` — "no document named d1 in this org" — which is a
  // statement about the DATA made because of a limit of the PANEL.
  if (world.handles && !world.handles.has(ref.kind)) {
    return { ref, token, outcome: 'elsewhere', label: ref.id,
      ...(ref.kind === 'item' && world.itemTitles?.has(ref.id)
        ? { copyTitle: world.itemTitles.get(ref.id)! } : {}),
      why: `this ${kind} is not opened from this panel` }
  }
  if (ref.kind === 'mail') {
    const outcome = world.mail ? world.mail(ref) : 'ready'
    const where = boxWord(ref)
    // ⚠ `absent` AND `elsewhere` ARE DIFFERENT SENTENCES, and mail is where
    // the difference bites: "this org has no such mailbox" is a fact about the
    // ORG, while "not opened from here" is a fact about the PANEL. A surface
    // that can address every box it knows of still reports the box it has
    // never heard of as absent, and saying "cannot be opened from here" there
    // would send someone looking for a panel that would work.
    return { ref, token, outcome, label: `mail in ${where}`,
      why: outcome === 'ready' ? `open this mail in ${where}`
        : outcome === 'pending' ? `still finding ${where}`
          : outcome === 'absent' ? `${where} does not exist in this org`
            : `${where} cannot be opened from here` }
  }
  const index = ref.kind === 'item' ? world.items
    : ref.kind === 'doc' ? world.docs : world.agents
  const [indexedOutcome, label] = judge(index, ref.id)
  const outcome = ref.kind === 'item' && world.itemOutcome ? world.itemOutcome(ref.id)
    : ref.kind === 'agent' && world.agentOutcome ? world.agentOutcome(ref.id) : indexedOutcome
  // AN AGENT REFERENCE CARRIES THE SAME TWO FACTS ITS NAME DOES ELSEWHERE:
  // the model it is running now, and whether you are already looking at it.
  // ⚠ THE MODEL IS ONLY CLAIMED FOR ONE THAT RESOLVES. Drawing an icon beside
  // a name this org does not have would be an identity invented for a target
  // that does not exist.
  const tier = ref.kind === 'agent' && outcome === 'ready'
    ? world.tierOf?.(ref.id) ?? null : null
  const atDestination = ref.kind === 'agent' && outcome === 'ready'
    && !!world.destination && world.destination === ref.id
  return {
    ref, token, outcome, label: label ?? ref.id, tier, atDestination,
    ...(ref.kind === 'item' && outcome === 'ready' && world.itemTitles?.has(ref.id)
      ? { copyTitle: world.itemTitles.get(ref.id)! } : {}),
    why: atDestination ? `${ref.id} — this is its own desk`
      : outcome === 'ready' ? `open the ${tier === 'project' ? 'project' : kind} ${ref.id}`
        : outcome === 'pending' ? `still loading this org's ${kind}s`
          : `no ${kind} named ${ref.id} in this org`,
  }
}

/** A ref back to its literal token. The renderer needs it for the `pending`
 *  and `absent` chips, where showing an id with no type would be a claim we
 *  have not earned. */
export function refToken(ref: TypedRef): string {
  if (ref.kind !== 'mail') return `@${ref.kind}:${ref.org}/${ref.id}`
  if (ref.box === 'node') {
    return `@mail:${ref.org}/node/${ref.node}/${ref.id}`
  }
  return `@mail:${ref.org}/${ref.box}/${ref.id}`
}

/** A mail reference as the app's EXISTING mail router understands it
 *  (`MailLinkFn`: the shape a chat chip's mail pointer already uses).
 *
 *  ⚠ ONE TRANSLATION, IN ONE PLACE, BECAUSE THE ROUTER'S VOCABULARY IS NOT
 *  THE TOKEN'S. `user_inbox` is a literal the router tests for, the org inbox
 *  is recognised by a LEADING `@`, and anything else is read as a node id — so
 *  an org box handed over as the bare slug would be routed to a node with the
 *  org's name, and on the day one exists it would open the wrong mailbox.
 *  Pure, so that mapping is pinned without mounting anything. */
export function mailRefTarget(ref: TypedRef): { id: string; to: string } {
  if (ref.box === 'user') return { id: ref.id, to: 'user_inbox' }
  if (ref.box === 'org') return { id: ref.id, to: `@org:${ref.org}` }
  return { id: ref.id, to: String(ref.node ?? '') }
}

/** A surface's whole reference wiring: what it judges against, and what it
 *  does when a chip is clicked. Passed around as ONE value so a component can
 *  never be handed a world with somebody else's routes. */
export interface RefRoutes {
  world: RefWorld
  onOpen: (r: ResolvedRef) => void
}

/** The world a surface judges references against, and what a click does.
 *  Every surface builds its world here; written per surface they drift, and a
 *  panel quietly calling a real item missing looks like a real missing item.
 *
 *  `agents` is a map the caller already holds — only the keys are read, which
 *  is why the value type is unconstrained.
 *
 *  ⚠ `null` IS `loading`, NOT "none". An empty Map means "this org has no
 *  agents", making every agent reference and node mailbox absent while the
 *  first fetch is still in flight.
 *
 *  ⚠ NO ITEM OR DOCUMENT INDEX. No caller holds either list, and `undefined`
 *  means "do not judge — the destination will".
 *
 *  ⚠ `handles` FOLLOWS THE CALLBACKS. A kind with no route reads "not opened
 *  from here"; pass `undefined` for a route you do not have, never a no-op,
 *  which would claim the panel can do something it cannot.
 *
 *  ⚠ EVERY ROUTE IS CALLED WITH EXACTLY ONE ARGUMENT — adapt at the call site,
 *  `(id) => centerOn(id)` and never bare `centerOn`. `centerOn(id, z)` reads
 *  `z ?? fit`, so a DOM event in the second parameter is non-null, defeats the
 *  default, and the camera is computed from an object. */
/** The selected tree's omission boundary for surfaces mounted under the
 *  canvas, which hold only its flattened map. */
export const ForegroundViewContext = createContext<TreePayload['foreground'] | undefined>(undefined)

/** Judges an agent a SELECTED tree may have omitted. Present rows are ready,
 *  the backend's explicit `missing` is absent, and anything else is looked up
 *  by exact reference for the tree's catalog: pending until it answers or if
 *  the lookup fails, never absent on a guess. `undefined` for a complete tree,
 *  whose map is authoritative as it stands. */
export function useAgentOutcome(org: string, agents: ReadonlyMap<string, unknown> | null,
  view: TreePayload['foreground'] | undefined): ((id: string) => RefOutcome) | undefined {
  const [answers, setAnswers] = useState(0)
  useEffect(() => agentReferences.subscribe(() => setAnswers(n => n + 1)), [])
  const asked = useRef(new Set<string>())
  const [asking, setAsking] = useState(0)
  const catalog = view?.catalog_revision
  useEffect(() => {
    if (catalog === undefined || !asked.current.size) return
    const ids = [...asked.current]
    asked.current.clear()
    agentReferences.request(org, catalog, ids)
  }, [org, catalog, asking])
  return useMemo(() => {
    if (!view || !agents) return undefined
    const present = new Set(view.present), missing = new Set(view.missing)
    return (id: string): RefOutcome => {
      if (agents.has(id) || present.has(id)) return 'ready'
      if (missing.has(id)) return 'absent'
      const state = agentReferences.get(org, view.catalog_revision, id)
      if (state && 'ref' in state) return state.ref ? 'ready' : 'absent'
      if (!state && !asked.current.has(id)) {
        asked.current.add(id)
        queueMicrotask(() => setAsking(n => n + 1))
      }
      return 'pending'
    }
  }, [org, agents, view, answers])   // eslint-disable-line react-hooks/exhaustive-deps
}

export function useRefRoutes(org: string, agents: ReadonlyMap<string, unknown> | null,
  routes: {
    onOpenItem?: (itemSlug: string) => void
    onFocusAgent?: (agentId: string) => void
    onOpenDoc?: (docId: string) => void
    onOpenMail?: (ref: TypedRef) => void
    /** the agent whose surface this is, when it has one (`RefWorld`) */
    destination?: string | null
    /** an agent's current model (`RefWorld`) */
    tierOf?: (id: string) => string | null | undefined
    /** the selected tree's omission boundary, when the agents came from one */
    view?: TreePayload['foreground']
  }): RefRoutes {
  const { onOpenItem, onFocusAgent, onOpenDoc, onOpenMail,
    destination, tierOf } = routes
  const effectiveTierOf = useMemo(() => {
    if (!tierOf && !agents) return undefined
    return (id: string) => {
      const fromMap = agents?.get(id) as { kind?: string | null; tier?: string | null } | undefined
      const mapTier = nodeTierOf(fromMap)
      if (mapTier === 'project') return 'project'
      return tierOf ? tierOf(id) : mapTier
    }
  }, [tierOf, agents])
  const inherited = useContext(ForegroundViewContext)
  const view = 'view' in routes ? routes.view : inherited
  const agentOutcome = useAgentOutcome(org, agents, view)
  const world = useMemo<RefWorld>(() => {
    const handles = new Set<RefKind>()
    if (onOpenItem) handles.add('item')
    if (onFocusAgent) handles.add('agent')
    if (onOpenDoc) handles.add('doc')
    if (onOpenMail) handles.add('mail')
    return {
      org,
      agents: agents
        ? new Map([...agents.keys()].map((id) => [id, id]))
        : 'loading',
      ...(agentOutcome ? { agentOutcome } : {}),
      mail: (r) => (r.box !== 'node' ? 'ready'
        : !agents ? 'pending'
          : agentOutcome ? agentOutcome(String(r.node ?? ''))
            : agents.has(String(r.node ?? '')) ? 'ready' : 'absent'),
      destination: destination ?? null,
      tierOf: effectiveTierOf,
      handles,
    }
  }, [org, agents, onOpenItem, onFocusAgent, onOpenDoc, onOpenMail,
    destination, effectiveTierOf, agentOutcome])
  const onOpen = useCallback((r: ResolvedRef) => {
    // ⚠ THE DESTINATION IS NOT A ROUTE. A chip at its own desk renders inert,
    // but a click can still arrive — a keyboard, an old chip, a caller that
    // built its own control — so the refusal lives here too rather than only
    // in the renderer.
    if (r.atDestination) return
    if (r.ref.kind === 'item') onOpenItem?.(r.ref.id)
    else if (r.ref.kind === 'agent') onFocusAgent?.(r.ref.id)
    else if (r.ref.kind === 'doc') onOpenDoc?.(r.ref.id)
    else if (r.ref.kind === 'mail') onOpenMail?.(r.ref)
  }, [onOpenItem, onFocusAgent, onOpenDoc, onOpenMail])
  // ⚠ CALLERS PASS INLINE ARROWS, so `routes` is a fresh object each render
  // and this memo recomputes with it. Downstream compares by rendered
  // OUTCOME, so a new world object costs no rebuild; pinning the identity
  // here would mean stale routes after any state change.
  return useMemo(() => ({ world, onOpen }), [world, onOpen])
}

/** One line of prose an agent WROTE, with its references made clickable.
 *  Plain text when the surface has no world.
 *
 *  ⚠ THE REACT RENDERER, NOT THE MARKDOWN ONE: these call sites render text
 *  NODES, so the prose is split into runs rather than walked as DOM.
 *
 *  ⚠ NOT FOR MACHINE-WRITTEN LINES. A sentence the app composed about an agent
 *  can quote that agent's text, and linkifying it turns a quotation into a
 *  claim that somebody wrote a reference there. */
export function Written({ text, refs }: { text: string; refs?: RefRoutes }) {
  if (!refs) return <>{text}</>
  return <TypedRefText text={text} world={refs.world} onOpen={refs.onOpen} />
}

export interface RefRun {
  text: string
  ref?: ResolvedRef
  hub?: string
}

const INLINE_AT_RE = /@(?:(net:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|org:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)|([a-z0-9][a-z0-9_-]*(?:@[0-9]+)?))/gi

function isLeftMentionBoundary(s: string, atIndex: number): boolean {
  if (atIndex <= 0) return true
  return !/[0-9A-Za-z._%+-]/.test(s[atIndex - 1]!)
}

function isRightMentionBoundary(s: string, endIndex: number): boolean {
  if (endIndex >= s.length) return true
  const next = s[endIndex]!
  if (/[0-9A-Za-z_@/-]/.test(next)) return false
  if (next === '.' && endIndex + 1 < s.length && /[0-9A-Za-z]/.test(s[endIndex + 1]!)) return false
  return true
}

function pushPlainRun(out: RefRun[], text: string): void {
  if (!text) return
  const prev = out[out.length - 1]
  if (prev && !prev.ref && !prev.hub) prev.text += text
  else out.push({ text })
}

function markdownCodeRanges(src: string): Array<[number, number]> {
  if (!src.includes('`') && !src.includes('~') && !src.includes('<code') && !src.includes('<pre')) return []
  const ranges: Array<[number, number]> = []
  const lines = src.split('\n')
  let offset = 0
  let fence: { ch: string; len: number; start: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const lineEnd = offset + l.length
    const openMatch = /^ {0,3}(`{3,}[^`\n]*|~{3,}.*)$/.exec(l)
    const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l)
    if (fence) {
      if (closeMatch && closeMatch[1]![0] === fence.ch && closeMatch[1]!.length >= fence.len) {
        ranges.push([fence.start, lineEnd])
        fence = null
      }
      offset = lineEnd + 1
      continue
    }
    if (openMatch) {
      const run = /^(`{3,}|~{3,})/.exec(openMatch[1]!)![1]!
      fence = { ch: run[0]!, len: run.length, start: offset }
      offset = lineEnd + 1
      continue
    }
    if (l.includes('`')) {
      const parts = splitInlineCodeSpans(l)
      let pos = offset
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j]!
        if (j % 2 === 1) ranges.push([pos, pos + part.length])
        pos += part.length
      }
    }
    offset = lineEnd + 1
  }
  if (fence) ranges.push([fence.start, src.length])
  for (const m of src.matchAll(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi)) {
    ranges.push([m.index!, m.index! + m[0].length])
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return ranges
}

function inCodeRange(ranges: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean {
  for (const [rStart, rEnd] of ranges) {
    if (start < rEnd && end > rStart) return true
  }
  return false
}

export function scanInlineMentions(
  chunk: string,
  world: RefWorld,
): Array<{ index: number; token: string; ref?: ResolvedRef; hub?: string }> {
  if (!chunk || !chunk.includes('@')) return []
  const codeRanges = markdownCodeRanges(chunk)
  const agents = world.agents instanceof Map ? world.agents : null
  const hits: Array<{ index: number; token: string; ref?: ResolvedRef; hub?: string }> = []
  INLINE_AT_RE.lastIndex = 0
  for (let m = INLINE_AT_RE.exec(chunk); m; m = INLINE_AT_RE.exec(chunk)) {
    const idx = m.index
    const tok = m[0]
    const end = idx + tok.length
    if (codeRanges.length && inCodeRange(codeRanges, idx, end)) continue
    if (!isLeftMentionBoundary(chunk, idx) || !isRightMentionBoundary(chunk, end)) continue
    if (m[1]) {
      hits.push({ index: idx, token: tok, hub: tok.toLowerCase() })
    } else if (m[2]) {
      const id = m[2].toLowerCase()
      if (id === 'user') {
        const resolved = resolveRef({ kind: 'mail', org: world.org, box: 'user', id: '@user' }, world)
        hits.push({
          index: idx,
          token: tok,
          ref: {
            ...resolved,
            token: tok,
            label: '@user',
            why: resolved.outcome === 'ready' ? "open the user's inbox" : resolved.why,
          },
        })
      } else if (agents && agents.has(id)) {
        const resolved = resolveRef({ kind: 'agent', org: world.org, id }, world)
        hits.push({ index: idx, token: tok, ref: { ...resolved, token: tok } })
      }
    }
  }
  return hits
}

function appendPlainWithMentions(chunk: string, world: RefWorld, out: RefRun[]): void {
  if (!chunk) return
  const hits = scanInlineMentions(chunk, world)
  if (!hits.length) {
    pushPlainRun(out, chunk)
    return
  }
  let last = 0
  for (const h of hits) {
    if (h.index > last) pushPlainRun(out, chunk.slice(last, h.index))
    if (h.ref) out.push({ text: h.token, ref: h.ref })
    else if (h.hub) out.push({ text: h.token, hub: h.hub })
    last = h.index + h.token.length
  }
  if (last < chunk.length) pushPlainRun(out, chunk.slice(last))
}

function splitTypedRefsSegment(s: string, world: RefWorld, out: RefRun[]): void {
  if (!s) return
  let last = 0
  // ⚠ THE SHARED SCANNER, not a second loop over the same pattern. Both
  // boundaries — a token ends at one, and starts at one — live in `scanRefs`,
  // and a renderer with its own loop is a renderer that can miss one of them.
  for (const hit of scanRefs(s)) {
    if (hit.index > last) appendPlainWithMentions(s.slice(last, hit.index), world, out)
    out.push({ text: hit.token, ref: resolveRef(hit.ref, world) })
    last = hit.index + hit.token.length
  }
  if (last < s.length) appendPlainWithMentions(s.slice(last), world, out)
}

/** Prose split into runs, every canonical token decided. Concatenating every
 *  `text` reproduces the input exactly — same losslessness contract as
 *  `splitRefs`, and for the same reason: these surfaces are `pre-wrap`.
 *
 *  Text that merely LOOKS like a token — an email address, a stray `@item:` —
 *  never matches in the first place, so it is left exactly as written. */
export function splitTypedRefs(text: string, world: RefWorld): RefRun[] {
  const s = String(text ?? '')
  if (!s) return []
  const out: RefRun[] = []
  const codeRanges = markdownCodeRanges(s)
  if (!codeRanges.length) {
    splitTypedRefsSegment(s, world, out)
    return out
  }
  let cursor = 0
  for (const [rStart, rEnd] of codeRanges) {
    if (rEnd <= cursor) continue
    const start = Math.max(cursor, rStart)
    if (start > cursor) splitTypedRefsSegment(s.slice(cursor, start), world, out)
    pushPlainRun(out, s.slice(start, rEnd))
    cursor = rEnd
  }
  if (cursor < s.length) splitTypedRefsSegment(s.slice(cursor), world, out)
  return out
}

/** One reference on screen. `ready` is a button; the other three are inert
 *  and SAY SO — they are not styled to look clickable, because a control that
 *  looks live and does nothing is worse than one that explains itself. */
export function RefChip({ r, onOpen }: {
  r: ResolvedRef
  onOpen?: (r: ResolvedRef) => void
}) {
  const copy = {
    'data-copy-agent-name': r.ref.kind === 'agent' ? r.ref.id : undefined,
    'data-copy-ticket-title': r.copyTitle,
  }
  const cls = `ref-chip ref-${r.ref.kind} ref-${r.outcome}`
    + (r.atDestination ? ' ref-here' : '')
  if (r.ref.kind === 'agent' && r.outcome === 'ready') {
    return (
      <NodeLink
        id={r.ref.id}
        tier={r.tier}
        label={r.label}
        why={r.why}
        atDestination={r.atDestination}
        className={cls}
        onFocus={onOpen ? () => onOpen(r) : undefined}
      />
    )
  }
  if (r.outcome === 'ready' && onOpen && !r.atDestination) {
    return (
      <button type="button" {...copy}
        {...(r.ref.kind === 'item' ? objectNavProps('ticket', r.ref.id, r.ref.org) : {})}
        className={cls} title={r.why}
        onClick={(e) => { e.stopPropagation(); onOpen(r) }}>
        {r.label}
      </button>
    )
  }
  if (r.outcome === 'ready') {
    return <span {...copy} className={cls} title={r.why}>{r.label}</span>
  }
  // ⚠ THE TOKEN IS SHOWN ON A FAILED REF, not the bare id. Whoever has to fix
  // the reference needs to see what was actually written, and on `foreign`
  // the org segment is the entire explanation.
  return (
    <span {...copy} className={cls} title={r.why}>
      {r.token}
      <span className="ref-why">{r.outcome === 'pending' ? '…'
        : r.outcome === 'foreign' ? 'other org'
          : r.outcome === 'elsewhere' ? 'not from here' : 'unavailable'}</span>
    </span>
  )
}

/** Prose with its canonical references rendered. With no `onOpen` every chip
 *  is inert, which is the correct read-only rendering rather than a special
 *  case each surface has to remember. */
/** THE ONE A SURFACE ACTUALLY RENDERS. Canonical references that the author
 *  explicitly wrote (`@item:org/slug`, `@agent:org/name`, etc.) are always
 *  linkified. Bare item names retain the docket's existing navigation, but
 *  bare agent names are deliberately excluded: a stale or ordinary agent word
 *  must not become a destination merely because it matches the catalogue. */
export function RefProse({ text, world: baseWorld, onOpen, index: baseIndex, onPick }: {
  text: string
  world: RefWorld
  onOpen?: (r: ResolvedRef) => void
  /** the existing bare-name index; only item entries are used here */
  index?: MentionIndex
  onPick?: (name: string) => void
  /** retained for callers; bare agent entries are filtered before rendering */
  onFocusAgent?: (id: string) => void
}) {
  const { world, index } = useHistoricalWorkReferences(text, baseWorld, baseIndex)
  const runs = useMemo(() => splitTypedRefs(text, world), [text, world])
  const itemIndex = useMemo(() => index && new Map(
    [...index].filter(([, ref]) => ref.kind === 'item')),
    [index])
  return (
    <>
      {runs.map((p, i) => (p.ref
        ? <RefChip key={i} r={p.ref} onOpen={onOpen} />
        : p.hub
          ? <HubContactChip key={i} address={p.hub} />
          : (itemIndex?.size && onPick
            ? <WorkRefText key={i} text={p.text} index={itemIndex}
                onPick={onPick} />
            : <span key={i}>{p.text}</span>)))}
    </>
  )
}

export function TypedRefText({ text, world, onOpen, render }: {
  text: string
  world: RefWorld
  onOpen?: (r: ResolvedRef) => void
  /** override the chip entirely (the markdown walk needs plain DOM) */
  render?: (r: ResolvedRef, key: number) => ReactNode
}) {
  const runs = useMemo(() => splitTypedRefs(text, world), [text, world])
  return (
    <>
      {runs.map((p, i) => (p.ref
        ? (render ? render(p.ref, i)
          : <RefChip key={i} r={p.ref} onOpen={onOpen} />)
        : p.hub
          ? <HubContactChip key={i} address={p.hub} />
          : <span key={i}>{p.text}</span>))}
    </>
  )
}
