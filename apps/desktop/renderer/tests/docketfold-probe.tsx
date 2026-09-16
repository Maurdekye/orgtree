// docketfold-probe.tsx — DOES THE UNGUARDED MEASUREMENT RUN AWAY, OR ONLY WASTE?
//
// jsdom cannot answer this. Its ResizeObserver is a stub that fires only when
// a test calls it, so it can never be re-triggered by the very re-render it
// caused — which is the whole question. This renders the REAL
// `DocketDescription` in a REAL Chromium, with a real ResizeObserver and real
// layout, and with `mentions` supplied so `linkifyRefs` actually rewrites the
// DOM inside the body that observer is watching.
//
// It then sits still and counts commits. Nothing pokes it after mount: if the
// chain is self-sustaining, the count keeps climbing on its own; if it is not,
// it settles and stops.
import { createRoot } from 'react-dom/client'
import { Profiler, StrictMode } from 'react'
import { DocketDescription } from '../src/canvas/docketdesc'
import { buildMentionIndex } from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'
import type { RefWorld } from '../src/canvas/reflinks'
import '../src/styles.css'

declare global { interface Window { PROBE: Record<string, unknown> } }
window.PROBE = { commits: 0, samples: [] as number[], errors: [] as string[] }
window.addEventListener('error', (e) => (window.PROBE.errors as string[]).push(String(e.message)))

const WORLD: RefWorld = { org: 'org1', items: new Map(), agents: new Map() }

// several bare item names, so chips are injected throughout the body and the
// size change they cause is not a rounding error
const NAMES = ['the-other-ticket', 'a-second-ticket', 'a-third-ticket']
const INDEX = buildMentionIndex(NAMES.map((slug) => ({ slug, title: slug }) as WorkItem))

const SPEC = [
  'Problem stated, then the proposed solution in one short paragraph.',
  ...Array.from({ length: 30 }, (_, i) =>
    `Requirement ${i + 1}: this one is blocked behind ${NAMES[i % NAMES.length]} `
    + 'and is written at enough length that it wraps across the pane more than once.'),
].join('\n\n')

const host = document.getElementById('root')!
// a realistically narrow, resizable pane — the docket pane's own shape
host.style.cssText = 'width:420px;padding:12px;'

createRoot(host).render(
  <StrictMode>
    <Profiler id="desc" onRender={() => { (window.PROBE.commits as number); window.PROBE.commits = (window.PROBE.commits as number) + 1 }}>
      <DocketDescription world={WORLD} slug="an-item" index={INDEX}
        onPick={() => {}} text={SPEC} />
    </Profiler>
  </StrictMode>)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  const samples = window.PROBE.samples as number[]
  // let mount settle, then sample the commit count once a second while doing
  // NOTHING. A self-sustaining chain shows as a count that keeps climbing.
  await sleep(600)
  window.PROBE.afterMount = window.PROBE.commits
  for (let i = 0; i < 4; i++) { await sleep(700); samples.push(window.PROBE.commits as number) }

  const body = document.querySelector('.docket-desc-body') as HTMLElement | null
  window.PROBE.chips = document.querySelectorAll('.docket-ref').length
  window.PROBE.folded = !!document.querySelector('.docket-desc-fold.folded')
  window.PROBE.hasToggle = !!document.querySelector('.docket-desc-toggle')
  window.PROBE.bodyLines = body ? body.getBoundingClientRect().height : -1

  // now a REAL resize of the pane, the thing the observer exists for, and
  // sample again — once for a genuine change, then a settle check
  const before = window.PROBE.commits as number
  host.style.width = '300px'
  await sleep(700)
  window.PROBE.afterResize = (window.PROBE.commits as number) - before
  const settled = window.PROBE.commits as number
  await sleep(1200)
  window.PROBE.afterSettle = (window.PROBE.commits as number) - settled

  // THE PATH THE GUARD ACTUALLY PAYS FOR. Both fold surfaces also re-measure
  // on a window `resize` event, and a window resize does not necessarily move
  // a fixed-width pane's text at all — so `measure()` runs, the answer is
  // identical, and an unguarded write re-renders for nothing. Ten of them,
  // with the pane untouched.
  const beforeWindow = window.PROBE.commits as number
  for (let i = 0; i < 10; i++) {
    window.dispatchEvent(new Event('resize'))
    await sleep(40)
  }
  await sleep(500)
  window.PROBE.afterTenWindowResizes = (window.PROBE.commits as number) - beforeWindow
  window.PROBE.done = true
})()
