// descfold-probe.tsx — the page `descfold_probe.py` measures in a real browser.
//
// WHY A BROWSER PROBE EXISTS FOR THIS AT ALL. The description folds at ten
// RENDERED lines, and "rendered" is the whole difficulty: a paragraph that
// wraps four times is four lines, inline code and links put several client
// rects on one visual row, and a blank line between paragraphs is margin
// rather than a line. jsdom computes none of that — it reports every box as
// zero — so `docketdesc.test.tsx` has to supply synthetic rects, and a
// synthetic rect can only ever confirm the arithmetic I wrote. Whether the
// arithmetic is asking the right question of a real layout engine is a
// different claim, and only a browser can settle it.
//
// Nothing here asserts. The assertions live in the .py file; this file only
// has to be an honest host: the REAL `DocketDescription` and the REAL
// `ReceivedMailBody`, bundled with the REAL styles.css, inside the chrome the
// docket actually puts them in (`.overlay > .settings.wide.docket-modal`),
// at a width narrow enough that prose genuinely wraps.
//
// ⚠ THE WRAPPING CASE IS THE POINT. `wrap` is ONE paragraph with no newlines
// in it. Counting newlines in the source would call it one line; a browser
// wraps it well past ten. If the fold ever regresses to counting source
// lines, that panel is the one that catches it and no jsdom test can.

import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { DocketDescription } from '../src/canvas/docketdesc'
import { ReceivedMailBody } from '../src/canvas/mailpreview'
import { md } from '../src/canvas/shared'
import { buildMentionIndex } from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'
import type { RefWorld } from '../src/canvas/reflinks'

const WORLD: RefWorld = { org: 'orgtree', items: new Map(), agents: new Map() }
const INDEX = buildMentionIndex([
  { slug: 'the-other-ticket', title: 'The other ticket' } as WorkItem,
])

/** `n` short paragraphs — one rendered line each at this width. */
const paras = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of ${n}.`).join('\n\n')

/** ONE paragraph, no newlines, long enough that the browser wraps it far past
 *  ten lines. The case that separates "rendered lines" from "source lines". */
const WRAP = 'Problem: the description was capped and flattened. Solution: '
  + 'store it whole and render it as Markdown. '
  + Array.from({ length: 60 }, (_, i) =>
    `Requirement ${i + 1} is stated here in full so that a reader holding only `
    + `this description can build the right thing without asking.`).join(' ')

/** every markdown block, to measure that they are laid out as blocks. */
const RICH = [
  '# Problem',
  'It was **plain** text with `code` and a [link](https://example.invalid/x).',
  '## Requirements',
  '- first rule mentioning the-other-ticket',
  '- second rule',
  '1. ordered',
  '> quoted ruling',
  '```js',
  'const kept = true',
  '```',
  '| field | rule |',
  '| --- | --- |',
  '| objective | uncapped |',
].join('\n')

/** the received-mail body, whose five-line fold shares `foldAt` with the
 *  description's ten. The extraction that generalised it is the reason this
 *  panel is on the page. */
const MAIL_LONG = paras(12)
const MAIL_SHORT = paras(3)

/** ⚠ THE CHROME IS THE POINT, AND IT DIFFERS PER SURFACE.
 *
 *  The docket pane really is a `.settings wide docket-modal` inside an
 *  `.overlay`, so `.settings button` really does apply to anything the
 *  description draws — which is exactly the cascade this probe caught. The
 *  received-mail preview does NOT live there: it is a desk transcript row.
 *  Hosting it in a `.settings` modal would give it chrome it never wears in
 *  the app and would make this page lie in the reassuring direction. */
function Panel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div className="probe-slot">
      <div className="overlay">
        <div className="settings wide docket-modal" data-panel={id}>
          <div className="docket-desc">
            <div className="docket-list-heading dim">DESCRIPTION</div>
            {children}
            {/* THE ENVIRONMENT CONTROL, in the page rather than the
                assertions: a bare button in the same modal. If IT does not
                measure as `.settings button` chrome then that rule never
                applied in this run, and nothing this page says about beating
                it means anything. */}
            <button type="button" className="descfold-control">control</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MailPanel({ id, text }: { id: string; text: string }) {
  return (
    <div className="probe-slot">
      <div className="msgs" data-panel={id}>
        <ReceivedMailBody html={md(text)} world={WORLD} />
      </div>
    </div>
  )
}

const desc = (text: string, slug: string) => (
  <DocketDescription text={text} slug={slug} world={WORLD}
    index={INDEX} onPick={() => {}} />
)

createRoot(document.querySelector('#root')!).render(
  <>
    {/* under the threshold — must have no control and no clipping */}
    <Panel id="short">{desc(paras(4), 'short-item')}</Panel>
    {/* exactly at it — the boundary, still no control */}
    <Panel id="exactly-ten">{desc(paras(10), 'ten-item')}</Panel>
    {/* one past it — the first description that folds */}
    <Panel id="eleven">{desc(paras(11), 'eleven-item')}</Panel>
    {/* far past it */}
    <Panel id="long">{desc(paras(40), 'long-item')}</Panel>
    {/* ⚠ ONE paragraph that WRAPS past ten lines — no newlines at all */}
    <Panel id="wrap">{desc(WRAP, 'wrap-item')}</Panel>
    {/* every markdown block, laid out for real */}
    <Panel id="rich">{desc(RICH, 'rich-item')}</Panel>
    {/* the mail preview's own five-line fold, sharing the measurement */}
    <MailPanel id="mail-long" text={MAIL_LONG} />
    <MailPanel id="mail-short" text={MAIL_SHORT} />
  </>,
)
