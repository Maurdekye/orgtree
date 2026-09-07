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

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { WorkItem } from '../types'
import { AgentName } from './identity'

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
  | { kind: 'item'; slug: string }
  | { kind: 'agent'; id: string; tier?: string | null }

export type MentionIndex = RefIndex<MentionRef>

/** ⚠ ITEMS WIN A COLLISION: the loop order IS the rule. In the docket a name
 *  that is both an item and an agent is the item.
 *
 *  ⚠ THE TIER COMES FROM THE CALLER'S FACTS, never from a lookup here. A name
 *  absent from `agents` gets no entry, and an agent whose tier is unknown gets
 *  an entry with no tier — neither is filled in with a plausible answer. */
export function buildMentionIndex(
  items: Iterable<WorkItem>,
  agents?: Iterable<readonly [string, string | null | undefined]>,
): MentionIndex {
  const out: MentionIndex = new Map()
  // an empty name would compile into the alternation as an empty branch, which
  // matches at every position and spins the scanner forever
  for (const [id, tier] of agents ?? []) {
    if (id) out.set(id, { kind: 'agent', id, tier })
  }
  for (const it of items) if (it?.slug) out.set(it.slug, { kind: 'item', slug: it.slug })
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
  const render = (onPick || onFocusAgent)
    ? (ref: MentionRef, shown: string, key: number): ReactNode => {
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
          : <span key={key}>{shown}</span>
      }
      return onPick
        ? (
          <button key={key} type="button" className="docket-ref"
            title={`go to ${shown}`}
            onClick={(e) => { e.stopPropagation(); onPick(ref.slug) }}>
            {shown}
          </button>
        )
        : <span key={key}>{shown}</span>
    }
    : undefined
  return <RefText<MentionRef> text={text} index={index} render={render} />
}

// ---------------------------------------------------------------- typed refs
//
// The canonical token an agent emits. Defined once in `backend/orgtree/refs.py`
// and parsed twice — there, and here. `frontend/tests/ref-tokens.json` is
// generated from the Python and asserted by both sides, so the two cannot
// drift without a red test.
//
// ⚠ EVERY TOKEN CARRIES ITS ORG, and that is not decoration: prose gets copied
// between orgs, and two orgs can hold the same item slug, agent name or mail
// id. A token whose org is not the one on screen must NEVER be resolved
// locally — it is reported as belonging elsewhere.

export type RefKind = 'item' | 'doc' | 'agent' | 'mail'
export type MailBox = 'user' | 'org' | 'node'

export interface TypedRef {
  kind: RefKind
  org: string
  /** item slug · document id · node id · mail id */
  id: string
  /** mail only */
  box?: MailBox
  /** mail in a node's box only */
  node?: string
}

/** org slugs, item slugs, document ids and mail ids */
const SEG = '[a-z0-9-]+'
/** ⚠ A NODE ID IS A WIDER DOMAIN. A knowledge bearer is `<name>@<generation>`
 *  (`ledger.py`: `pred_id = f"{nid}@{gen}"`), so `codex-checklist@4` is a real
 *  addressable agent. A parser that "recovered" by truncating at the `@` would
 *  address the LIVE agent instead of the bearer — the wrong-target failure
 *  this format exists to prevent. The generation is part of the segment. */
const NODE = '[a-z0-9-]+(?:@[0-9]+)?'

/** ⚠ A TOKEN ENDS AT A BOUNDARY, or it is not a token. Without this a
 *  malformed token does not fail — it TRUNCATES, and the prefix that survives
 *  is a working control for something else:
 *
 *      @agent:org/alpha@bad   → opens agent `alpha`
 *      @agent:org/alpha@12x   → opens bearer `alpha@12`
 *      @item:org/alpha/extra  → opens item `alpha`
 *
 *  Two continuations are refused: anything that could have been part of the id
 *  (so a match cannot be the prefix of a longer name), and a bare `@` — except
 *  when it opens another canonical token, because `…/alpha@item:org/beta` is
 *  two adjacent references and both must survive. */
const END = '(?![A-Za-z0-9_/-])(?!@(?!(?:item|doc|agent|mail):))'

/** the family, for scanning prose. Only the node positions admit `@`, and
 *  only as `@<digits>`, so a following `@item:…` is never swallowed. */
export const REF_TOKEN_RE = new RegExp(
  `@(?:(item|doc):(${SEG}/${SEG})`
  + `|(agent):(${SEG}/${NODE})`
  + `|(mail):(${SEG}/(?:user|org)/${SEG}|${SEG}/node/${NODE}/${SEG}))`
  + END, 'g')

/** ⚠ AND A TOKEN STARTS AT A BOUNDARY TOO. `x@agent:org/alpha` inside an
 *  ordinary word is not a reference somebody wrote — matching the right target
 *  does not make arbitrary embedded text intentional.
 *
 *  This cannot be a lookbehind: two canonical tokens written with nothing
 *  between them (`…/alpha@item:org/beta`) put an id character immediately
 *  before the second one, and the backend's `re` has no variable-length
 *  lookbehind to say "unless a whole token ends here". So the scan carries the
 *  END OF THE LAST ACCEPTED TOKEN instead, which is the same rule stated where
 *  it can actually be checked — and it is the ONE scanner every renderer uses,
 *  so a boundary fixed here cannot be missing from one of them. */
const LEAD = /[A-Za-z0-9_@-]/

export interface RefHit {
  /** where the token starts in `text` */
  index: number
  token: string
  ref: TypedRef
}

/** Every canonical reference in `text`, in order, boundaries applied. */
export function scanRefs(text: string): RefHit[] {
  const s = String(text ?? '')
  const re = new RegExp(REF_TOKEN_RE.source, 'g')
  const out: RefHit[] = []
  let end = -1                       // end of the last ACCEPTED token
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const at = m.index
    const before = at > 0 ? s[at - 1]! : ''
    if (at !== 0 && at !== end && LEAD.test(before)) {
      // embedded in a word: not a reference. Resume one character in, so a
      // real token later in the same run is still found.
      re.lastIndex = at + 1
      continue
    }
    const ref = parseRef(m[0])
    if (!ref) { re.lastIndex = at + 1; continue }
    out.push({ index: at, token: m[0], ref })
    end = at + m[0].length
  }
  return out
}

/** Every token in `text`, as `[kind, rest]`, in order — the shape the
 *  cross-language fixture compares. */
export function findRefs(text: string): [string, string][] {
  return scanRefs(text).map(({ ref }) => [
    ref.kind,
    ref.kind === 'mail' && ref.box === 'node'
      ? `${ref.org}/node/${ref.node}/${ref.id}`
      : ref.kind === 'mail'
        ? `${ref.org}/${ref.box}/${ref.id}`
        : `${ref.org}/${ref.id}`,
  ])
}

/** A token to its parts, or null when it is not one. Never a guess: a
 *  malformed token resolves to nothing rather than to something plausible. */
export function parseRef(token: string): TypedRef | null {
  const m = new RegExp(`^${REF_TOKEN_RE.source}$`).exec(String(token ?? ''))
  if (!m) return null
  const kind = (m[1] ?? m[3] ?? m[5]) as RefKind
  const seg = String(m[2] ?? m[4] ?? m[6]).split('/')
  if (kind !== 'mail') {
    return { kind, org: seg[0] as string, id: seg[1] as string }
  }
  if (seg.length === 3) {
    return { kind, org: seg[0] as string, box: seg[1] as MailBox,
      id: seg[2] as string }
  }
  return { kind, org: seg[0] as string, box: 'node',
    node: seg[2] as string, id: seg[3] as string }
}
