/* attract/ticketdom.ts - drives the open ticket pane to a change.

   USER 2026-11-03 m73037cb0a404 / m472583486fbb: expand the section holding the
   change, scroll to its exact first position at the presentation reading pace
   (attract/scroll.ts SCROLL_PX_PER_S) and put the
   sections (and a clipped description's fold) back as they were when attract moves on. Works on the DOM the pane
   already draws, the way scroll.ts does for the presentation reader:
     - a section is a `section` with an `h4.docket-detail-section-title` and a
       `.docket-detail-toggle` button (canvas/docket.tsx DocketSection); expanding
       is clicking that button, so the pane's own state stays the one truth;
     - a text field is the element DocketSelection stamps with
       `data-docket-field` (+ `data-docket-entry`).
   Nothing is drawn on the change itself (USER 2026-11-03 m786d6661d885: "dont highlight the
   actual changed passage, just scroll down to where it is"). Setting scrollTop is no
   user input (attract.ts listens for none of it). */
import { SCROLL_MAX_MS, SCROLL_PAUSE_MS, scrollMs } from './scroll'
import type { TicketChange } from './ticketsnap'

export interface TicketShow {
  /** resolves to the scroll's length in ms once the pane is found and expanded (0 = nothing to scroll) */
  length: Promise<number>
  /** moving on: sections back as they were, scroll stopped */
  restore: () => void
  /** the user took the pane over (touched, or canvas interaction ended the run): the sections stay as
   *  they are; the scroll stops, and a later restore changes nothing */
  release: () => void
}

const NONE: TicketShow = { length: Promise.resolve(0), restore() {}, release() {} }
/** how long to wait for the pane to draw the change */
const FIND_MS = 4_000
const LEAD = 24

/** characters ignored on BOTH sides when the changed text is looked up in the drawn text: whitespace (the drawn text has
 *  no newline where the markdown had a paragraph break, and none between two block elements) and the markdown marks
 *  that are not drawn. A mark that IS drawn (a snake_case name) is skipped on the drawn side too, so it still matches. */
