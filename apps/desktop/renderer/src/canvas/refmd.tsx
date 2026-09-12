// canvas/refmd.ts — canonical references inside RENDERED MARKDOWN.
//
// Everywhere else a reference is decided in React, from the source text
// (`RefProse`). A mail body is not available as source text by the time it is
// on screen: it has already been through `marked` + DOMPurify and been handed
// to `dangerouslySetInnerHTML`, so there are no React children to decorate.
// This walks the DOM the sanitizer produced instead.
//
// FOUR THINGS THAT ARE NOT NEGOTIABLE HERE, each of them a way a naive
// "replace the token in the HTML string" version goes wrong:
//
//  1. IT NEVER WRITES HTML. Every chip is built with createElement and
//     textContent, so no string this function touches can re-enter the parser.
//     A regex over `innerHTML` would put author-controlled text back through
//     it and undo the sanitize that just ran.
//  2. CODE IS LEFT ALONE. A token inside `<code>`/`<pre>` is being QUOTED —
//     it is the thing being discussed, and turning it into a control changes
//     what the author wrote. Anchors are skipped for the same reason: a
//     control inside a link is two destinations in one target.
//  3. IT RE-RUNS WHEN THE ANSWER CHANGES, NOT WHEN THE HTML DOES. The index a
//     reference is judged against arrives after the body is on screen, so the
//     pass must run again on the SAME html — and must then find its own
//     previous chips rather than the tokens it already replaced, or it walks
//     over its own output and multiplies it.
//  4. IT DOES NOTHING WHEN NOTHING CHANGED. Rebuilding identical chips would
//     destroy the reader's text selection every time an unrelated poll
//     landed. `linkifyRefs` compares first and returns having touched no node.

import { useEffect, useRef } from 'react'
import { resolveRef, refToken } from './reflinks'
import type { RefOutcome, RefWorld, ResolvedRef } from './reflinks'
import { parseRef, scanRefs, splitRefs } from './workrefs'
import type { MentionRef } from './workrefs'
import { TIER_LETTER } from './shared'

/** the attribute that makes an injected chip findable again on the next pass.
 *  It holds the ORIGINAL TOKEN, so undoing the injection is exact — the chip's
 *  visible text may be a title or a label and cannot be trusted to reproduce
 *  what the author wrote. */
const TOK = 'data-ref-token'
const OUT = 'data-ref-outcome'
/** the same marker for a BARE NAME written in ordinary prose (a docket item
 *  slug). It holds the name, which is also exactly the text it replaced, so
 *  undoing it is exact for the same reason. */
const MEN = 'data-ref-mention'
/** every rendered fact about one chip, for the cheap exit (`chipSig`) */
const SIG = 'data-ref-sig'
/** what the LAST pass was able to look for, on the host (`mentionScan`) */
const SCAN = 'data-ref-scan'

/** the word on an unavailable chip. Kept beside the React renderer's copy in
 *  reflinks.tsx and pinned against it by a check, because two renderings of
 *  one outcome that disagree is worse than either of them alone. */
const WHY_WORD: Record<RefOutcome, string> = {
  ready: '', pending: '…', foreign: 'other org',
  elsewhere: 'not from here', absent: 'unavailable',
}

const SKIP = new Set(['CODE', 'PRE', 'A', 'BUTTON'])

function inSkipped(node: Node): boolean {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (SKIP.has(p.tagName)) return true
  }
  return false
}

/** EVERYTHING A CHIP RENDERS, in one string.
 *
 *  ⚠ THE CHEAP EXIT COMPARES THIS, not the outcome. Outcomes alone say
 *  "nothing changed" while the visible answer has changed: a document that
 *  gains its real title, a body that loses its handler. Anything the chip puts
 *  on screen belongs in here, or the pass skips a rebuild it needed. */
function chipSig(r: ResolvedRef, live: boolean): string {
  return [r.outcome, live ? '1' : '0', r.label, r.why,
    r.tier ?? '', r.atDestination ? '1' : '0', r.copyTitle === undefined ? '0' : '1',
    r.copyTitle ?? ''].join('')
}

/** build one chip as DOM. Mirrors `RefChip`; `refchip.test` holds the two
 *  together. */
