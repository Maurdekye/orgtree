// remotedraft.test.tsx: a message for an organization on a remote engine that
// is not connected is not sent, and what was typed stays in the composer
// (docs/rust-engine/remote-org.md, "While not connected"). The agent desk's
// composer is optimistic: it empties its box and shows the message as on its
// way before the engine answers. For a refusal that says nothing was sent,
// that must not cost the user the text.
//
// Run:  node tests/run.mjs remotedraft
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import { useRemotes, type RemoteView } from '../src/remotes'
import { withReaderContent } from './readercontent.fixture'
import { remoteFeed, remoteView } from './remotefeed.fixture'

const OFFLINE = 'Galaxy is offline. Nothing was sent.'
const DROPPED = 'The connection to Galaxy dropped before it answered. This may or may not have been applied; the view will show the result once reconnected.'

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

/** The window keeps the connection list current, as App does for its chip and banner. */
function Connections() { useRemotes(); return null }

const refusal = (status: number, detail: string, state: string) => () =>
  new Response(JSON.stringify({ detail, remote: { id: 'r1', state } }), { status, headers: { 'Content-Type': 'application/json' } })

/** One agent desk in a window of the organization `org`, whose connection list is `remotes`.
 *  A message request waits until `answered()`: the engine answers after the composer has drawn. */
async function desk(t: TestContext, answer: () => Response, remotes: RemoteView[]) {
  localStorage.clear(); resetConvos()
  const original = globalThis.fetch
  const server = new FakeServer()
  installFetch(server)
  const readers = withReaderContent(globalThis.fetch, [{ id: 'writer' }])
  const sent: string[] = [], toasts: string[] = []
  let settle: (() => void) | undefined
  const feed = remoteFeed(t, (url, init) => {
    if (!url.endsWith('/message')) return readers(url, init)
    sent.push(JSON.parse(String(init?.body)).text)
    return new Promise<Response>((resolve) => { settle = () => resolve(answer()) })
  })
  const view = await mountView(<>
    <Connections />
    <div data-host="writer"><DeskChat node={writer} map={new Map([[writer.id, writer]])} slug="org"
      op={async () => ({})} toast={lines => toasts.push(...lines)} /></div>
  </>, el => el)
  await inAct(async () => { await flush(5) })
  await feed.remotes(remotes)
  t.after(async () => { await view.unmount(); resetConvos(); globalThis.fetch = original })
  const host = view.el.querySelector<HTMLElement>('[data-host="writer"]')!
  const box = () => host.querySelector<HTMLTextAreaElement>('textarea[data-first-use-chat]')!
  return {
    box, sent, toasts,
    ghosts: () => [...host.querySelectorAll('.pendghost')].map(g => ({ failed: g.classList.contains('failed'), text: g.textContent ?? '' })),
    async send(text: string) {
      await inAct(() => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
        box().dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      const button = host.querySelector<HTMLButtonElement>('.cc-send')!
      assert.equal(button.disabled, false, 'the composer can send')
      await inAct(async () => { button.click(); await flush(4) })
    },
    async answered() {
      assert.equal(typeof settle, 'function', 'a message request is waiting for its answer')
      await inAct(async () => { settle!(); await flush(10) })
    },
  }
}

test('while the remote engine is known to be away, Send asks nothing of the network and keeps the text', async (t) => {
  const d = await desk(t, refusal(503, OFFLINE, 'offline'), [remoteView({ state: 'offline', refusal: OFFLINE })])
  await d.send('a long message typed while offline')
  assert.deepEqual(d.sent, [], 'no request was made: the window already knows the answer')
  assert.equal(d.box().value, 'a long message typed while offline', 'the text is still in the composer')
  assert.deepEqual(d.ghosts(), [], 'nothing is shown as on its way')
  assert.deepEqual(d.toasts, [OFFLINE], "the engine's own sentence, once")
})

test('a connected remote engine sends as a local organization does', async (t) => {
  const d = await desk(t, () => new Response(JSON.stringify({ queued: 0 }), { status: 200 }), [remoteView()])
  await d.send('hello there')
  assert.deepEqual(d.sent, ['hello there'])
  assert.equal(d.box().value, '', 'the composer is optimistic: the text is on its way')
  await d.answered()
  assert.equal(d.box().value, '')
  assert.deepEqual(d.toasts, [])
})

test('a refusal that says nothing was sent puts the text back and leaves no failed message', async (t) => {
  // the link dropped a moment ago and this window has not heard yet: the engine refuses at once
  const d = await desk(t, refusal(503, OFFLINE, 'offline'), [remoteView()])
  await d.send('typed just as the link dropped')
  assert.deepEqual(d.sent, ['typed just as the link dropped'], 'the request was made once')
  assert.equal(d.box().value, '', 'until the engine answers, the message is on its way')
  await d.answered()
  assert.equal(d.box().value, 'typed just as the link dropped', 'the text is back in the composer')
  assert.deepEqual(d.ghosts(), [], 'it was never on its way, so no failed message stays behind')
  assert.deepEqual(d.toasts, [OFFLINE], "the engine's own sentence, not an error about delivery")
})

test('a relayed request that may have been applied keeps the failed message, as before', async (t) => {
  const d = await desk(t, refusal(502, DROPPED, 'connected'), [remoteView()])
  await d.send('sent into a dropped connection')
  await d.answered()
  assert.equal(d.box().value, '', 'the composer does not offer to send it twice')
  const ghosts = d.ghosts()
  assert.equal(ghosts.length, 1)
  assert.equal(ghosts[0]!.failed, true)
  assert.match(ghosts[0]!.text, /Send was not confirmed/)
  assert.deepEqual(d.toasts, [`error: ${DROPPED}`])
})