const SKIP = /[\s*_`#>~-]/
const compact = (s: string) => Array.from(s).filter(c => !SKIP.test(c)).join('')

/** the heading of a section, by the names ticketsnap uses (STATE is whichever state reason the pane shows) */
function sectionByName(root: ParentNode, name: string): HTMLElement | null {
  for (const h of root.querySelectorAll<HTMLElement>('.docket-detail-section-title')) {
    const t = (h.textContent ?? '').trim()
    const hit = name === 'STATE'
      ? t.startsWith('BLOCKED BECAUSE') || t.startsWith('ENDED WITHOUT COMPLETING') || t === 'WAITING FOR'
      : t === name
    if (hit) return h.closest<HTMLElement>('section')
  }
  return null
}

function fieldEl(root: ParentNode, id: string): HTMLElement | null {
  const [field, entry] = id.split('#')
  const sel = `[data-docket-field="${field}"]` + (entry === undefined ? '' : `[data-docket-entry="${entry}"]`)
  return root.querySelector<HTMLElement>(sel)
}

/** The characters `needle` spans inside `el`, found in the drawn text. The whole changed span is covered however long:
 *  a short one is searched whole; a long one by its first and its last 30 characters (so a list marker or a mark in the
 *  middle that the drawn text does not have cannot break the match), the Range running from the first to the last. */
function locate(el: Element, needle: string): Range | null {
  const want = compact(needle)
  if (!want) return null
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */)
  let text = ''
  const map: Array<[Text, number]> = []
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    for (let i = 0; i < n.data.length; i++) {
      const c = n.data[i]!
      if (SKIP.test(c)) continue
      text += c; map.push([n, i])
    }
  }
  const A = 30
  let start: number, last: number
  if (want.length <= 2 * A) {
    start = text.indexOf(want)
    last = start + want.length - 1
  } else {
    start = text.indexOf(want.slice(0, A))
    const tail = start < 0 ? -1 : text.indexOf(want.slice(-A), start + A)
    last = tail < 0 ? -1 : tail + A - 1
  }
  if (start < 0 || last < start) return null
  const a = map[start]!, b = map[last]!
  const r = doc.createRange()
  r.setStart(a[0], a[1]); r.setEnd(b[0], b[1] + 1)
  return r
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

export function showTicketChange(change: TicketChange | null, root: ParentNode = document): TicketShow {
  if (!change) return NONE
  let alive = true, released = false
  let frame = 0
  let wait: ReturnType<typeof setTimeout> | undefined
  const expanded: HTMLElement[] = []      // toggles this opened
  let settle: (ms: number) => void = () => {}

  const stopMotion = () => { alive = false; if (frame) cancelAnimationFrame(frame); clearTimeout(wait); settle(0) }

  const length = new Promise<number>((done) => {
    let settled = false
    const resolve = settle = (ms: number) => { if (!settled) { settled = true; done(ms) } }
    const started = Date.now()
    const find = () => {
      if (!alive) { resolve(0); return }
      const field = change.kind === 'text' ? fieldEl(root, change.field) : null
      const section = field ? field.closest<HTMLElement>('section') : sectionByName(root, change.section)
      const target = field ?? section
      if (!target || !section) {
        if (Date.now() - started >= FIND_MS) { resolve(0); return }
        wait = setTimeout(find, 200); return
      }
      const toggle = section.querySelector<HTMLElement>('.docket-detail-toggle')
      const opening = toggle?.getAttribute('aria-expanded') === 'false'
      if (opening && toggle) { toggle.click(); expanded.push(toggle) }
      // a long DESCRIPTION is clipped to ten lines behind its own 'show all N lines' control
      // (canvas/docketdesc.tsx): a change in the clipped part would stay hidden, so open that fold too
      // (the marked field WRAPS the description component, so its fold is inside the field; a field drawn inside a fold is covered too)
      const fold = target.querySelector<HTMLElement>('.docket-desc-fold.folded') ?? target.closest<HTMLElement>('.docket-desc-fold.folded')
      const more = fold?.querySelector<HTMLElement>('.docket-desc-toggle')
      const unfolding = more?.getAttribute('aria-expanded') === 'false'
      if (unfolding && more) { more.click(); expanded.push(more) }
      // the pane draws the opened body on its next render: measure after it
      wait = setTimeout(() => go(target, section), opening || unfolding ? 120 : 0)
    }
    const go = (target: HTMLElement, section: HTMLElement) => {
      if (!alive) { resolve(0); return }
      // the exact span when it can be found in the drawn text, else the whole field or section
      let range: Range | null = null
      if (change.kind === 'text') {
        range = locate(target, change.snippet)
        if (!range) { range = target.ownerDocument.createRange(); range.selectNodeContents(target) }
      }
      const pane = scrollParent(target)
      const rect = (range?.getBoundingClientRect?.() ?? null)
      const box = rect && rect.height > 0 ? rect : target.getBoundingClientRect()
      const here = pane ? pane.getBoundingClientRect().top : 0
      const room = pane ? Math.max(0, pane.scrollHeight - pane.clientHeight) : 0
      const to = pane ? Math.max(0, Math.min(room, box.top - here + pane.scrollTop - LEAD)) : 0
      if (!pane || to <= 0) { resolve(0); return }
      const total = Math.min(SCROLL_MAX_MS, scrollMs(to))
      resolve(total)
      pane.scrollTop = 0
      const run = Math.max(0, total - 2 * SCROLL_PAUSE_MS)
      wait = setTimeout(() => {
        const t0 = performance.now()
        const tick = (now: number) => {
          if (!alive) return
          const k = run > 0 ? Math.min(1, (now - t0) / run) : 1
          pane.scrollTop = to * k
          if (k < 1) frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
      }, SCROLL_PAUSE_MS)
    }
    find()
  })

  return {
    length,
    restore() {
      stopMotion()
      if (released) return
      for (const t of expanded) if (t.getAttribute('aria-expanded') === 'true') t.click()
      expanded.length = 0
    },
    release() { released = true; stopMotion() },
  }
}