function chipEl(doc: Document, r: ResolvedRef,
  clickable: boolean): HTMLElement {
  const live = r.outcome === 'ready' && clickable && !r.atDestination
  const el = doc.createElement(live ? 'button' : 'span')
  if (live) (el as HTMLButtonElement).type = 'button'
  el.className = `ref-chip ref-${r.ref.kind} ref-${r.outcome}`
    + (r.atDestination ? ' ref-here' : '')
  el.title = r.why
  el.setAttribute(TOK, r.token)
  el.setAttribute(OUT, r.outcome)
  el.setAttribute(SIG, chipSig(r, live))
  if (r.ref.kind === 'agent') el.setAttribute('data-copy-agent-name', r.ref.id)
  if (r.copyTitle !== undefined) el.setAttribute('data-copy-ticket-title', r.copyTitle)
  // an agent's CURRENT model, the same claim its name carries elsewhere. No
  // tier means no icon and a working control — an unknown model is not an
  // unknown agent.
  if (r.ref.kind === 'agent' && r.tier) {
    const t = doc.createElement('span')
    t.className = 'tier t-' + r.tier
    t.textContent = TIER_LETTER[r.tier] ?? '?'
    el.appendChild(t)
  }
  // ⚠ APPENDED, NOT ASSIGNED: `textContent =` wipes the model icon above.
  //
  // ⚠ THE TOKEN IS SHOWN ON A FAILED REF, the label only on a live one —
  // the same rule as the React chip, and for the same reason: whoever has to
  // fix a broken reference needs to see what was actually written.
  el.appendChild(doc.createTextNode(
    r.outcome === 'ready' ? r.label : r.token))
  if (r.outcome !== 'ready') {
    const why = doc.createElement('span')
    why.className = 'ref-why'
    why.textContent = WHY_WORD[r.outcome]
    el.appendChild(why)
  }
  return el
}

/** BARE DOCKET NAMES INSIDE RENDERED MARKDOWN (user requirement 2026-09-12).
 *
 *  A docket description used to render as plain React text, where `RefProse`
 *  turned an exact item name written in ordinary prose into a control. Now it
 *  renders as Markdown, so the same names arrive here as text nodes in
 *  sanitized HTML and there are no React children to decorate — exactly the
 *  situation this module already exists for. Doing it in THIS walk rather
 *  than a second pass of its own is deliberate: two passes would fight over
 *  the same text nodes, and each would see the other's chips as prose.
 *
 *  ⚠ ITEMS ONLY. `RefProse` filters bare AGENT names out for a reason worth
 *  repeating — an ordinary word that happens to match a live agent's name must
 *  not silently become a destination. */
export interface MentionWorld {
  /** the names that may be matched. Membership is the whole rule: a name
   *  absent from the map is left as prose. */
  index: ReadonlyMap<string, MentionRef>
  /** what a click does. Without it the name is marked but inert, the same
   *  read-only rendering `WorkRefText` falls back to. */
  onPick?: (slug: string) => void
}

/** the item entries of a mention index, as `splitRefs` wants them. Returns
 *  null when there is nothing to scan for, which is the signal to skip the
 *  mention half of the walk entirely. */
function itemsOf(m: MentionWorld | null | undefined):
Map<string, MentionRef> | null {
  if (!m || m.index.size === 0) return null
  const out = new Map<string, MentionRef>()
  for (const [name, ref] of m.index) if (ref.kind === 'item') out.set(name, ref)
  return out.size ? out : null
}

/** WHAT THIS PASS IS ABLE TO FIND AT ALL — the other half of the cheap exit,
 *  and the half a chip cannot supply.
 *
 *  ⚠ AN UNKNOWN NAME LEAVES NO CHIP BEHIND, which is why comparing chips is
 *  not enough. A typed token always produces one whatever its outcome, so a
 *  world that changes is always visible in something already on screen. A
 *  bare name that is not in the index is just prose — so when the index later
 *  GAINS that name there is nothing whose signature disagrees, every existing
 *  chip still matches, and the pass would exit having never looked at the
 *  word that just became a destination. (account-pro found exactly this
 *  reviewing 704d946: two names, one in the index, and adding the second
 *  changed nothing on screen.)
 *
 *  So the host also records the NAME SET the last pass scanned for. It is a
 *  fingerprint rather than the index itself for a reason that matters as much
 *  as the bug: the docket rebuilds its index from a re-fetched list every
 *  poll, so a new Map with identical contents arrives every few seconds.
 *  Comparing by reference would rebuild every chip on every poll and drop the
 *  reader's text selection each time — trading a missed link for a worse
 *  fault. Contents decide; order does not, because insertion order follows
 *  the fetch. */
