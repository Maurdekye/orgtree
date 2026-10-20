// projectinboxwarning.test.tsx — the project desk's message box warns the user
// when the project's inbox has no listeners (Orgtree 4.4.0; docket
// `warn-senders-when-they-mail-a-project-whose-inbo`, user 2026-10-20 11:04Z:
// "make sure they're warned that their mail may not be read by anyone or
// delivered anywhere unless the inbox has any listeners attached"; the
// coordinator's suggestion: a small inline note).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 with no fair_queue dog on the project, a small note right above the
//      message box says its inbox has no listeners and that mail sent there
//      may not be read by anyone or delivered anywhere until one attaches;
//      after a send, the toast carries the engine's own note, warning and all;
//      the box's placeholder promises no agent that takes the mail;
//   §2 an attached listener, armed or paused, takes the note away (and the
//      placeholder says one agent under the project takes the mail); a
//      fair_queue dog on another project, a spent one-shot or an event dog
//      on this project does not;
//   §3 the megaphone (every agent under the project, not its inbox) takes the
//      note away while it is armed; a retired project's box shows none.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectinboxwarning

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { forgetDeskMemory } from '../src/canvas/desktabs'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpRequest, OpResult, ToastFn, TreePayload, Watchdog } from '../src/types'

const noop = () => {}
const refs = { world: { org: 'org' }, onOpen: noop } as never
const UNREAD = /website's inbox has no listeners: mail sent here may not be read by anyone or delivered anywhere until one attaches/

function project(extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'website', title: 'website', kind: 'project', state: 'live', tier: 'project', model_id: '',
    seat: 0, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, parent: 'boss', charter: '',
    children: [{ id: 'dev1', title: 'dev1', tier: 'haiku', state: 'live', busy: false, children: [] }],
    lineage: [], turns: [], audiences_held: [], mail_pending: 0,
    last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
    ...extra,
  } as unknown as CanvasNode
}
const boss = { id: 'boss', title: 'boss', tier: 'opus', state: 'live', children: [] } as unknown as CanvasNode

function projectMap(node: CanvasNode): Map<string, CanvasNode> {
  const entries: [string, CanvasNode][] = [[node.id, node], [boss.id, boss]]
  for (const child of node.children ?? []) entries.push([child.id, { ...child, parent: node.id } as CanvasNode])
  return new Map(entries)
}

const dog = (extra: Partial<Watchdog> & { state?: string; spent?: boolean }): Watchdog => ({
  id: 'dev1/inbox', owner: 'dev1', name: 'inbox', kind: 'fair_queue', target: 'website', interval_s: 5,
  state: 'armed', at: '2026-10-20T11:00:00.000Z', fired: 0, once: false, spent: false, ...extra,
} as unknown as Watchdog)

const treeOf = (watchdogs: Watchdog[]) => ({ slug: 'org', roots: [], watchdogs, slot_leases: [] } as unknown as TreePayload)

/** The desk with these dogs in the tree; `sent` collects the user's posts to
 *  the project's inbox and answers them with `delivery`. */
async function desk(t: TestContext, h: { dogs?: Watchdog[]; node?: CanvasNode; toast?: ToastFn;
  delivery?: string; sent?: string[] } = {}) {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  const inner = globalThis.fetch
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://fixture.invalid').pathname
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body),
      { status: 200, headers: { 'Content-Type': 'application/json' } }))
    if ((init?.method ?? 'GET') === 'GET' && /\/nodes\/[^/]+\/inbox$/.test(path)) {
      return json({ pending: [], delivered: [], sent: [], next_cursor: null })
    }
    if (init?.method === 'POST' && path === '/api/orgs/org/nodes/website/message') {
      h.sent?.push(String(init.body))
      return json({ accepted: true, id: 'm1', delivery: h.delivery ?? 'sent', audience_grant: null })
    }
    return inner(url, init)
  }) as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  forgetDeskMemory()
  const nd = h.node ?? project()
  const view = await mountView(<ProjectDesk node={nd} slug="org" tree={treeOf(h.dogs ?? [])} map={projectMap(nd)}
    op={(_b: OpRequest) => Promise.resolve({} as unknown as OpResult)} toast={h.toast ?? noop} refs={refs} />, (el) => el)
  t.after(() => view.unmount())
  await flush(2)
  return view.el
}

