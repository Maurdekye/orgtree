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
// WIDENED (coordinator 2026-09-30 21:16Z): the audit of document-level click
// listeners found two more in the bubble phase with the same fault — local
// file links (shared.ts revealFileFromEvent) and the image viewer
// (lightbox.ts). Both now listen in capture, as popped-out windows did.
//   §5  a local file link in the Attention desk reveals its file.
//   §6  a picture in the Attention desk opens the viewer.
//   (Measured against the pre-fix listeners: §5 and §6 fail.)
//   §7  in a popped-out window, code copy and a local file link both work
//       (file links were missing from the popped-out document's listener).
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
import { md, USER } from '../src/canvas/shared'
import { refreshConvo, resetConvos } from '../src/convo'
import type { ChatMessage, OpFn, TreePayload } from '../src/types'
import { forgetAttentionMode, setAttentionLayout, setOrgView } from '../src/attention/mode'
import { AttentionView } from '../src/attention/AttentionView'
import { forgetModalPins, PinFrame } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { closeLightbox } from '../src/canvas/lightbox'

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
async function attentionDesk(messages: ChatMessage[] = [REPLY]) {
  localStorage.clear(); forgetAttentionMode(); forgetModalPins(); resetConvos()
  const server = new FakeServer()
  server.messages = messages
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

const LINKS: ChatMessage = { role: 'assistant', seq: 0, event_id: 'r2',
  text: 'Built [Setup.exe](<C:\\Users\\me\\out box\\Setup 1.exe>) and a plot:\n\n![plot](https://example.test/plot.png)' }

test('§5 a local file link in the Attention desk reveals its file', async () => {
  const revealed: string[] = []
  const w = window as unknown as { orgtreeDesktop?: unknown }
  w.orgtreeDesktop = { revealFile: (p: string) => { revealed.push(p); return Promise.resolve({ ok: true }) } }
  const v = await attentionDesk([LINKS])
  try {
    const desk = document.querySelector('.attn-panel-desk')!
    const a = desk.querySelector('a[data-local-path]') as HTMLAnchorElement
    assert.ok(a, 'fixture: the link rendered as a local file link inside the desk panel')
    await inAct(() => { a.click() })
    await inAct(() => flush(3))
    assert.deepEqual(revealed, ['C:\\Users\\me\\out box\\Setup 1.exe'])
  } finally { delete w.orgtreeDesktop; await v.unmount(); resetConvos() }
})

test('§6 a picture in the Attention desk opens the viewer', async () => {
  const v = await attentionDesk([LINKS])
  try {
    const desk = document.querySelector('.attn-panel-desk')!
    const img = desk.querySelector('.md img') as HTMLImageElement
    assert.ok(img, 'fixture: the picture rendered inside the desk panel')
    // jsdom loads no images; give it the size a loaded picture has, so the
    // "broken image stays put" rule does not decide this test
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 40 })
    await inAct(() => { img.click() })
    assert.ok(document.querySelector('.lb-overlay'), 'the viewer opened')
  } finally { closeLightbox(document); await v.unmount(); resetConvos() }
})

// ─────────────────────────────── §7 a popped-out window (popout.tsx)
// The popped-out document has its own capture listener. It already served
// code copy and the viewer; local file links were missing from it, so a file
// link in a popped-out window did nothing. The window rig is popoutdrag's:
// `window.open` hands back a document from THIS jsdom realm, so the real
// MovableSurface adopts the real PinFrame into it.

const popoutDocs: Document[] = []
function fakeWindow() {
  const doc = document.implementation.createHTMLDocument('popout')
  Object.assign(doc, { open: () => doc, write: () => {}, close: () => {} })
  const own: Record<string, unknown> = {
    document: doc, closed: false,
    screenX: 40, screenY: 60, outerWidth: 900, outerHeight: 760, innerWidth: 900, innerHeight: 760,
    addEventListener: () => {}, removeEventListener: () => {}, focus: () => {},
    close() { own.closed = true },
    requestAnimationFrame: (fn: FrameRequestCallback) => { fn(0); return 1 },
    cancelAnimationFrame: () => {},
  }
  popoutDocs.push(doc)
  const w = new Proxy(own, {
    get(target, key) {
      if (key in target) return target[key as string]
      const value = (window as unknown as Record<string, unknown>)[key as string]
      return typeof value === 'function' ? value.bind(window) : value
    },
    has: () => true,
  })
  try { Object.defineProperty(doc, 'defaultView', { value: w, configurable: true }) } catch { /* see popoutdrag */ }
  return w as unknown as Window
}

test('§7 in a popped-out window, code copy and a local file link both work', async (t) => {
  const realOpen = window.open
  const g = globalThis as unknown as Record<string, unknown>
  const hadObserver = g.MutationObserver
  g.MutationObserver = (window as unknown as Record<string, unknown>).MutationObserver
  window.open = (() => fakeWindow()) as typeof window.open
  const clip = stubClipboard()
  const revealed: string[] = []
  const w = window as unknown as { orgtreeDesktop?: unknown }
  w.orgtreeDesktop = { revealFile: (p: string) => { revealed.push(p); return Promise.resolve({ ok: true }) } }
  const canvas = document.createElement('div')
  canvas.dataset.pinOrg = SLUG
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800,
    right: 1200, bottom: 800, toJSON() {} }) as DOMRect
  document.body.appendChild(canvas)
  const html = md('```\nline one\n  line two\n```\n\nsee [Setup.exe](<C:\\Users\\me\\Setup 1.exe>)')
  const view = await mountView(
    <CurrentOrg.Provider value={SLUG}>
      <PinFrame kind="usage" title="Surface" panel="settings" close={() => {}}>
        <div className="md" dangerouslySetInnerHTML={html} />
      </PinFrame>
    </CurrentOrg.Provider>, el => el)
  t.after(async () => {
    await view.unmount(); canvas.remove()
    window.open = realOpen
    if (hadObserver === undefined) delete g.MutationObserver
    else g.MutationObserver = hadObserver
    clip.restore(); delete w.orgtreeDesktop
    popoutDocs.length = 0; localStorage.clear(); forgetModalPins()
  })
  await flush()
  const pop = document.querySelector('[aria-label="Open in new window"]') as HTMLButtonElement
  assert.ok(pop, 'fixture: the frame offers a pop-out')
  await inAct(() => { pop.click() })
  await flush()
  const doc = popoutDocs[0]
  assert.ok(doc?.querySelector('.popout-mount .md'), 'fixture: the body really moved into the popped-out document')
  assert.equal(document.querySelector('.md button.code-copy'), null, 'and is no longer in the main document')
  await clickCopy(doc!.querySelector('button.code-copy') as HTMLButtonElement)
  assert.deepEqual(clip.writes, ['line one\n  line two'])
  const a = doc!.querySelector('a[data-local-path]') as HTMLAnchorElement
  await inAct(() => { a.click() })
  await inAct(() => flush(3))
  assert.deepEqual(revealed, ['C:\\Users\\me\\Setup 1.exe'])
})