function mentionScan(items: Map<string, MentionRef> | null, live: boolean): string {
  if (!items) return ''
  // two order-independent accumulators: a sum alone collides on a swapped
  // pair of names, and a missed rebuild is precisely the bug being fixed
  let sum = 0
  let mix = 0
  for (const name of items.keys()) {
    let h = 0
    for (let i = 0; i < name.length; i += 1) {
      h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0
    }
    sum = (sum + h) | 0
    mix ^= Math.imul(h, 0x9e3779b1)
  }
  return `${items.size}.${sum >>> 0}.${mix >>> 0}.${live ? '1' : '0'}`
}

/** everything one mention chip renders, for the cheap exit — the mirror of
 *  `chipSig`. The title rides along because it is on the element as copy text
 *  (`data-copy-ticket-title`), so a renamed item must rebuild. */
function mentionSig(ref: MentionRef, live: boolean): string {
  return ['m', live ? '1' : '0',
    ref.kind === 'item' ? ref.slug : '', ref.kind === 'item' ? ref.title ?? '' : ''].join('|')
}

/** build one bare-name chip as DOM. Mirrors `WorkRefText`'s item branch;
 *  `docketdesc.test` §4c and `docketrefs.test` §7 hold the two together. */
function mentionEl(doc: Document, ref: MentionRef,
  onPick?: (slug: string) => void): HTMLElement {
  const slug = ref.kind === 'item' ? ref.slug : ''
  const live = !!onPick
  const el = doc.createElement(live ? 'button' : 'span')
  if (live) {
    (el as HTMLButtonElement).type = 'button'
    el.className = 'docket-ref'
    el.title = `go to ${slug}`
  }
  el.setAttribute(MEN, slug)
  el.setAttribute(SIG, mentionSig(ref, live))
  if (ref.kind === 'item' && ref.title !== undefined) {
    el.setAttribute('data-copy-ticket-title', ref.title)
  }
  el.textContent = slug
  return el
}

/** every chip this module has injected into `host`, in document order */
function injected(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll(`[${TOK}],[${MEN}]`)] as HTMLElement[]
}

/** undo every injection, exactly, leaving the text the author wrote.
 *  `normalize()` re-joins the split text nodes so the next pass sees whole
 *  strings — without it a token that had been chipped would arrive as three
 *  neighbouring text nodes and match nothing. */
export function unlinkifyRefs(host: HTMLElement): number {
  const chips = injected(host)
  for (const el of chips) {
    el.replaceWith(host.ownerDocument.createTextNode(
      el.getAttribute(TOK) ?? el.getAttribute(MEN) ?? el.textContent ?? ''))
  }
  if (chips.length) host.normalize()
  // the host no longer claims to have scanned for anything
  host.removeAttribute(SCAN)
  return chips.length
}

/** Decide every canonical token inside `host` and render it as a chip.
 *
 *  Returns the number of chips present afterwards, or -1 for "nothing needed
 *  doing" — which is a DIFFERENT fact and the one that protects the reader's
 *  selection, so it is reported rather than folded into 0.
 *
 *  ⚠ `clickable` FOLLOWS THE CALLER'S HANDLER. With no `onOpen` there is
 *  nothing to click, so a chip is rendered as inert text rather than as a
 *  button that swallows the click and does nothing. */
