import './harness'
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal } from '../src/canvas/docket'
import type { WorkItem, TreePayload } from '../src/types'
// MUI's owner-document portal checks this browser constructor.
Object.assign(globalThis, { DocumentFragment: window.DocumentFragment })

const fixture = (slug = 'addressed-reply'): WorkItem => ({
  slug, title: slug, rev: 1, kind: 'code', objective: 'Check addressed replies',
  status: 'in_progress', blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'owner', generation: 0 }, owner_current: true, owner_state: 'live',
  reviewer: null, participants: ['collaborator', 'retired', 'gone'],
  reply_recipients: [
    { node: 'owner', role: 'owner', state: 'live' },
    { node: 'collaborator', role: 'participant', state: 'live' },
    { node: 'retired', role: 'participant', state: 'retired' },
    { node: 'gone', role: 'participant', state: 'missing' },
  ],
  created_by: 'user', at: '2026-09-06T12:00:00Z', updated_at: '2026-09-06T12:00:00Z',
  done_so_far: [], working_on_next: ['Send reply'], docket_at: null,
  last_updater: null, manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [], acceptance: [], dependencies: [],
  evidence: [], parent: null, superseded_by: null, history: [], delivery: null, accepted: null,
})

async function setup(t: TestContext, items: WorkItem[]) {
  useFakeClock()
  const sent: { body: string; to: string }[] = []
  const toasts: string[] = []
  const server = { fail: false, holdReply: null as Promise<void> | null }
  globalThis.fetch = (async (url, init) => {
    const isReply = String(url).endsWith('/reply')
    const payload = isReply ? JSON.parse(String(init?.body)) : null
    if (isReply) { sent.push(payload); await server.holdReply }
    return { ok: !(isReply && server.fail), status: isReply && server.fail ? 422 : 200,
      headers: new Headers(), json: async () => isReply
        ? server.fail ? { detail: 'Recipient removed — the reply was not sent' }
          : { accepted: true, to: payload.to, deferred: payload.to === 'retired' }
        : { items, counts: { attention: 0, active: items.length, archived: 0 }, now: '2026-09-06T12:00:00Z' },
    } as Response
  }) as typeof fetch
  const view = await mountView(<DocketModal slug="org" close={() => {}} tree={{ roots: [], asks: [] } as unknown as TreePayload}
    toast={(lines) => { toasts.push(...(lines ?? [])) }} />, (host) => host)
  t.after(async () => { try { await view.unmount() } finally { realClock() } })
  await flush()
  await inAct(() => { (view.el.querySelector('.mailrow.docket-row') as HTMLElement).click() })
  await flush()
  return { el: view.el, sent, toasts, server }
}
const picker = (el: HTMLElement) => el.querySelector('.docket-reply-select input') as HTMLInputElement
const trigger = (el: HTMLElement) => el.querySelector('[role="combobox"][aria-label="Reply to"]') as HTMLElement
async function openPicker(el: HTMLElement) {
  await inAct(() => trigger(el).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
  await flush()
}
const area = (el: HTMLElement) => el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
const button = (el: HTMLElement) => el.querySelector('.mail-reply button') as HTMLButtonElement
async function choose(el: HTMLElement, value: string) {
  await openPicker(el)
  await inAct(() => { (document.querySelector(`[role="option"][data-value="${value}"]`) as HTMLElement).click() })
  await flush()
}
async function type(el: HTMLElement, value = 'Keep this draft') {
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area(el), value)
    area(el).dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}
async function send(el: HTMLElement) { await inAct(() => button(el).click()); await flush() }

test('participant display and default owner; hidden retired predecessor selectable, gone disabled', async (t) => {
  const { el, toasts } = await setup(t, [fixture()])
  assert.equal(picker(el).value, 'owner')
  await openPicker(el)
  const options = document.querySelectorAll('[role="option"]')
  assert.equal(options.length, 4)
  assert.notEqual(options[2]!.getAttribute('aria-disabled'), 'true')
  assert.equal(options[3]!.getAttribute('aria-disabled'), 'true')
  assert.match(options[2]!.getAttribute('aria-label')!, /retired; waits for rehire/)
  assert.match(el.querySelector('.docket-participants')!.textContent!, /collaborator/)
  assert.ok(el.querySelector('.docket-participant .fit-retired'))
  await choose(el, 'retired'); await type(el); await send(el)
  assert.match(toasts.at(-1)!, /retired is archived — the reply waits for rehire/)
  assert.equal(picker(el).value, 'owner')
})

