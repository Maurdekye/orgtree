// htmlresponse.retained.test.tsx — render-inline-html-custom-responses,
// exercised through the REAL chat surface (DeskChat → Msg → RefMdBody),
// not a direct md() call. `htmlresponse.test.ts` proves the markdown
// pipeline transform in isolation; this proves it survives the path an
// actual reload takes: a message the SERVER already holds as durable
// history, fetched and rendered exactly as a page load would render it.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs htmlresponse.retained

import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }
const desk = () => <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
  op={async () => ({})} toast={() => {}} pub={false} bare />

const FENCE = '```orgtree-html-response\n<p id="w">it renders</p>\n```'

test('⭐ a message the server already holds as durable history renders its html-response fence as a sandboxed frame — the actual reload path, not a direct md() call', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  // exactly what a reload fetches: NOT a live/streaming row — a message
  // already sitting in `messages`, the way persisted history arrives
  server.messages = [
    { role: 'user', text: 'show me a live widget', seq: 0, event_id: 'prompt-1' },
    { role: 'assistant', text: `here it is:\n\n${FENCE}\n\nhope that helps`, seq: 1, event_id: 'final-1' },
  ]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.match(view.el.textContent!, /here it is/, 'the surrounding prose must still render')
    assert.match(view.el.textContent!, /hope that helps/)
    const frame = view.el.querySelector('iframe.html-response-frame') as HTMLIFrameElement
    assert.ok(frame, `no sandboxed frame in the rendered desk:\n${view.el.innerHTML}`)
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts')
    assert.ok(frame.srcdoc.includes('<p id="w">it renders</p>'))
    // the user's own prompt is untouched prose, not swept into anything
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 1)
  } finally {
    await view.unmount()
  }
})

test('⭐ a SECOND independent fetch of the same durable history (simulated reload) renders identically', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [
    { role: 'assistant', text: FENCE, seq: 0, event_id: 'final-1' },
  ]
  installFetch(server)
  // first "page load"
  let view = await mountView(desk(), el => el)
  await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
  const first = view.el.querySelector('iframe.html-response-frame') as HTMLIFrameElement
  assert.ok(first, 'first load did not render the frame')
  const firstSrcdoc = first.srcdoc
  await view.unmount()

  // a fresh mount against the SAME server state — the reload: nothing new
  // was posted, this is purely re-fetching retained history
  resetConvos()
  view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    const second = view.el.querySelector('iframe.html-response-frame') as HTMLIFrameElement
    assert.ok(second, 'reload did not render the frame')
    assert.equal(second.getAttribute('sandbox'), 'allow-scripts')
    assert.equal(second.srcdoc, firstSrcdoc, 'a reload of the same durable text must render byte-identically')
  } finally {
    await view.unmount()
  }
})

test('an ordinary durable message with no fence renders exactly as before, in the real component', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [
    { role: 'assistant', text: 'just plain **markdown** text, nothing special', seq: 0, event_id: 'final-1' },
  ]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0)
    assert.match(view.el.textContent!, /just plain markdown text, nothing special/)
    assert.ok(view.el.querySelector('.msgtext.md strong'), 'ordinary bold markdown still renders')
  } finally {
    await view.unmount()
  }
})