const note = (el: Element) => el.querySelector<HTMLElement>('.inbox-no-listeners')
const setText = (box: HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

/* ─── §1 no listener: the note, and the engine's note after a send ──────── */

test('§1a no fair_queue dog on the project: a note right above the message box warns that nobody may read the mail', async (t) => {
  const el = await desk(t)
  const composer = el.querySelector('.project-composer')
  assert.ok(composer, 'the message box (positive control)')
  const n = note(el)
  assert.ok(n, 'the inbox warning is shown')
  assert.match(n!.textContent ?? '', UNREAD)
  assert.equal(n!.getAttribute('role'), 'note')
  assert.equal(n!.nextElementSibling === composer, true, 'it sits right above the message box')
  assert.match(n!.title, /fair_queue/, 'its tooltip says what a listener is')
})

test('§1b the toast after a send carries the engine\'s note, warning and all', async (t) => {
  const toasts: string[][] = []
  const sent: string[] = []
  const delivery = 'Warning: project website\'s inbox has no listeners, so this mail may not be read by anyone or delivered anywhere '
    + 'until one attaches. It waits in the mailbox; dev1 was woken and asked to attach one (a fair_queue watchdog), '
    + 'and the mail goes to whoever attaches first.'
  const el = await desk(t, { toast: (lines) => { if (lines) toasts.push(lines) }, delivery, sent })
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  await inAct(() => { setText(box, 'Who takes this?') })
  await inAct(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await flush(4)
  assert.equal(sent.length, 1, 'one post to the project\'s inbox (positive control)')
  assert.deepEqual(toasts.at(-1), [`to project website: ${delivery}`])
})

test('§1c with nobody listening, the box\'s placeholder promises no agent that takes the mail', async (t) => {
  const el = await desk(t)
  assert.ok(note(el), 'the note is up (positive control)')
  const box = el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!
  assert.equal(box.placeholder, 'message project website…', 'not "one agent under it takes it…" right under the note')
})

/* ─── §2 what counts as a listener ─────────────────────────────────────── */

test('§2a an armed listener on the project takes the note away', async (t) => {
  const el = await desk(t, { dogs: [dog({})] })
  assert.ok(el.querySelector('.project-composer'), 'the message box (positive control)')
  assert.equal(note(el) === null, true, 'no warning while a listener is attached')
  assert.equal(el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!.placeholder,
    'message project website: one agent under it takes it…')
})

test('§2b a paused listener is still attached: no note', async (t) => {
  const el = await desk(t, { dogs: [dog({ state: 'paused' })] })
  assert.equal(note(el) === null, true, 'a paused fair_queue dog is attached to the inbox')
  assert.equal(el.querySelector<HTMLTextAreaElement>('.project-composer textarea')!.placeholder,
    'message project website: one agent under it takes it…', 'the mail waits for the listener to resume')
})

test('§2c dogs that are not this inbox\'s listeners leave the note up', async (t) => {
  const el = await desk(t, { dogs: [
    dog({ target: 'other' }),
    dog({ id: 'dev1/once', name: 'once', once: true, spent: true }),
    dog({ id: 'dev1/sync', name: 'sync', kind: 'project_listener' }),
  ] })
  assert.ok(note(el), 'another project\'s listener, a spent one-shot and an event dog are not listeners on this inbox')
})

/* ─── §3 the megaphone, a retired project ───────────────────────────────── */

test('§3a the megaphone sends to every agent instead of the inbox: no note while it is armed', async (t) => {
  const el = await desk(t)
  assert.ok(note(el), 'the note before (positive control)')
  const mega = el.querySelector<HTMLButtonElement>('button.cc-broadcast-toggle')!
  await inAct(() => { mega.click() })
  assert.equal(mega.getAttribute('aria-pressed'), 'true', 'the megaphone is armed')
  assert.equal(note(el) === null, true, 'no inbox warning for a broadcast')
  await inAct(() => { mega.click() })
  assert.ok(note(el), 'back on the inbox, the note is back')
})

test('§3b a retired project\'s box shows no note', async (t) => {
  const el = await desk(t, { node: project({ state: 'archived' } as Partial<CanvasNode>) })
  assert.ok(el.querySelector('.project-composer'), 'the (disabled) message box is there (positive control)')
  assert.equal(note(el) === null, true, 'nothing can be sent, so nothing to warn about')
})
