// canvas/workrefs.tsx — an exact NAME written in ordinary prose, turned into
// something clickable. One matcher, called by every surface that needs one.
//
// GENERIC OVER WHAT A NAME MEANS. It was written for docket item slugs and is
// now also the matcher for agent ids (checklist-evidence's shared agent chip),
// because the hard part is not what the name refers to — it is deciding
// whether a run of characters IS a mention. Two matchers would be two sets of
// boundary rules, and they would drift.
//
// THE CONTRACT, and the two ways it can be broken:
//
//  1. A MENTION IS THE LONGEST KNOWN SLUG AT A POSITION WHOSE BOTH BOUNDARIES
//     ARE FREE. Slugs are kebab-case and routinely contain one another, so a
//     shorter name must never win inside a longer one, inside a longer word,
//     inside a URL path, or inside a dotted identifier. Wrong link beats no
//     link only in the sense that it is worse.
//  2. SPLITTING IS LOSSLESS. Concatenating every run's `text` reproduces the
//     input exactly — whitespace included, since these surfaces render with
//     `white-space: pre-wrap`.

import { useContext, useMemo } from 'react'
import { CurrentOrg } from '../popout'
import type { ReactNode } from 'react'
import type { WorkItem } from '../types'
import { AgentName } from './identity'
import { objectNavProps } from './objectnav'
import { RefMark } from './refmarks'
import { ObjectMentionButton } from './mentionwrap'
import { ticketFlare } from './docketstatus'

/** The names that may be matched, and what each one resolves to. A Map is
 *  both halves at once — the key set is what the matcher scans for, and the
 *  value is whatever the caller needs at render time (an item, an agent's
 *  tier, anything).
 *
 *  ⚠ RESOLVING IS THE CALLER'S JOB AND IT MUST BE EXACT. A name absent from
 *  the map is never marked, which is what keeps "same org only" and "no
 *  invented identity" true by construction rather than by a check somebody
 *  can forget. Prose is full of words that look like names and are not. */
export type RefIndex<T> = Map<string, T>

/** What a name in prose turns out to be: an item, or an agent and the model
 *  that agent runs under NOW. One index holds both kinds — two would mean two
 *  scans with two sets of boundary rules, free to drift. */
export type MentionRef =
  | { kind: 'item'; slug: string; title?: string; status?: string; archived?: boolean }
  | { kind: 'agent'; id: string; tier?: string | null }

export type MentionIndex = RefIndex<MentionRef>

/** ⚠ ITEMS WIN A COLLISION: the loop order IS the rule. In the docket a name
 *  that is both an item and an agent is the item.
 *
 *  ⚠ THE TIER COMES FROM THE CALLER'S FACTS, never from a lookup here. A name
 *  absent from `agents` gets no entry, and an agent whose tier is unknown gets
 *  an entry with no tier — neither is filled in with a plausible answer. */
export function buildMentionIndex(
  items: Iterable<Pick<WorkItem, 'slug' | 'title'> & { status?: string; archived?: boolean }>,
  agents?: Iterable<readonly [string, string | null | undefined]>,
): MentionIndex {
  const out: MentionIndex = new Map()
  // an empty name would compile into the alternation as an empty branch, which
  // matches at every position and spins the scanner forever
  for (const [id, tier] of agents ?? []) {
    if (id) out.set(id, { kind: 'agent', id, tier })
  }
  // the status rides along for the link's flare (USER 2026-10-27 m43beb8089dd4)
  for (const it of items) if (it?.slug) out.set(it.slug, { kind: 'item', slug: it.slug, title: it.title,
    ...(it.status ? { status: it.status } : {}), ...(it.archived ? { archived: true } : {}) })
  return out
}

export interface RefPart<T> {
  text: string
  /** present iff this run is a mention — the value the index resolved to */
  ref?: T
}

