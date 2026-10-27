// presentedlist.test.tsx — the Presented screen's list (docket
// 4-5-0-presentations-identified-by-a-readable-slu, the addition assigned by
// @coordinator-opus 2026-10-27 md743332e2d26).
//
// §1 an HTML presentation's format chip on Presented list cards reads
//    "</> HTML", without the word presentation (USER 2026-10-27 mbebb35945cb1:
//    "remove the word presentation from here"); a compact chip stays "</>",
//    and both keep their accessible name.
// §2 the list column has a maximum width, so a maximised window gives the
//    extra room to the presentation (USER 2026-10-27 mb56fc243d55d: "give this
//    left list panel a maximum width so that there's plenty of room for the
//    presentation if the user maximizess the window"). The Presented documents
//    window and the desk's Presented tab share the one rule, and a narrower
//    panel still gives the list its third. These read styles.css as jsdom
//    applies it (its cascade, without layout); the capture
//    (tools/rig/presentedwidth-visual.mjs) measures the drawn columns.
//
// Run:  node apps/desktop/renderer/tests/run.mjs presentedlist
import { fireResize, flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ReactElement } from 'react'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { MockupBadge } from '../src/canvas/docs'
import type { DocRow } from '../src/api'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
function stylesheet() { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); return () => style.remove() }

// newest first: the Markdown card is the one a fresh window opens on
const ROWS: DocRow[] = [
  { id: 'weekly-status', node: 'writer', title: 'Weekly status', at: '2026-10-27T09:00:00.000Z', format: 'markdown',
    evicted: false, node_state: 'live', bytes: 40, viewed_at: '2026-10-27T09:00:00.000Z' },
  { id: 'launch-dashboard', node: 'writer', title: 'Launch dashboard', at: '2026-10-27T08:00:00.000Z', format: 'html',
    evicted: false, node_state: 'live', bytes: 900, viewed_at: '2026-10-27T08:00:00.000Z' },
]

function stub(t: TestContext) {
  const old = globalThis.fetch
  t.after(() => { globalThis.fetch = old })
  globalThis.fetch = ((url: string) => {
    const id = String(url).match(/\/documents\/([^/?]+)$/)?.[1]
    const row = ROWS.find((r) => r.id === id)
    const body = id === undefined ? { documents: ROWS, total: ROWS.length, next_offset: null, offset: 0 }
      : row ? { id: row.id, node: row.node, title: row.title, at: row.at, format: row.format, body: '# Weekly status' }
        : { detail: `no document ${id}` }
    return Promise.resolve({ ok: id === undefined || !!row, status: id === undefined || row ? 200 : 404,
      headers: new Headers(), json: () => Promise.resolve(body) })
  }) as typeof fetch
}

const noop = () => {}
const surfaces: [string, () => ReactElement][] = [
  ['the Presented documents window', () => <DocGalleryModal slug="org1" toast={noop} close={noop} />],
  ["the desk's Presented tab", () => <AgentGalleryView slug="org1" nid="writer" toast={noop} />],
]

for (const [name, surface] of surfaces) {
  test(`§1 ${name}: the HTML card's format chip reads "</> HTML", without the word presentation`, async (t) => {
    stub(t)
    const view = await mountView(surface(), (host) => host)
    t.after(() => view.unmount())
    await inAct(async () => { await flush(10) })
    const chip = view.el.querySelector<HTMLElement>('.doc-gallery-row.doc-mockup .l2 .mockup-format')
    assert.ok(chip, 'the HTML card has its format chip')
    assert.equal(chip.textContent, '</> HTML')
    assert.equal(chip.getAttribute('aria-label'), 'HTML presentation', 'its accessible name still says what it is')
    for (const card of view.el.querySelectorAll('.doc-gallery-row')) {
      for (const badge of card.querySelectorAll('.l2 .mockup-format, .l2 .badge')) {
        assert.doesNotMatch(badge.textContent ?? '', /presentation/i, 'no format chip on a card carries the word')
      }
    }
  })

  test(`§2 ${name}: the list column stops at 400px and is still a third of a narrower panel`, async (t) => {
    stub(t)
    const unstyle = stylesheet()
    t.after(unstyle)
    // jsdom lays nothing out: the panel reports the centred window's 1250px,
    // wide enough for the list to be a column rather than the narrow overlay
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains('mailer') ? { ...original.call(this), width: 1250 } as DOMRect : original.call(this)
    }
    t.after(() => { HTMLElement.prototype.getBoundingClientRect = original })
    const view = await mountView(surface(), (host) => host)
    t.after(() => view.unmount())
    await inAct(async () => { await flush(10) })
    const box = view.el.querySelector<HTMLElement>('.mailer')
    assert.ok(box, 'the reading surface rendered')
    await inAct(() => fireResize(box))
    assert.equal(box.classList.contains('narrow-list'), false, 'a column, not the narrow overlay')
    const list = box.querySelector<HTMLElement>('.mailer-list')
    assert.ok(list, 'the list column rendered')
    const s = window.getComputedStyle(list)
    assert.equal(s.maxWidth, '400px', 'a maximised window does not widen the list past its cap')
    assert.equal(s.width, '33.333333%', 'a narrower panel still gives the list a third')
  })
}

test('§1 a compact chip stays "</>", with the same accessible name', async (t) => {
  const view = await mountView(<MockupBadge compact />, (host) => host)
  t.after(() => view.unmount())
  const chip = view.el.querySelector<HTMLElement>('.mockup-format.compact')
  assert.equal(chip?.textContent, '</>')
  assert.equal(chip?.getAttribute('aria-label'), 'HTML presentation')
})
