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

test('⭐ scope ruling, in the real component: a USER-authored durable message with the identical fence stays inert', async () => {
  // the ruling is explicit that mail/user/tool/document paths are inert —
  // this is the user-authored case, exercised through the real Msg
  // component rather than a direct md() call, so a future desk.tsx change
  // that stops passing `m.role === 'assistant'` correctly would fail HERE.
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [
    { role: 'user', text: FENCE, seq: 0, event_id: 'prompt-1' },
  ]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0,
      `a user's own message must never get the live frame, even with the exact agent tag: ${view.el.innerHTML}`)
    assert.match(view.el.textContent!, /it renders/, 'the fence still shows as a labeled code sample, just inert')
  } finally {
    await view.unmount()
  }
})

// ------------------------------------------------ redteam-opus finding #1
// The live-feed default row (the one branch that grants the agent-response
// flag) ALSO carries slash-command stdout — supervisor.py's two
// `local_command` live_row calls share `kind: "text"` with a genuine
// agent reply row and are indistinguishable without the `cmd_output`
// marker this fixes (found by redteam-opus's mutation review of ac588dd).

test('⭐ redteam-opus finding #1, fixed: live cmd_output shape #1 — plain local_command output mid-turn — stays inert even with the exact fence', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  // exactly supervisor.py's FIRST local_command live_row call (no `sticky`)
  // — kind "text", the SAME kind a genuine agent reply row carries
  server.live = [{ kind: 'text', cmd_output: true, text: FENCE, n: 1 } as never]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0,
      `slash-command output must never get the live frame: ${view.el.innerHTML}`)
    assert.match(view.el.textContent!, /it renders/)
  } finally {
    await view.unmount()
  }
})

test('⭐ redteam-opus finding #1, fixed: live cmd_output shape #2 — sticky /command output — also stays inert', async () => {
  // supervisor.py's SECOND local_command producer (the /command handler)
  // carries `sticky: true` as well — a distinct shape from #1, both must
  // be covered independently rather than assuming one test proves both
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.live = [{ kind: 'text', cmd_output: true, sticky: true, text: FENCE, n: 1 } as never]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0,
      `sticky slash-command output must never get the live frame: ${view.el.innerHTML}`)
    assert.match(view.el.textContent!, /it renders/)
  } finally {
    await view.unmount()
  }
})

test('⭐ positive control for both shapes above: an ordinary live agent-reply row (kind "text", no cmd_output) with the same fence DOES render the frame', async () => {
  // proves the instrument works and the rows differ ONLY by the
  // cmd_output marker — the exact bytes reviewer found "execute while the
  // turn is live" for the wrong reason must still execute for the RIGHT one
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.live = [{ kind: 'text', text: FENCE, n: 1 } as never]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 1,
      `a genuine live agent reply should still render the frame: ${view.el.innerHTML}`)
  } finally {
    await view.unmount()
  }
})

test('⭐ coordinator-astra ruling: a POSITIVE allowlist, not a blocklist — an unrecognized future live kind fails CLOSED even with no cmd_output marker at all', async () => {
  // the point of `f.kind === \'text\' && !f.cmd_output` over `!f.cmd_output`
  // alone: a kind this switch has never seen, with NEITHER cmd_output NOR
  // any other signal, must default to inert — not executable by omission
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.live = [{ kind: 'some_future_kind_nobody_named_yet', text: FENCE, n: 1 } as never]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0,
      `an unrecognized live kind must fail closed, not execute by default: ${view.el.innerHTML}`)
  } finally {
    await view.unmount()
  }
})

test('⭐ durable parity: the settled cmd_out row (post-reload) and the live cmd_output row agree — both inert', async () => {
  // the durable side (SysLine, desk.tsx) has always called md(m.cmd_out)
  // with no grant at all — this pins that explicitly, alongside the live
  // fix, so the two paths are never asserted to disagree again
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [
    { role: 'system', text: '', cmd_out: FENCE, seq: 0, event_id: 'cmd-1' } as never,
  ]
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0,
      `the durable cmd_out row must stay inert, matching the live row: ${view.el.innerHTML}`)
    assert.match(view.el.textContent!, /it renders/)
  } finally {
    await view.unmount()
  }
})

// ------------------------------------------------ redteam-opus finding #2
// The transient-row guard (desk.tsx, `row.role === 'assistant'`) is
// correct but was untested — nothing failed when the reviewer replaced it
// with `true`. The backend cannot currently produce a 'user' transient row
// (supervisor.py sets 'system' or 'assistant' only), so this pins the
// guard against a 'system' row instead — the one non-assistant role the
// backend really does emit here (kind 'error'/'starting').

test('⭐ redteam-opus finding #2, hardened: a transient SYSTEM row (not assistant) with the fence stays inert', async () => {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  const chat = server.chat.bind(server)
  server.chat = n => ({ ...chat(n), transient: [
    { event_id: 'err-1', role: 'system', kind: 'error', text: FENCE },
  ] })
  installFetch(server)
  const view = await mountView(desk(), el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    assert.equal(view.el.querySelectorAll('iframe.html-response-frame').length, 0,
      `a system transient row must never get the live frame: ${view.el.innerHTML}`)
  } finally {
    await view.unmount()
  }
})
