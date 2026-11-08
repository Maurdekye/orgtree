// packages/contracts/reference-tokens.ts — the canonical reference token
// (`@item:org/slug` and its kin), shared by the renderer (canvas/workrefs.tsx
// re-exports it) and the desktop main process, which validates orgtree:// links
// with it (main/orgtree-link.ts, docs/rust-engine/orgtree-links.md). React-free
// on purpose: main must not bundle the renderer to read one grammar.
//
// ---------------------------------------------------------------- typed refs
//
// The canonical token an agent emits. Defined once in `backend/orgtree/refs.py`
// and parsed twice — there, and here. `apps/desktop/renderer/tests/ref-tokens.json` is
// generated from the Python and asserted by both sides, so the two cannot
// drift without a red test.
//
// ⚠ EVERY TOKEN CARRIES ITS ORG, and that is not decoration: prose gets copied
// between orgs, and two orgs can hold the same item slug, agent name or mail
// id. A token whose org is not the one on screen must NEVER be resolved
// locally — it is reported as belonging elsewhere.

export type RefKind = 'item' | 'doc' | 'agent' | 'mail' | 'app' | 'panel'
export type MailBox = 'user' | 'org' | 'node'

export interface TypedRef {
  kind: RefKind
  org: string
  /** item slug · document id · node id · mail id · app id · panel id */
  id: string
  /** a node written in its project form, `@project:<org>/<name>` (USER
   *  2026-10-27 md30a04a62550): it names a project or nothing, so one that
   *  does not name a live project stays plain text (reflinks `projectFormPlain`) */
  as?: 'project'
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
const END = '(?![A-Za-z0-9_/-])(?!@(?!(?:item|doc|agent|project|mail|app|panel):))'

/** the family, for scanning prose. Only the node positions admit `@`, and
 *  only as `@<digits>`, so a following `@item:…` is never swallowed. */
export const REF_TOKEN_RE = new RegExp(
  `@(?:(item|doc|app|panel):(${SEG}/${SEG})`
  + `|(agent|project):(${SEG}/${NODE})`
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
  const written = m[1] ?? m[3] ?? m[5]
  const seg = String(m[2] ?? m[4] ?? m[6]).split('/')
  // a project's long form is a node reference that must name a project
  if (written === 'project') return { kind: 'agent', org: seg[0] as string, id: seg[1] as string, as: 'project' }
  const kind = written as RefKind
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
