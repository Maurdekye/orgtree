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
import { parseRef, scanRefs } from './workrefs'
import { TIER_LETTER } from './shared'

/** the attribute that makes an injected chip findable again on the next pass.
 *  It holds the ORIGINAL TOKEN, so undoing the injection is exact — the chip's
 *  visible text may be a title or a label and cannot be trusted to reproduce
 *  what the author wrote. */
const TOK = 'data-ref-token'
const OUT = 'data-ref-outcome'
/** every rendered fact about one chip, for the cheap exit (`chipSig`) */
const SIG = 'data-ref-sig'

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
    r.tier ?? '', r.atDestination ? '1' : '0'].join('')
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

/** every chip this module has injected into `host`, in document order */
function injected(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll(`[${TOK}]`)] as HTMLElement[]
}

/** undo every injection, exactly, leaving the text the author wrote.
 *  `normalize()` re-joins the split text nodes so the next pass sees whole
 *  strings — without it a token that had been chipped would arrive as three
 *  neighbouring text nodes and match nothing. */
export function unlinkifyRefs(host: HTMLElement): number {
  const chips = injected(host)
  for (const el of chips) {
    el.replaceWith(host.ownerDocument.createTextNode(
      el.getAttribute(TOK) ?? el.textContent ?? ''))
  }
  if (chips.length) host.normalize()
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
  clickable = true): number {
  const doc = host.ownerDocument
  const existing = injected(host)
  if (existing.length) {
    // ⚠ THE CHEAP EXIT, AND THE ONLY ONE. Every chip still says what it would
    // say if rebuilt → touch nothing. A pass that rebuilt regardless would
    // drop the reader's selection on every poll that changed nothing.
    const same = existing.every((el) => {
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
    if (!t.data || !t.data.includes('@')) continue    // no token can be here
    if (inSkipped(t)) continue
    texts.push(t)
  }
  let count = 0
  for (const t of texts) {
    const s = t.data
    let last = 0
    let frag: DocumentFragment | null = null
    // ⚠ THE SHARED SCANNER, not a second loop over the same pattern: both
    // boundaries live in `scanRefs`, and a renderer with its own loop is one
    // that can miss one of them.
    for (const hit of scanRefs(s)) {
      frag = frag ?? doc.createDocumentFragment()
      if (hit.index > last) {
        frag.appendChild(doc.createTextNode(s.slice(last, hit.index)))
      }
      frag.appendChild(chipEl(doc, resolveRef(hit.ref, world), clickable))
      count += 1
      last = hit.index + hit.token.length
    }
    if (!frag) continue
    if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)))
    t.replaceWith(frag)
  }
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
  onOpen: (r: ResolvedRef) => void) {
  return (e: Event): void => {
    const el = (e.target as Element | null)?.closest?.(`[${TOK}]`)
    if (!el) return
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
  onOpen?: (r: ResolvedRef) => void) {
  const host = useRef<HTMLDivElement | null>(null)
  const worldRef = useRef(world)
  worldRef.current = world
  const openRef = useRef(onOpen)
  openRef.current = onOpen
  useEffect(() => {
    const el = host.current
    if (!el) return
    const h = refClickHandler(() => worldRef.current,
      (r) => { if (worldRef.current) openRef.current?.(r) })
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
    if (world) linkifyRefs(host.current, world, !!onOpen)
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
export function RefMdBody({ html, world, onOpen, className, el }: {
  html: { __html: string }
  world?: RefWorld | null
  onOpen?: (r: ResolvedRef) => void
  className?: string
  /** the element to render, because a call site's LAYOUT is not this
   *  component's business: the folded-notice list puts its body in a `span`
   *  inside a flex row, and quietly promoting it to a `div` would be this
   *  wrapper changing a page it was only meant to decorate. */
  el?: 'div' | 'span'
}) {
  const host = useRefMd(world, onOpen)
  const Tag = (el ?? 'div') as 'div'
  return <Tag ref={host} className={className}
    dangerouslySetInnerHTML={html} />
}

export { refToken }
