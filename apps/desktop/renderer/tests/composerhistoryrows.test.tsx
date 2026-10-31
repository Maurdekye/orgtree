// composerhistoryrows.test.tsx - UP ENTERS THE SENT-MESSAGE HISTORY ONLY FROM THE
// TOP VISUAL ROW (docket pressing-up-into-message-history-throws-away-the;
// USER 2026-10-30 08:30:07Z m9a02035a079d, chose "Top visible row": "Up walks
// up through wrapped rows first; history only from the very top row").
//
// The first version of the fix kept the draft safe but "first line" still meant
// the first LOGICAL line (up to a newline), so in a long first paragraph that
// wraps over several rows, Up from ANY row of it recalled history. These tests
// give the composers a deterministic fake layout (a text row holds ROW
// characters, a newline starts a new row) behind the real caret measurement
// (src/caretrow.ts), and drive both composers with real keydown events: Up from
// a lower row is left to the browser (the caret walks up a row), Up from the
// top row is history's; Down is the mirror image on the bottom row. The real
// browser layout is the Session 0 capture (PROJECTNODE_VISUAL_ONLY=history-rows).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs composerhistoryrows

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test, { after, before } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'
import { resetConvos } from '../src/convo'
import { historyKey } from '../src/composerhistory'

const W = window as unknown as Window & typeof globalThis
const noop = () => {}

// ---- the fake layout: every text row holds ROW characters; \n starts a row ----
const ROW = 20
const LINE = 18
/** the row a caret sits on after `text`: a full row keeps the caret at its end */
function rowAfter(text: string): number {
  let row = 0
  let col = 0
  for (const ch of text) {
    if (ch === '\n') { row++; col = 0; continue }
    if (col === ROW) { row++; col = 0 }
    col++
  }
  return row
}
const offsetTop = Object.getOwnPropertyDescriptor(W.HTMLElement.prototype, 'offsetTop')
before(() => {
  Object.defineProperty(W.HTMLTextAreaElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
  Object.defineProperty(W.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.hasAttribute('data-caret-probe')) return 0
      let preceding = ''
      for (let n = this.previousSibling; n; n = n.previousSibling) preceding = (n.textContent ?? '') + preceding
      return 4 + rowAfter(preceding) * LINE
    },
  })
})
after(() => {
  delete (W.HTMLTextAreaElement.prototype as { clientWidth?: number }).clientWidth
  if (offsetTop) Object.defineProperty(W.HTMLElement.prototype, 'offsetTop', offsetTop)
})

const writer: CanvasNode = {
  id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
}
const site = {
  id: 'website', title: 'website', kind: 'project', tier: 'project', state: 'live', model_id: '', seat: 0, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] }, charter: 'The site.',
  children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
} as unknown as CanvasNode

interface Composer {
  name: string
  id: string
  mount: () => Promise<{ el: HTMLElement; unmount: () => Promise<void> }>
  box: (el: HTMLElement) => HTMLTextAreaElement
}
const agentDesk: Composer = {
  name: 'agent desk', id: 'writer',
  async mount() {
    installFetch(new FakeServer())
    const view = await mountView(<DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} bare />, el => el)
    await inAct(async () => { await flush(3) })
    return view
  },
  box: el => el.querySelector('textarea') as HTMLTextAreaElement,
}
const projectDesk: Composer = {
  name: 'project desk', id: 'website',
  async mount() {
    installFetch(new FakeServer())
    const had = globalThis.fetch
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url), 'http://fixture.invalid')
      if ((init?.method ?? 'GET') === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(u.pathname)) {
        return Promise.resolve(new Response(JSON.stringify({ pending: [], delivered: [], sent: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return had(url, init)
    }) as typeof fetch
    forgetDeskMemory()
    const view = await mountView(<ProjectDesk node={site} slug="org" tree={{ slug: 'org', roots: [] } as unknown as TreePayload}
      map={new Map([[site.id, site]])} op={() => Promise.resolve({} as OpResult)} toast={noop}
      refs={{ world: { org: 'org' }, onOpen: noop } as never} bare onJump={noop} />, el => el)
    await inAct(async () => { await flush(4) })
    return view
  },
  box: el => el.querySelector('.project-composer textarea') as HTMLTextAreaElement,
}

async function press(el: HTMLTextAreaElement, key: string, caret: number) {
  el.selectionStart = caret
  el.selectionEnd = caret
  const event = new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  await inAct(async () => { el.dispatchEvent(event); await flush(3) })
  return event
}
async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
  await inAct(async () => {
    setter.call(el, value)
    el.dispatchEvent(new W.Event('input', { bubbles: true }))
    await flush(3)
  })
}
const note = (el: HTMLElement) => el.querySelector('.composer-history-note')?.textContent ?? null