test('rejection keeps selection and draft; retry sends exactly the chosen participant and resets owner', async (t) => {
  const { el, sent, toasts, server } = await setup(t, [fixture()])
  await choose(el, 'collaborator'); await type(el)
  server.fail = true
  await send(el)
  assert.equal(area(el).value, 'Keep this draft')
  assert.equal(picker(el).value, 'collaborator')
  assert.match(toasts[0]!, /reply was not sent/)
  assert.deepEqual(sent, [{ body: 'Keep this draft', to: 'collaborator' }])
  server.fail = false
  await send(el)
  assert.equal(area(el).value, '')
  assert.equal(picker(el).value, 'owner')
  assert.equal(toasts.at(-1), 'sent to collaborator')
  assert.equal(sent.length, 2)
})

test('removing all participants during draft preserves unavailable choice and blocks click and Enter', async (t) => {
  const item = fixture()
  const { el, sent } = await setup(t, [item])
  await choose(el, 'collaborator'); await type(el)
  item.participants = []
  item.reply_recipients = [{ node: 'owner', role: 'owner', state: 'live' }]
  await advance(5100); await flush()
  assert.equal(picker(el).value, 'collaborator')
  assert.match(trigger(el).getAttribute('aria-description')!, /Unavailable recipient/)
  assert.equal(area(el).value, 'Keep this draft')
  assert.equal(area(el).disabled, false)
  assert.equal(button(el).disabled, true)
  await send(el)
  await inAct(() => { area(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  assert.equal(sent.length, 0)
  await choose(el, 'owner')
  assert.equal(area(el).value, 'Keep this draft')
  assert.equal(button(el).disabled, false)
  await send(el)
  assert.equal(sent[0]!.to, 'owner')
})

test('opening another ticket resets selection; reassignment does not redirect its existing owner draft', async (t) => {
  const first = fixture(), second = fixture('second')
  const { el } = await setup(t, [first, second])
  await choose(el, 'collaborator')
  await inAct(() => (el.querySelectorAll('.mailrow.docket-row')[1] as HTMLElement).click()); await flush()
  assert.equal(picker(el).value, 'owner')
  await type(el)
  second.owner = { node: 'new-owner', generation: 0 }
  second.participants = []
  second.reply_recipients = [{ node: 'new-owner', role: 'owner', state: 'live' }]
  await advance(5100); await flush()
  assert.equal(picker(el).value, 'owner')
  assert.equal(area(el).value, 'Keep this draft')
  assert.equal(button(el).disabled, true)
})

test('no participants retains simple presentation and explicit owner routing', async (t) => {
  const item = fixture(); item.participants = []; item.reply_recipients = item.reply_recipients!.slice(0, 1)
  const { el, sent } = await setup(t, [item])
  assert.equal(picker(el), null)
  assert.equal(el.querySelector('.docket-participants'), null)
  assert.match(el.querySelector('.docket-reply-label')!.textContent!, /Reply to owner · assigned to this item/)
  await type(el); await send(el)
  assert.equal(sent[0]!.to, 'owner')
})

test('ownerless ticket requires explicit participant selection', async (t) => {
  const item = fixture(); item.owner = null
  item.reply_recipients = [{ node: 'collaborator', role: 'participant', state: 'live' }]
  item.participants = ['collaborator']
  const { el } = await setup(t, [item])
  await type(el)
  assert.equal(picker(el).value, '')
  assert.equal(button(el).disabled, true)
  await choose(el, 'collaborator')
  assert.equal(button(el).disabled, false)
})


test('in-flight reply locks recipient and resets to latest observed owner after success', async (t) => {
  const item = fixture()
  const { el, server, sent, toasts } = await setup(t, [item])
  await choose(el, 'collaborator'); await type(el)
  let release!: () => void
  server.holdReply = new Promise<void>((resolve) => { release = resolve })
  await send(el)
  assert.equal(picker(el).disabled, true)
  assert.equal(area(el).disabled, true)
  assert.equal(button(el).disabled, true)
  item.owner = { node: 'new-owner', generation: 0 }
  item.reply_recipients![0] = { node: 'new-owner', role: 'owner', state: 'live' }
  await advance(5100); await flush()
  assert.equal(picker(el).value, 'collaborator')
  await inAct(() => { release() }); await flush()
  assert.equal(sent[0]!.to, 'collaborator')
  assert.equal(toasts.at(-1), 'sent to collaborator')
  assert.equal(picker(el).value, 'new-owner')
  assert.equal(picker(el).disabled, false)
  assert.equal(area(el).value, '')
})
