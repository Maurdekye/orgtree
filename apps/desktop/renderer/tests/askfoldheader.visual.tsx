import React from 'react'
import { createRoot } from 'react-dom/client'
import { AskCard } from '../src/canvas/asks'
import type { RefRoutes, RefWorld } from '../src/canvas/reflinks'
import type { AskInfo, AskQuestion } from '../src/types'

const ORG = 'orgtree'

const POPOUT_SLUG = 'pop-out-windows-clicking-the-x-closes-the-pop-ou'
const POPOUT_TITLE = 'Pop-out windows: clicking the X closes the pop-out window instead of returning the panel to the main window'
const HARNESS_SLUG = 'language-model-server-entries-harness-can-be-edi'
const HARNESS_TITLE = 'Language model server entries: harness can be edited after setup'

const world: RefWorld = {
  org: ORG,
  agents: new Map([['liaison-opus', 'liaison-opus'], ['coordinator-opus', 'coordinator-opus']]),
  items: new Map([
    [POPOUT_SLUG, POPOUT_TITLE],
    [HARNESS_SLUG, HARNESS_TITLE],
  ]),
  itemTitles: new Map([
    [POPOUT_SLUG, POPOUT_TITLE],
    [HARNESS_SLUG, HARNESS_TITLE],
  ]),
  docs: new Map(),
  refName: (ref) => {
    if (ref.kind === 'item' && ref.id === POPOUT_SLUG) {
      return { label: POPOUT_TITLE, why: `open docket item "${POPOUT_TITLE}"`, flare: { cls: 'docket-status-open', text: 'open' } }
    }
    if (ref.kind === 'item' && ref.id === HARNESS_SLUG) {
      return { label: HARNESS_TITLE, why: `open docket item "${HARNESS_TITLE}"`, flare: { cls: 'docket-status-in_progress', text: 'in progress' } }
    }
    return undefined
  },
}

const refs: RefRoutes = {
  world,
  onOpen: () => {},
}

function makeBatchAsk(id: string, qs: AskQuestion[]): AskInfo {
  const items = [...new Set(qs.flatMap((q) => (q.work_item ? [q.work_item] : [])))]
  return {
    id,
    node: 'liaison-opus',
    at: '2026-10-30T00:00:00Z',
    status: 'open',
    kind: 'batch',
    rev: 1,
    revs: { ask: 1 },
    questions: qs,
    tabs: qs.map((q) => ({ kind: 'question' as const, ...q })),
    question: qs[0]?.question,
    header: qs[0]?.header,
    ...(items.length ? { work_items: items } : {}),
  }
}

const SINGLE_NO_TICKET: AskInfo = makeBatchAsk('q-single-no-ticket', [
  {
    header: 'Release branch',
    question: 'Should we cut the 4.5.2 release candidate from integ/4.5.2 once the current queue drains?',
    options: [
      { label: '(Recommended) Cut from integ/4.5.2' },
      { label: 'Wait for pending reviews' },
    ],
  },
])

const SINGLE_WITH_TICKET: AskInfo = makeBatchAsk('q-single-with-ticket', [
  {
    header: 'Pop-out X',
    question: 'Should clicking the header X on a pop-out window close that window or return the panel to the main window?',
    options: [
      { label: '(Recommended) Close the pop-out window' },
      { label: 'Return panel to main window' },
    ],
    work_item: POPOUT_SLUG,
  },
])

const MULTI_TWO_TICKETS: AskInfo = makeBatchAsk('q4892a96d73f0', [
  {
    header: 'Pop-out X',
    question: 'Should clicking the header X on a pop-out window close that window or return the panel to the main window?',
    options: [
      { label: '(Recommended) Close the pop-out window' },
      { label: 'Return panel to main window' },
    ],
    work_item: POPOUT_SLUG,
  },
  {
    header: 'Server harness',
    question: 'When a user changes an existing Language Model Server entry\'s harness after setup, what should happen to live agents?',
    options: [
      { label: '(Recommended) Take effect on next turn' },
      { label: 'Refuse while live agents exist' },
    ],
    work_item: HARNESS_SLUG,
  },
])

function Harness() {
  const params = new URLSearchParams(window.location.search)
  const variant = params.get('variant') || 'after'
  return (
    <div
      data-visual-root="true"
      data-variant={variant}
      style={{
        padding: '3px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        background: 'var(--bg)',
        color: 'var(--ink)',
        minHeight: '100vh',
        boxSizing: 'border-box',
      }}
    >
      <style>{`
        [data-visual-root="true"] .askcard { margin: 2px 0; padding: 4px 10px; gap: 3px; }
        [data-visual-root="true"] .ask-q p { margin: 2px 0; }
        [data-visual-root="true"] .ask-row { padding: 2px 7px; }
        [data-visual-root="true"] .ask-submit { padding: 3px 10px; }
      `}</style>
      <div style={{ width: '900px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div data-section="single-no-ticket">
          <div className="dim" style={{ fontSize: '10.5px', lineHeight: 1.2 }}>
            (a) Single-question card without a ticket (900 px)
          </div>
          <AskCard ask={SINGLE_NO_TICKET} slug={ORG} toast={() => {}} refs={refs} />
        </div>

        <div data-section="single-with-ticket">
          <div className="dim" style={{ fontSize: '10.5px', lineHeight: 1.2 }}>
            (b) Single-question card with a ticket (900 px)
          </div>
          <AskCard ask={SINGLE_WITH_TICKET} slug={ORG} toast={() => {}} refs={refs} />
        </div>

        <div data-section="multi-two-tickets">
          <div className="dim" style={{ fontSize: '10.5px', lineHeight: 1.2 }}>
            (c) Multi-question card with two tickets (900 px)
          </div>
          <AskCard ask={MULTI_TWO_TICKETS} slug={ORG} toast={() => {}} refs={refs} />
        </div>
      </div>
    </div>
  )
}

localStorage.clear()
const container = document.getElementById('root')!
createRoot(container).render(<Harness />)
;(window as unknown as { __ASK_FOLD_HEADER_VISUAL_READY__?: boolean }).__ASK_FOLD_HEADER_VISUAL_READY__ = true
