// shelllayout-probe.tsx — the v3 shell measured in a REAL renderer.
//
// WHY THIS EXISTS. The stage review said it plainly: jsdom has no native
// bridge and does no layout, so nothing in the 2363-test renderer suite is
// evidence about how the shell actually behaves in a window. Three of my own
// claims are unfalsifiable there and are checked here instead, in Chromium,
// with the real stylesheets:
//
//   A. The compact header's labels collapse at narrow widths through a
//      CONTAINER QUERY. jsdom does not evaluate container queries at all and
//      performs no layout, so the suite could only assert that the markup
//      exists — never that it responds. And the accessibility half of the
//      claim ("hidden with CSS, never removed, so `aria-label` carries the
//      same words at every width") is exactly the kind of thing that is true
//      in the DOM and false on screen.
//
//   B. The organization list's FIRST USABLE DISPLAY. This is the acceptance
//      condition the reviewer could not close: does opening the list show
//      current values, or does it paint stale ones and correct them? A
//      mounted-hook test answers what the hook returns. Only a painted frame
//      answers what a person sees.
//
//   C. The status strip's connectivity error keeps its seat when the chips
//      overflow. jsdom reports every box as 0x0, so "pinned outside the
//      scrolling run" was a DOM-order assertion standing in for a layout one.
//
// Run:  node tools/run-probe.mjs apps/desktop/renderer/tests/shelllayout-probe.tsx <outdir>
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ShellAction, ShellHeader } from '../src/shell/header'
import { OrgRows } from '../src/shell/orgrows'
import { OrgStatusBar } from '../src/shell/statusbar'
import { OrgViewToggle } from '../src/shell/modetoggle'
import type { OrgListEntry, TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

interface Probe { phase: string; done: boolean; [k: string]: unknown }
const PROBE: Probe = { phase: 'start', done: false }
;(window as unknown as { PROBE: Probe }).PROBE = PROBE
const mark = (phase: string) => { PROBE.phase = phase; document.title = phase }

const host = document.getElementById('root')!
const root = createRoot(host)
const render = (node: React.ReactNode) => { flushSync(() => root.render(node)) }
const css = (el: Element, prop: string) =>
  getComputedStyle(el).getPropertyValue(prop).trim()
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)
const qa = (sel: string) => [...document.querySelectorAll(sel)]

const org = (slug: string, patch: Partial<OrgListEntry> = {}): OrgListEntry => ({
  slug, name: slug, nodes: 3, live: 4, kiosk: false, created: null, ...patch,
})

const TREE = {
  slug: 'studio', name: 'Studio', roots: [], tiers: {},
  audit: { no_overdraft: true, problems: [] },
  cost_usd_total: 12.5, cost_usd_unknown: false,
  headless: true,
  net: { hubs: [{ id: 'local', name: 'a rather long local hub name', address: 'x',
    enabled: true, hidden: false, connected: true, queued: 3 }] },
} as unknown as TreePayload

const actions = <>
  <ShellAction label="Work" icon={<span>W</span>} onClick={() => {}} />
  <ShellAction label="Inbox" icon={<span>I</span>} onClick={() => {}} />
  <ShellAction label="Presentations" icon={<span>P</span>} onClick={() => {}} />
  <ShellAction label="Usage" icon={<span>U</span>} onClick={() => {}} />
  <ShellAction label="Org settings" icon={<span>S</span>} onClick={() => {}} />
</>