async function open(t: TestContext, c: Composer, ...history: string[]) {
  localStorage.clear(); resetConvos()
  if (history.length) localStorage.setItem(historyKey('org', c.id), JSON.stringify(history.map(text => ({ text, delivered: true }))))
  const view = await c.mount()
  t.after(async () => { await view.unmount(); localStorage.clear(); resetConvos() })
  return { el: view.el, box: () => c.box(view.el) }
}

/** 50 characters = three rows (20 + 20 + 10) in the fake layout */
const LONG = 'x'.repeat(50)

for (const c of [agentDesk, projectDesk]) {
  test(`${c.name}: in a wrapped first paragraph Up walks up the rows, and only the top row enters history`, async (t) => {
    const v = await open(t, c, 'sent before')
    await type(v.box(), LONG)

    const third = await press(v.box(), 'ArrowUp', 45)
    assert.equal(third.defaultPrevented, false, 'row 3: the arrow is the caret\'s')
    assert.equal(v.box().value, LONG, 'and the draft is still there')
    const second = await press(v.box(), 'ArrowUp', 25)
    assert.equal(second.defaultPrevented, false, 'row 2: still the caret\'s')
    assert.equal(v.box().value, LONG)
    assert.equal(note(v.el), null, 'history was never entered')

    const top = await press(v.box(), 'ArrowUp', 5)
    assert.equal(top.defaultPrevented, true, 'row 1: history\'s')
    assert.equal(v.box().value, 'sent before')
    assert.match(note(v.el) ?? '', /^press down \/ esc to return to your draft$/)

    await press(v.box(), 'ArrowDown', v.box().value.length)
    assert.equal(v.box().value, LONG, 'Down gives the draft back')
    assert.equal(v.box().selectionStart, 5, 'with the caret on the row it left from')
  })

  test(`${c.name}: Down in a wrapped recalled message walks down the rows, and only the bottom row leaves it`, async (t) => {
    const v = await open(t, c, LONG)
    await press(v.box(), 'ArrowUp', 0)
    assert.equal(v.box().value, LONG, 'the long message is recalled')

    const top = await press(v.box(), 'ArrowDown', 5)
    assert.equal(top.defaultPrevented, false, 'row 1: Down is the caret\'s')
    assert.equal(v.box().value, LONG)
    const middle = await press(v.box(), 'ArrowDown', 30)
    assert.equal(middle.defaultPrevented, false, 'row 2: still the caret\'s')
    assert.equal(v.box().value, LONG)

    const bottom = await press(v.box(), 'ArrowDown', 50)
    assert.equal(bottom.defaultPrevented, true, 'row 3: history\'s')
    assert.equal(v.box().value, '', 'back to the (empty) draft')
  })

  test(`${c.name}: a newline and a wrap both count as rows`, async (t) => {
    const v = await open(t, c, 'sent before')
    const text = 'x'.repeat(30) + '\ntail'
    await type(v.box(), text)

    assert.equal((await press(v.box(), 'ArrowUp', text.indexOf('tail') + 2)).defaultPrevented, false, 'after a newline: the caret\'s')
    assert.equal((await press(v.box(), 'ArrowUp', 25)).defaultPrevented, false, 'the second row of the first line: the caret\'s')
    assert.equal(v.box().value, text)
    assert.equal((await press(v.box(), 'ArrowUp', 3)).defaultPrevented, true, 'the very top row: history\'s')
    assert.equal(v.box().value, 'sent before')
  })

  test(`${c.name}: control - a short one-row draft still enters history from any column`, async (t) => {
    const v = await open(t, c, 'sent before')
    await type(v.box(), 'short draft')
    assert.equal((await press(v.box(), 'ArrowUp', 11)).defaultPrevented, true, 'one row is the top row, caret at its end or not')
    assert.equal(v.box().value, 'sent before')
  })
}