export function linkifyRefs(host: HTMLElement, world: RefWorld,
  clickable = true, mentions?: MentionWorld | null): number {
  const doc = host.ownerDocument
  const items = itemsOf(mentions)
  const scan = mentionScan(items, !!mentions?.onPick)
  const existing = injected(host)
  if (existing.length) {
    // ⚠ THE CHEAP EXIT, AND THE ONLY ONE. Every chip still says what it would
    // say if rebuilt, AND nothing new could be found in the prose between
    // them → touch nothing. A pass that rebuilt regardless would drop the
    // reader's selection on every poll that changed nothing; a pass that
    // trusted the chips alone would never notice a name entering the index
    // (see `mentionScan`).
    const same = host.getAttribute(SCAN) === scan && existing.every((el) => {
      const name = el.getAttribute(MEN)
      if (name !== null) {
        // a bare name is judged against the index the caller holds NOW: an
        // item that has gone, or a surface that lost its handler, must stop
        // being a control rather than keep a chip nothing stands behind
        const ref = items?.get(name)
        return !!ref && el.getAttribute(SIG) === mentionSig(ref, !!mentions?.onPick)
      }
      const parsed = parseRef(el.getAttribute(TOK) ?? '')
      if (!parsed) return false
      const r = resolveRef(parsed, world)
      // ⚠ THE WHOLE RENDERED ANSWER, not just the outcome — see `chipSig`.
      // `clickable` is part of it: one `ready` reference is a control on a
      // surface with a handler and inert text on one without.
      return el.getAttribute(SIG)
        === chipSig(r, r.outcome === 'ready' && clickable && !r.atDestination)
    })
    if (same) return -1
    unlinkifyRefs(host)
  }
  const texts: Text[] = []
  const walk = doc.createTreeWalker(host, 4 /* SHOW_TEXT */)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text
    // ⚠ THE `@` SHORTCUT ONLY HOLDS FOR TYPED TOKENS. A bare docket name
    // carries no sigil at all, so a surface that scans for them must look at
    // every text node — skipping on `@` there would silently link nothing.
    if (!t.data || (!items && !t.data.includes('@'))) continue
    if (inSkipped(t)) continue
    texts.push(t)
  }
  let count = 0
  for (const t of texts) {
    const s = t.data
    const parts: Node[] = []
    let made = 0
    /** the prose BETWEEN typed tokens — where bare names may still be found.
     *  Typed tokens are matched first and their spans are never re-scanned,
     *  so the slug inside `@item:org/slug` can never also become a mention. */
    const plain = (text: string) => {
      if (!text) return
      if (!items) { parts.push(doc.createTextNode(text)); return }
      for (const part of splitRefs(text, items)) {
        if (part.ref) {
          parts.push(mentionEl(doc, part.ref, mentions?.onPick))
          made += 1
        } else parts.push(doc.createTextNode(part.text))
      }
    }
    let last = 0
    // ⚠ THE SHARED SCANNER, not a second loop over the same pattern: both
    // boundaries live in `scanRefs`, and a renderer with its own loop is one
    // that can miss one of them.
    for (const hit of scanRefs(s)) {
      if (hit.index > last) plain(s.slice(last, hit.index))
      parts.push(chipEl(doc, resolveRef(hit.ref, world), clickable))
      made += 1
      last = hit.index + hit.token.length
    }
    if (last < s.length) plain(s.slice(last))
    if (!made) continue
    const frag = doc.createDocumentFragment()
    for (const node of parts) frag.appendChild(node)
    t.replaceWith(frag)
    count += made
  }
  // ⚠ RECORDED EVEN WHEN NOTHING WAS DECORATED. "I looked for these names and
  // found none" is the fact the next pass needs; without it a host with no
  // chips would be indistinguishable from one never scanned, and the exit
  // above would have nothing to compare when chips do appear.
  host.setAttribute(SCAN, scan)
  return count
}

/** The click, delegated. One listener on the container rather than one per
 *  chip: the chips are replaced wholesale on every re-run, so per-element
 *  handlers would have to be re-attached each time and a missed one is a dead
 *  control that looks alive.
 *
 *  ⚠ THE OUTCOME IS DECIDED AGAIN AT CLICK TIME, against the world the caller
 *  holds NOW. The chip is a picture of a past decision; acting on the picture
 *  would open a target that has since gone. */
