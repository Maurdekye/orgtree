// composerhistorykeep.test.tsx - WALKING INTO THE SENT-MESSAGE HISTORY NEVER
// COSTS YOU THE MESSAGE YOU WERE TYPING (docket
// pressing-up-into-message-history-throws-away-the; USER 2026-10-30 08:14:27Z
// mdad6a41f1f3e, verbatim: "if im typing a long message and accidentally hit up
// one too many times, it scrolls back to the previous message in the history
// and loses my in-progress typing message").
//
// What was wrong: the draft was set aside in a React ref. A recall also wrote
// the recalled text over the stored draft, so once the desk left the screen
// (another agent selected, the desk closed) the draft was gone for good; Down
// put the draft back at the END of the box rather than where the caret was;
// Escape did nothing; and an edit made to a recalled message was thrown away by
// the next Up or Down.
//
// Every test drives the REAL composer through real keydown events with a real
// caret, for BOTH composers that have Up-history: the agent desk and the
// project desk. The behaviour is one hook (composerhistorynav.ts), and these
// tests are what keep the two from drifting apart.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs composerhistorykeep

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult, TreePayload } from '../src/types'
import { resetConvos } from '../src/convo'
import { historyKey, readHistory } from '../src/composerhistory'

const W = window as unknown as Window & typeof globalThis
const noop = () => {}

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

/** The two composers under test: how to mount one, and its message box. */
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
      const answer = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
      if ((init?.method ?? 'GET') === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(u.pathname)) {
        return answer({ pending: [], delivered: [], sent: [] })
      }
      // the project's own message route: the fake server only knows agents
      if (init?.method === 'POST' && /\/nodes\/website\/message$/.test(u.pathname)) return answer({ delivery: 'queued' })
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

const seed = (id: string, ...texts: string[]) =>
  localStorage.setItem(historyKey('org', id), JSON.stringify(texts.map(text => ({ text, delivered: true }))))

/** Put the caret somewhere and press a key for real; the event is returned so
 *  a test can ask whether the composer CONSUMED it. */
