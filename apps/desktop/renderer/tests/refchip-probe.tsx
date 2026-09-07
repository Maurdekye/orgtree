// refchip-probe.tsx — the page `refchip_probe.py` measures in a real browser.
//
// It renders the REAL `RefChip` (bundled from ../src with the real
// styles.css) INSIDE the chrome the docket actually puts it in: an `.overlay`
// holding a `.settings wide docket-modal`. That nesting is the whole point.
// `.settings button` sets font-size, padding and a border-radius, and a chip
// is a `button` in mid-sentence — so the question this page exists to answer
// is whether a rule written to beat that cascade actually beats it, which
// jsdom cannot say: it computes no layout and applies no author stylesheet
// cascade of this kind.
//
// Nothing here asserts. The assertions live in the .py file; this file only
// has to be an honest host — the same component, the same sheet, and a bare
// `<button>` in the same paragraph as the positive control, so a run where
// `.settings button` never applied at all is detectable rather than silently
// reassuring.

import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import type { RefWorld } from '../src/canvas/reflinks'
import { parseRef } from '../src/canvas/workrefs'

const HERE = 'orgtree'
const chip = (token: string, world: RefWorld) =>
  resolveRef(parseRef(token)!, world)

const READY = chip('@item:orgtree/the-target-item',
  { org: HERE, items: new Map([['the-target-item', 'the-target-item']]) })
const ABSENT = chip('@item:orgtree/never-existed',
  { org: HERE, items: new Map() })
const PENDING = chip('@item:orgtree/still-loading',
  { org: HERE, items: 'loading' })
const FOREIGN = chip('@item:elsewhere/theirs', { org: HERE })
const ELSEWHERE = chip('@doc:orgtree/d1',
  { org: HERE, handles: new Set(['item']) })

function Fixture() {
  return (
    <div className="overlay">
      <div className="settings wide docket-modal">
        <div className="mailer-read">
          <div className="docket-desc">
            {/* THE MEASURED LINE. One sentence, one chip in the middle of it,
                exactly as an item's description renders. */}
            <div className="docket-desc-body" id="line-ready">
              blocked behind <RefChip r={READY} onOpen={() => {}} /> until
              Friday
            </div>
            {/* THE SAME SENTENCE WITH NO CHIP — the line height a chip must
                not change. */}
            <div className="docket-desc-body" id="line-plain">
              blocked behind the-target-item until Friday
            </div>
            {/* THE POSITIVE CONTROL: a bare button in the same place. If this
                does NOT measure as chrome, `.settings button` never applied
                and every measurement above is free. */}
            <div className="docket-desc-body" id="line-control">
              blocked behind <button type="button" id="bare">the-target-item</button> until
              Friday
            </div>
            <div className="docket-desc-body" id="line-absent">
              see <RefChip r={ABSENT} /> for the rest
            </div>
            <div className="docket-desc-body" id="line-pending">
              see <RefChip r={PENDING} /> for the rest
            </div>
            <div className="docket-desc-body" id="line-foreign">
              see <RefChip r={FOREIGN} /> for the rest
            </div>
            <div className="docket-desc-body" id="line-elsewhere">
              see <RefChip r={ELSEWHERE} /> for the rest
            </div>
            {/* ⚠ TWO CHIPS AND A PLAIN SPAN, so a chip is NOT the last element
                child of its container. A container that punctuates its
                children with a generated `::after` only reveals itself when
                something follows — with one chip per line, `:not(:last-child)`
                never matches and a separator check passes for free. */}
            <div className="docket-desc-body" id="line-two">
              <span>see</span> <RefChip r={ABSENT} /> and{' '}
              <RefChip r={READY} onOpen={() => {}} /> today
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