export function refClickHandler(worldOf: () => RefWorld | null | undefined,
  onOpen: (r: ResolvedRef) => void,
  mentionsOf?: () => MentionWorld | null | undefined) {
  return (e: Event): void => {
    const el = (e.target as Element | null)?.closest?.(`[${TOK}],[${MEN}]`)
    if (!el) return
    const name = el.getAttribute(MEN)
    if (name !== null) {
      // ⚠ DECIDED AGAIN AT CLICK TIME, like a typed reference: the index the
      // chip was drawn against may no longer hold the name.
      const m = mentionsOf?.()
      if (!m?.onPick || m.index.get(name)?.kind !== 'item') return
      e.stopPropagation()
      e.preventDefault()
      m.onPick(name)
      return
    }
    const parsed = parseRef(el.getAttribute(TOK) ?? '')
    if (!parsed) return
    // ⚠ THE WORLD IS CHECKED BEFORE IT IS USED. The listener outlives the
    // world it was attached with, and `resolveRef` reads `world.org`
    // immediately — so a click on a stale chip throws before any later guard.
    const world = worldOf()
    if (!world) return
    const r = resolveRef(parsed, world)
    // ⚠ `atDestination` IS REFUSED HERE, not only by the renderer that draws
    // it as a span. This listener is delegated on the container, so a click
    // can reach it from a chip the renderer did not draw this pass — and a
    // reference to where you already are is not somewhere to go.
    if (r.outcome !== 'ready' || r.atDestination) return
    // the body sits inside a row/pane that selects on click — a reference
    // must not also change the selection under the reader
    e.stopPropagation()
    e.preventDefault()
    onOpen(r)
  }
}

/** The whole thing, bound to one rendered container.
 *
 *  Put the returned ref on the element whose innerHTML `md()` produced. The
 *  pass runs after EVERY render, deliberately: this side cannot know whether
 *  React replaced the html (which wipes the chips) or left it alone (which
 *  does not), and asking is guesswork where the cheap exit is a fact. When
 *  nothing changed the pass reads the chips it already made and returns.
 *
 *  The listener is attached ONCE and reads the current world through a ref,
 *  because the chips it serves are replaced under it on every rebuild. */
export function useRefMd(world: RefWorld | null | undefined,
  onOpen?: (r: ResolvedRef) => void,
  mentions?: MentionWorld | null) {
  const host = useRef<HTMLDivElement | null>(null)
  const worldRef = useRef(world)
  worldRef.current = world
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  // read through a ref for the same reason the world is: the listener is
  // attached once and outlives every index it was attached with
  const mentionRef = useRef(mentions)
  mentionRef.current = mentions
  useEffect(() => {
    const el = host.current
    if (!el) return
    const h = refClickHandler(() => worldRef.current,
      (r) => { if (worldRef.current) openRef.current?.(r) },
      () => mentionRef.current)
    el.addEventListener('click', h)
    return () => el.removeEventListener('click', h)
  }, [])
  useEffect(() => {
    if (!host.current) return
    // ⚠ NO WORLD MEANS NO JUDGEMENT, not a world of nothing. A caller that
    // has not been given an org cannot tell a local reference from a foreign
    // one, and an empty `RefWorld` would answer "another org" to every token
    // in the app's own prose.
    //
    // ⚠ AND LOSING THE WORLD TAKES THE CHIPS WITH IT: buttons that still look
    // live and have nothing behind them. Undoing the injection restores
    // exactly the token the author wrote.
    // ⚠ AND IT TAKES THE BARE NAMES WITH IT. A surface that has lost its
    // world reverts ALL of its chips, not the typed half: half-live prose is
    // harder to read than plain prose, and says nothing true about the rest.
    if (world) linkifyRefs(host.current, world, !!onOpen, mentions)
    else unlinkifyRefs(host.current)
  })
  return host
}

/** A markdown body with its references live — the whole thing in one element,
 *  for the surfaces that render `md()` into a div and nothing else.
 *
 *  `html` is what `md()` returned. It is passed in rather than produced here
 *  because the call sites already choose their own image base, and the base
 *  is per-author. */
export function RefMdBody({ html, world, onOpen, className, el, mentions }: {
  html: { __html: string }
  world?: RefWorld | null
  onOpen?: (r: ResolvedRef) => void
  className?: string
  /** bare docket names to mark as well as canonical tokens. Omitted by every
   *  surface but the docket's own description, which is where prose naming an
   *  item by its plain slug is the normal way to write. */
  mentions?: MentionWorld | null
  /** the element to render, because a call site's LAYOUT is not this
   *  component's business: the folded-notice list puts its body in a `span`
   *  inside a flex row, and quietly promoting it to a `div` would be this
   *  wrapper changing a page it was only meant to decorate. */
  el?: 'div' | 'span'
}) {
  const host = useRefMd(world, onOpen, mentions)
  const Tag = (el ?? 'div') as 'div'
  return <Tag ref={host} className={className}
    dangerouslySetInnerHTML={html} />
}

export { refToken }
