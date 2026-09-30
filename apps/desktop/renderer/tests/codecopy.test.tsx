// codecopy.test.tsx — THE COPY BUTTON ON A CHAT CODE BLOCK COPIES THE BLOCK
// (docket v3-copy-button-on-code-blocks-in-the-agent-chat, user report
// 2026-09-30 on alpha.8: the copy icon on a code block in an agent's chat did
// nothing).
//
// THE CAUSE. The button has no handler of its own: md() output is innerHTML,
// so one delegated `click` listener on the document (shared.ts,
// copyCodeFromEvent) serves every code block. It listened in the BUBBLE phase,
// and every PinFrame panel — the Attention view's desk, mail, the docket,
// presentations — stops click propagation at its panel (modalpin.tsx). Inside
// one, the click never reached the document and nothing was copied. The
// listener now runs in the CAPTURE phase, as popped-out windows already did.
//
//   §1  in the Attention view's desk, a multi-line block is copied exactly
//       (indentation kept, no trailing newline, no added markup) and the
//       button shows the ✓ state.
//   §2  THE CONTROL: that desk really does swallow a bubbling click, so §1 is
//       a test of the capture listener and not of a frame that lets clicks
//       through. (Measured against the pre-fix listener: §1 fails, §2 passes.)
//   §3  a one-line block — the shape in the user's screenshot — copies too.
//   §4  a desk outside any frame (the canvas desk) still copies.
//
// jsdom has no layout and so no `innerText`; the handler reads innerText
// because a diff <pre> renders each line as a <div>. For these plain blocks
// innerText equals textContent, so the test supplies that one getter.
// The real browser path is covered by hand with a playwright probe (see the
// ticket's evidence).
//
// Run:  node apps/desktop/renderer/tests/run.mjs codecopy
import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage, OpFn, TreePayload } from '../src/types'
import { forgetAttentionMode, setAttentionLayout, setOrgView } from '../src/attention/mode'
import { AttentionView } from '../src/attention/AttentionView'
import { forgetModalPins } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'

const W = window as unknown as Window & typeof globalThis
const SLUG = 'org1'

const proto = W.HTMLElement.prototype as unknown as Record<string, unknown>
if (!Object.getOwnPropertyDescriptor(proto, 'innerText')) {
  Object.defineProperty(proto, 'innerText', { configurable: true,
    get(this: HTMLElement) { return this.textContent } })
}

function stubClipboard(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const nav = W.navigator as unknown as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', { configurable: true,
    value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } } })
  return { writes, restore: () => {
    if (had) Object.defineProperty(nav, 'clipboard', had)
    else delete nav.clipboard
  } }
}

const MULTI = 'Get-ChildItem -Path "C:\\a b"\n  | Where-Object { $_.Length -gt 0 }\n\t<not markup> & done'
const REPLY: ChatMessage = { role: 'assistant', seq: 0, event_id: 'r1',
  text: 'Run this:\n\n```powershell\n' + MULTI + '\n```\n\nand then:\n\n```\n/a\n```' }

const node = (id: string, parent: string | null, o: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, tier: 'opus', state: 'live', generation: 0, children: [],
  seat: 1, grant: 10, free: 4, ...o,
} as CanvasNode)

const tree = (): TreePayload => ({
  slug: SLUG, name: 'Org 1', epoch: 1, rev: 1, roots: [],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
  max_top_grant: 1000,
} as unknown as TreePayload)

const op: OpFn = () => Promise.resolve({ ok: true } as never)

/** the Attention view — its desk panel inside the real PinFrame, as App.tsx
 *  mounts it (CurrentOrg is what gives PinFrame its MovableSurface) — showing
 *  `alpha`'s chat with REPLY */
async function attentionDesk() {
  localStorage.clear(); forgetAttentionMode(); forgetModalPins(); resetConvos()
  const server = new FakeServer()
  server.messages = [REPLY]
  installFetch(server)
  setOrgView(SLUG, 'attention')
  setAttentionLayout(SLUG, { agent: 'alpha', listOpen: false })
  const map = new Map([
    node(USER, null, { tier: null, state: 'user' }),
    node('alpha', USER),
  ].map((n) => [n.id, n] as [string, CanvasNode]))
  const view = await mountView(
    <CurrentOrg.Provider value={SLUG}>
      <AttentionView slug={SLUG} tree={tree()} op={op} toast={() => {}} map={map} />
    </CurrentOrg.Provider>,
    () => document.body as HTMLElement)
  await inAct(async () => { await refreshConvo(SLUG, 'alpha'); await flush(8) })
  return view
}

const buttons = (root: ParentNode) =>
  [...root.querySelectorAll('button.code-copy')] as HTMLButtonElement[]

/** the buttons inside the Attention view's DESK panel — the fixture fails
 *  loudly rather than finding a button somewhere else in the document */
function deskButtons(): HTMLButtonElement[] {
  const desk = document.querySelector('.attn-panel-desk')
  assert.ok(desk, 'fixture: the Attention view rendered its desk panel')
  return buttons(desk!)
}

async function clickCopy(btn: HTMLButtonElement) {
  await inAct(() => { btn.click() })
  await inAct(() => flush(3))
}

test('§1 the Attention desk copies a multi-line block exactly and shows ✓', async () => {
  const clip = stubClipboard()
  const v = await attentionDesk()
  try {
    const btns = deskButtons()
    assert.equal(btns.length, 2, 'fixture: both code blocks rendered in the Attention desk, each with its button')
    await clickCopy(btns[0]!)
    assert.deepEqual(clip.writes, [MULTI], 'the block text, byte for byte')
    assert.ok(btns[0]!.classList.contains('copied'), 'the button shows the copied state')
  } finally { clip.restore(); await v.unmount(); resetConvos() }
})

test('§2 control: that desk really swallows a bubbling click', async () => {
  const clip = stubClipboard()
  const v = await attentionDesk()
  let bubbled = 0, captured = 0
  const onBubble = () => { bubbled++ }
  const onCapture = () => { captured++ }
  document.addEventListener('click', onBubble)
  document.addEventListener('click', onCapture, true)
  try {
    const btn = deskButtons()[0]!
    await clickCopy(btn)
    assert.equal(captured, 1, 'the click happened')
    assert.equal(bubbled, 0, 'and never bubbled to the document — a bubble listener hears nothing here')
  } finally {
    document.removeEventListener('click', onBubble)
    document.removeEventListener('click', onCapture, true)
    clip.restore(); await v.unmount(); resetConvos()
  }
})

test('§3 a one-line block copies too', async () => {
  const clip = stubClipboard()
  const v = await attentionDesk()
  try {
    const btns = deskButtons()
    await clickCopy(btns[1]!)
    assert.deepEqual(clip.writes, ['/a'])
  } finally { clip.restore(); await v.unmount(); resetConvos() }
})

test('§4 a desk outside any frame still copies', async () => {
  const clip = stubClipboard()
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  server.messages = [REPLY]
  installFetch(server)
  const writer = node('writer', null)
  const view = await mountView(
    <DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  try {
    await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    const btns = buttons(view.el)
    assert.equal(btns.length, 2)
    await clickCopy(btns[0]!)
    assert.deepEqual(clip.writes, [MULTI])
  } finally { clip.restore(); await view.unmount(); resetConvos() }
})
