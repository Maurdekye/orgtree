import { FakeServer, fireResize, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { authoredUserLabel } from '../src/events/segments'
import { decodeEventRow } from '../src/events/decode'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import { hiredRows, hireSegments, mailRow, requestEvent, requestSegments, requestText } from './youpreview-fixture'

test('hire notices attributed to the user do not become a repeated user preview', () => {
  assert.equal(hiredRows.every(row => decodeEventRow(row, 'operator').kind === 'known'), true)
  assert.equal(authoredUserLabel(hireSegments, 'operator'), null)
})

test('a mixed batch previews only its latest user-written communication', () => {
  const segments = [...requestSegments, { kind: 'mail', rows: [hiredRows[0],
    mailRow(requestEvent('Latest\n\nrequest'), 'request-2'), ...hiredRows.slice(1)] }]
  assert.equal(authoredUserLabel(segments, 'operator'), 'Latest request')
})

test('user-written notices and replies remain eligible while system messages do not', () => {
  const message = requestEvent('Quiet update')
  assert.equal(authoredUserLabel([{ kind: 'mail', rows: [mailRow({ ...message,
    variant: 'ordinary.notice' }, 'notice-1')] }], 'operator'), 'Quiet update')
  const reply = { v: 1, variant: 'reply.document', actor: { kind: 'user', id: '@user' },
    object: { kind: 'document', org: 'preview-fixture', id: 'doc-1', title: 'Checklist', node: 'qa-lead' },
    body: 'Please revise the checklist.', engine_authored: false } as const
  assert.equal(authoredUserLabel([{ kind: 'mail', rows: [mailRow(reply, 'reply-1')] }], 'operator'), reply.body)
  assert.equal(authoredUserLabel([{ kind: 'mail', rows: [mailRow({ ...message,
    actor: { kind: 'system', id: '@system' }, engine_authored: true }, 'system-1')] }], 'operator'), null)
})

test('desk preview retains the real user message before a four-hire notice batch', async t => {
  resetConvos()
  const server = new FakeServer()
  installFetch(server)
  server.userMsg(requestText).segments = requestSegments
  server.userMsg('Four hire notices').segments = hireSegments
  const slug = 'you-preview', id = 'qa-lead'
  await inAct(async () => { await refreshConvo(slug, id) })
  const proto = HTMLElement.prototype, saved = proto.getBoundingClientRect
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 600,
    width: 600, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('msgs')) return rect(100, 500)
    if (this.children.length === 1 && this.firstElementChild?.classList.contains('typed-input')) return rect(0, 50)
    if (this.matches('details.transcript-system-run')) return rect(0, 50)
    return saved.call(this)
  }
  const node = { id, kind: 'agent', state: 'live', tier: 'sol', children: [], seat: 2, grant: 0,
    scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  t.after(async () => { if (view) await view.unmount(); proto.getBoundingClientRect = saved; resetConvos() })
  view = await mountView(<DeskChat node={node} map={new Map([[id, node]])} slug={slug}
    op={async () => ({})} toast={() => {}} bare />, el => el)
  await inAct(async () => { await flush(3); fireResize(view!.el.querySelector('.msgs')!) })
  assert.equal(view.el.querySelector('.pinuser-t')?.textContent?.trim(), `↑ you: ${requestText}`)
  assert.equal(view.el.querySelectorAll('[data-event-variant="lifecycle.hired"]').length, 4,
    'all hire cards remain in the transcript')
})
