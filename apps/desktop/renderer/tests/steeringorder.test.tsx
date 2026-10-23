import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

test('mid-task send receipt precedes report jump cards and clears on the next draft', async t => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.busy = true
  server.messages = [{ role: 'assistant', text: 'The task is running.', seq: 0, event_id: 'reply-1' }]
  const original = globalThis.fetch
  installFetch(server)
  const fallback = globalThis.fetch
  let sends = 0, jumped = ''
  globalThis.fetch = (async (input, init) => {
    if (init?.method === 'POST' && String(input).endsWith('/message')) {
      sends++
      return new Response(JSON.stringify({ id: 'sent-1', steering: true }), { status: 200 })
    }
    return fallback(input, init)
  }) as typeof fetch
  const report = { id: 'reviewer', parent: 'worker', tier: 'sol', state: 'live', children: [] } as unknown as CanvasNode
  const worker = { id: 'worker', tier: 'sol', state: 'live', generation: 1, busy: true,
    children: [report], seat: 2, grant: 8, free: 6, scope: { tools: {}, add_dirs: [] },
    configured_scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode
  const view = await mountView(<DeskChat node={worker} map={new Map([[worker.id, worker], [report.id, report]])}
    slug="steering-order" op={async () => ({})} toast={() => {}} bare onJump={id => { jumped = id }} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = original; resetConvos() })
  await inAct(async () => { await flush(8) })
  const box = view.el.querySelector<HTMLTextAreaElement>('fieldset textarea')!
  const setText = async (text: string) => inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text)
    box.dispatchEvent(new window.Event('input', { bubbles: true })); await flush(4)
  })
  assert.equal(view.el.querySelector('.sendmode'), null)
  await setText('Use the latest findings.')
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('.cc-send')!.click(); await flush(8) })
  const receipt = view.el.querySelector<HTMLElement>('.sendmode')!
  const jump = view.el.querySelector<HTMLButtonElement>('.desk-nav-chip[data-copy-agent-name="reviewer"]')!
  const transcript = view.el.querySelector('[data-transcript-row]')!
  assert.equal(receipt?.textContent, 'steering in mid-task')
  assert.equal(!!transcript && !!jump, true, 'real transcript and report jump card are present')
  const before = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.equal(before(transcript, receipt), true, 'the receipt follows the transcript')
  assert.equal(before(receipt, jump), true, 'the receipt is above the report jump cards')
  assert.equal(before(jump, box), true, 'jump cards remain above the message box')
  await inAct(() => jump.click())
  assert.equal(jumped, 'reviewer', 'jump navigation is unchanged')
  await setText('A follow-up draft')
  assert.equal(view.el.querySelector('.sendmode'), null, 'typing clears the prior receipt as before')
  assert.equal(sends, 1, 'navigation and typing do not send another message')
})