async function press(el: HTMLTextAreaElement, key: string, caret?: number, init: KeyboardEventInit = {}) {
  if (caret !== undefined) { el.selectionStart = caret; el.selectionEnd = caret }
  const event = new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
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

/** one mounted composer per test, always unmounted and the stores wiped */
async function open(t: TestContext, c: Composer, ...history: string[]) {
  localStorage.clear(); resetConvos()
  if (history.length) seed(c.id, ...history)
  const views: { unmount: () => Promise<void> }[] = []
  const mount = async () => {
    const view = await c.mount()
    let gone = false
    const handle = { unmount: async () => { if (!gone) { gone = true; await view.unmount() } } }
    views.push(handle)
    return { el: view.el, box: () => c.box(view.el), unmount: handle.unmount }
  }
  t.after(async () => { for (const v of views) await v.unmount(); localStorage.clear(); resetConvos() })
  return mount
}

for (const c of [agentDesk, projectDesk]) {
  test(`${c.name}: Up into history keeps the draft, Down gives it back exactly - text AND caret`, async (t) => {
    const mount = await open(t, c, 'an older message', 'the newest sent')
    const v = await mount()
    const draft = 'my long draft in progress'
    await type(v.box(), draft)

    // caret in the middle of the first line: Up is history's
    const up = await press(v.box(), 'ArrowUp', 7)
    assert.equal(up.defaultPrevented, true, 'history took the key')
    assert.equal(v.box().value, 'the newest sent')
    assert.match(note(v.el) ?? '', /^press down \/ esc to return to your draft$/, 'the box says the draft is safe and how to get it back')

    await press(v.box(), 'ArrowDown', v.box().value.length)
    assert.equal(v.box().value, draft, 'the draft is back')
    assert.equal(v.box().selectionStart, 7, 'with the caret where it was, not at the end')
    assert.equal(v.box().selectionEnd, 7)
    assert.equal(note(v.el), null, 'and the note is gone')
  })

  test(`${c.name}: Escape while browsing history puts the draft back`, async (t) => {
    const mount = await open(t, c, 'an older message', 'the newest sent')
    const v = await mount()
    await type(v.box(), 'half a sentence')

    // control: Escape in an ordinary box is not history's
    const idle = await press(v.box(), 'Escape')
    assert.equal(idle.defaultPrevented, false, 'Escape is left alone when no history is on screen')

    await press(v.box(), 'ArrowUp', 4)
    await press(v.box(), 'ArrowUp', 0)
    assert.equal(v.box().value, 'an older message', 'two entries deep')

    const esc = await press(v.box(), 'Escape')
    assert.equal(esc.defaultPrevented, true, 'history took the Escape (so the desk does not also cancel a reply)')
    assert.equal(v.box().value, 'half a sentence')
    assert.equal(v.box().selectionStart, 4, 'caret where it was when history was entered')

    const again = await press(v.box(), 'Escape')
    assert.equal(again.defaultPrevented, false, 'a second Escape has nothing to undo')
    assert.equal(v.box().value, 'half a sentence')
  })

  test(`${c.name}: leaving the desk and coming back keeps the draft and the walk`, async (t) => {
    const mount = await open(t, c, 'the newest sent')
    const first = await mount()
    await type(first.box(), 'the thing I was actually writing')
    await press(first.box(), 'ArrowUp', 3)
    assert.equal(first.box().value, 'the newest sent')

    // another agent is selected: this composer unmounts; later it comes back
    await first.unmount()
    const second = await mount()
    assert.equal(second.box().value, 'the newest sent', 'the box shows what was on screen when it left')
    assert.match(note(second.el) ?? '', /^press down \/ esc to return to your draft$/, 'and still knows a draft is set aside')

    await press(second.box(), 'ArrowDown', second.box().value.length)
    assert.equal(second.box().value, 'the thing I was actually writing', 'Down brings the draft back after the round trip')
    assert.equal(second.box().selectionStart, 3)
  })

  test(`${c.name}: editing a recalled message is kept while you walk on and never rewrites the history`, async (t) => {
    const mount = await open(t, c, 'older', 'newest')
    const v = await mount()
    await type(v.box(), 'draft')
    await press(v.box(), 'ArrowUp', 0)
    assert.equal(v.box().value, 'newest')
    await type(v.box(), 'newest, reworded')

    await press(v.box(), 'ArrowUp', 0)
    assert.equal(v.box().value, 'older', 'one entry further back')
    await press(v.box(), 'ArrowDown', v.box().value.length)
    assert.equal(v.box().value, 'newest, reworded', 'the edit was kept while you walked away from it')

    assert.deepEqual(readHistory('org', c.id).map(e => e.text), ['older', 'newest'], 'the stored history is untouched')

    await press(v.box(), 'ArrowDown', v.box().value.length)
    assert.equal(v.box().value, 'draft', 'and past it the draft you started with is still there')
  })

  test(`${c.name}: sending a recalled message sends the edit and finishes the walk`, async (t) => {
    const mount = await open(t, c, 'older', 'newest')
    const v = await mount()
    await type(v.box(), 'draft')
    await press(v.box(), 'ArrowUp', 0)
    await type(v.box(), 'newest, reworded')
    await press(v.box(), 'Enter')
    await inAct(async () => { await flush(6) })

    assert.equal(v.box().value, '', 'the box clears on send')
    assert.deepEqual(readHistory('org', c.id).map(e => e.text), ['older', 'newest', 'newest, reworded'],
      'the edited text is what was sent and recorded')
    assert.equal(note(v.el), null, 'no draft is set aside any more')
    const esc = await press(v.box(), 'Escape')
    assert.equal(esc.defaultPrevented, false, 'Escape has nothing to restore')
    assert.equal(v.box().value, '')

    // the walk starts afresh from the newest entry
    await press(v.box(), 'ArrowUp', 0)
    assert.equal(v.box().value, 'newest, reworded')
  })

  test(`${c.name}: an empty box has nothing to keep - no note, and Down returns to empty`, async (t) => {
    const mount = await open(t, c, 'only message')
    const v = await mount()
    await press(v.box(), 'ArrowUp', 0)
    assert.equal(v.box().value, 'only message')
    assert.equal(note(v.el), null, 'no draft, so no note')
    await press(v.box(), 'ArrowDown', v.box().value.length)
    assert.equal(v.box().value, '')
  })
}