// ⚠ THE BOUNDARY RULES ARE THE WHOLE FEATURE. A mention is only a mention when
// the characters touching it cannot make it part of something bigger.
//
// BEFORE: anything that could make this the tail of a longer name, a path, a
// URL or a dotted identifier. Note `.` and `/` and `\` and `:` — `host/slug`
// and `a.slug` are not mentions.
const BLOCKS_BEFORE = /[A-Za-z0-9_\-/\\:.@#&?=+~]/
// AFTER: the same set MINUS the full stop, which is handled separately —
// blocking it outright would refuse to link a slug that simply ends a
// sentence, which is where they most often appear.
const BLOCKS_AFTER = /[A-Za-z0-9_\-/\\:@#&?=+~]/

// Backticks, quotes, brackets and parentheses are deliberately NOT blockers:
// the org's own writing convention puts slugs in backticks, so `slug` is the
// single most common way a mention actually appears.

function linkable(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  if (before && BLOCKS_BEFORE.test(before)) return false
  const after = end < text.length ? text[end] : ''
  if (after && BLOCKS_AFTER.test(after)) return false
  // "foo-bar." ends a sentence and links; "foo-bar.json" does not
  if (after === '.' && /[A-Za-z0-9]/.test(text[end + 1] ?? '')) return false
  return true
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Only exact, boundary-valid candidates from prose currently being rendered.
 * Unknown words are resolved in bounded batches, never against all history. */
export function workReferenceCandidates(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
    if (linkable(text, match.index!, match.index! + match[0].length)) names.add(match[0])
  }
  return [...names]
}

/** Split prose into runs, marking the ones that are mentions of a known name.
 *  Concatenating every `text` back together reproduces the input exactly. */
export function splitRefs<T>(text: string, index: RefIndex<T>): RefPart<T>[] {
  if (!text || index.size === 0) return text ? [{ text }] : []
  // LONGEST FIRST. JavaScript alternation is first-match-wins, not
  // longest-match-wins, so without this ordering `a-b` listed before
  // `a-b-c` would win inside `a-b-c` — and then the boundary check would
  // reject it and the longer name would never be tried at that position.
  const slugs = [...index.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
  const re = new RegExp(slugs.map(escapeRe).join('|'), 'g')
  const out: RefPart<T>[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    if (!linkable(text, start, end)) {
      // step ONE character, not past the whole match: a rejected long name
      // may still contain a shorter one that starts further in
      re.lastIndex = start + 1
      continue
    }
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: m[0], ref: index.get(m[0]) })
    last = end
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** Prose with its mentions rendered by the caller. With no `render` — or with
 *  nothing in the index — this is the text and nothing else, which is what
 *  every surface falls back to rather than each carrying its own special
 *  case. */
export function RefText<T>({ text, index, render }: {
  text: string
  index: RefIndex<T>
  render?: (ref: T, text: string, key: number) => ReactNode
}) {
  const parts = useMemo(() => splitRefs(text, index), [text, index])
  if (!render) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => (p.ref !== undefined
        ? render(p.ref, p.text, i)
        : <span key={i}>{p.text}</span>))}
    </>
  )
}

/** The docket's rendering of a mention: an underlined name that goes there.
 *  An ITEM mention selects that item; an AGENT mention goes to that agent's
 *  desk, drawn by the shared `AgentName`.
 *
 *  ⚠ A MENTION'S CHIP IS THE DESTINATION'S CURRENT MODEL, AND SAYS SO. This is
 *  navigation, not authorship: prose records no generation, so the chip cannot
 *  mean "the model that wrote this" the way an actor line's does. It means
 *  "the model you will reach", the tooltip says `current model`, and an agent
 *  whose current tier is unknown gets no chip rather than a guess.
 *  (Astra ruling 2026-09-05, over this author's proposal to show none.) */
export function WorkRefText({ text, index, onPick, onFocusAgent }: {
  text: string
  index: MentionIndex
  onPick?: (name: string) => void
  onFocusAgent?: (id: string) => void
}) {
  const org = useContext(CurrentOrg)
  const render = (ref: MentionRef, shown: string, key: number): ReactNode => {
    if (ref.kind === 'agent') {
      return onFocusAgent
        ? (
          <span key={key} className="docket-mention">
            <AgentName id={ref.id} tier={ref.tier}
              nameClass="docket-ref docket-ref-agent"
              why={ref.tier
                ? `${ref.id} — current model, ${ref.tier}. Go to its desk.`
                : `${ref.id} — current model not known. Go to its desk.`}
              onFocus={(id) => onFocusAgent(id)} />
          </span>
        )
        : <span key={key} data-copy-agent-name={ref.id}>{shown}</span>
    }
    // A LINK SHOWS THE ITEM'S TITLE AND WEARS ITS STATUS FLARE, like a typed
    // mention (USER 2026-10-27 m3eb804e5023a "also make these links use the full
    // name", m43beb8089dd4); the words around it stay as written, and inert
    // prose keeps the name itself. Its HOVER gives the slug, since the title is
    // already inline (USER 2026-10-29 m3ad5633675ff), led by the status flare.
    const title = ref.title?.trim() ? ref.title : undefined
    const flare = ticketFlare(ref)
    return onPick
      ? (
        <ObjectMentionButton key={key} {...objectNavProps('ticket', ref.slug, org ?? undefined)} data-copy-ticket-title={ref.title}
          className={'docket-ref' + (flare ? ` ref-flare ${flare.cls}` : '')}
          title={flare ? `${flare.tip} · ${ref.slug}` : ref.slug}
          onClick={(e) => { e.stopPropagation(); onPick(ref.slug) }}>
          <RefMark kind="item" />{title ?? shown}
        </ObjectMentionButton>
      )
      : <span key={key} data-copy-ticket-title={ref.title}>{shown}</span>
  }
  return <RefText<MentionRef> text={text} index={index} render={render} />
}

// ---------------------------------------------------------------- typed refs
//
// The canonical token grammar lives in packages/contracts/reference-tokens.ts
// so the desktop main process can validate orgtree:// links with the SAME
// parser (main/orgtree-link.ts). Every renderer import keeps coming from here.
export { REF_TOKEN_RE, scanRefs, findRefs, parseRef } from '../../../../../packages/contracts/reference-tokens'
export type { RefKind, MailBox, TypedRef, RefHit } from '../../../../../packages/contracts/reference-tokens'