async function run() {
  // ---------------------------------------------- A. the container query
  mark('A-wide')
  host.style.width = '1400px'
  render(
    <ShellHeader menu={<div className="shell-menu"><button className="shell-menu-button">Orgtree</button></div>}
      title="Studio"
      modes={<OrgViewToggle mode="canvas" setMode={() => {}} />}
      actions={actions} />)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  const labelsWide = qa('.shell-action-label').map((el) => css(el, 'display'))
  const wideBoxes = qa('.shell-action-label').map((el) => (el as HTMLElement).offsetWidth)
  const ariaWide = qa('.shell-action').map((el) => el.getAttribute('aria-label'))
  // the toggle is the one control that must NOT collapse — it is the
  // "prominent labelled" control the settled design names
  const modeWide = qa('.shell-mode').map((el) => (el as HTMLElement).offsetWidth)

  mark('A-narrow')
  host.style.width = '700px'
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const labelsNarrow = qa('.shell-action-label').map((el) => css(el, 'display'))
  const narrowBoxes = qa('.shell-action-label').map((el) => (el as HTMLElement).offsetWidth)
  const ariaNarrow = qa('.shell-action').map((el) => el.getAttribute('aria-label'))
  const modeNarrow = qa('.shell-mode').map((el) => (el as HTMLElement).offsetWidth)
  const narrowText = qa('.shell-mode').map((el) => el.textContent)

  PROBE.A = {
    labelsWide, labelsNarrow,
    // the whole point: present and laid out at wide, present but zero-box at narrow
    anyWideLabelDrawn: wideBoxes.some((w) => w > 0),
    allNarrowLabelsCollapsed: narrowBoxes.every((w) => w === 0),
    labelsStillInDom: qa('.shell-action-label').length,
    // ⚠ the accessibility claim, which is the half that could have been false
    ariaUnchanged: JSON.stringify(ariaWide) === JSON.stringify(ariaNarrow),
    ariaWide,
    // the prominent toggle keeps its words at both widths
    modeKeepsLabels: modeNarrow.every((w) => w > 0) && modeWide.every((w) => w > 0),
    modeText: narrowText,
  }

  // ------------------------------------- B. the FIRST USABLE DISPLAY
  //
  // The defect was: opening the list painted whatever rows were in memory —
  // possibly minutes old — and corrected them ~3s later. So the question a
  // painted frame has to answer is what the counts READ at the first frame
  // after open, while the post-open request is still in flight.
  mark('B-first-paint')
  host.style.width = '900px'
  const stale = [org('studio', { name: 'Studio', working: 9, live: 9 }),
    org('workshop', { name: 'Workshop', working: 7, live: 7 })]
  // 'loading' is precisely the state of "we hold rows, but they predate the
  // open and the answer has not arrived"
  render(<div className="shell-page"><nav className="shell-homepage-list">
    <OrgRows orgs={stale} slug={null} onPick={() => {}} onDelete={() => {}}
      freshness="loading" ageMs={0} />
  </nav></div>)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const firstPaintCounts = qa('.org-counts').map((el) => el.textContent)
  const firstPaintSpinners = qa('.org-activity .cc-spin').length
  const firstPaintNames = qa('.org-name-text').map((el) => el.textContent)

  mark('B-current')
  const fresh = [org('studio', { name: 'Studio', working: 2, live: 9 }),
    org('workshop', { name: 'Workshop', working: 0, live: 7 })]
  render(<div className="shell-page"><nav className="shell-homepage-list">
    <OrgRows orgs={fresh} slug={null} onPick={() => {}} onDelete={() => {}}
      freshness="current" ageMs={0} />
  </nav></div>)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const currentCounts = qa('.org-counts').map((el) => el.textContent)
  const currentSpinners = qa('.org-activity .cc-spin').length

  PROBE.B = {
    firstPaintCounts, firstPaintSpinners, firstPaintNames,
    currentCounts, currentSpinners,
    // ⚠ THE ACCEPTANCE CONDITION, as a rendered fact: no stale number was
    // ever painted, and the names were there throughout so the list stayed
    // usable for navigation while its status caught up
    noStaleNumberPainted: !firstPaintCounts.some((t) => t === '9/9' || t === '7/7'),
    namesPresentWhileLoading: firstPaintNames.filter(Boolean).length === 2,
  }

  // ------------------------------- C. the error keeps its seat on overflow
  mark('C-overflow')
  host.style.width = '420px'
  render(<div style={{ width: '420px' }}>
    <OrgStatusBar tree={TREE} orgs={[]}
      error="the backend stopped answering — signal timed out after 30s"
      onOpenConnections={() => {}} />
  </div>)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const chips = q<HTMLElement>('.shell-statusbar-chips')!
  const err = q<HTMLElement>('.shell-statusbar-error')!
  const bar = q<HTMLElement>('.shell-statusbar')!
  const barBox = bar.getBoundingClientRect()
  const errBox = err.getBoundingClientRect()
  PROBE.C = {
    chipsOverflow: chips.scrollWidth > chips.clientWidth,
    chipsScrollWidth: chips.scrollWidth,
    chipsClientWidth: chips.clientWidth,
    // ⚠ the claim: the chips are the part that yields, and the actionable
    // error is inside the visible bar rather than carried off the end of a
    // row nobody scrolls
    errorVisible: errBox.width > 0 && errBox.height > 0,
    errorWithinBar: errBox.right <= barBox.right + 1 && errBox.left >= barBox.left - 1,
    errorIsNotInsideScroller: !chips.contains(err),
    errorRole: err.getAttribute('role'),
  }

  mark('done')
  PROBE.done = true
}

run().catch((e) => {
  PROBE.error = String((e as Error)?.stack ?? e)
  PROBE.done = true
  document.title = 'error'
})
