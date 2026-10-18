import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'haiku',
  children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

async function fixture(two = false) {
  localStorage.clear(); resetConvos()
  const server = new FakeServer()
  installFetch(server)
  const originalFetch = globalThis.fetch
  const calls: string[] = [], warnings: string[] = []
  let accept: (() => void) | undefined, refuse: (() => void) | undefined
  globalThis.fetch = (url, init) => {
    if (!String(url).endsWith('/message')) return originalFetch(url, init)
    calls.push(JSON.parse(String(init?.body)).text)
    return new Promise<Response>((resolve, reject) => {
      accept = () => resolve(new Response(JSON.stringify({ queued: 0 }), {
        status: 200, headers: { 'X-Orgtree-Instance': server.instance },
      }))
      refuse = () => reject(new Error('send refused'))
    })
  }
  const other = { ...writer, id: 'other' }
  const map = new Map([[writer.id, writer], [other.id, other]])
  const view = await mountView(<>
    <div data-host="writer"><DeskChat node={writer} map={map} slug="org" bare={two}
      op={async () => ({})} toast={lines => warnings.push(...lines)} /></div>
    {two && <div data-host="other"><DeskChat node={other} map={map} slug="org" bare
      op={async () => ({})} toast={() => {}} /></div>}
  </>, el => el)
  await inAct(async () => { await flush(5) })
  const host = view.el.querySelector<HTMLElement>('[data-host="writer"]')!
  const selected = (root: Element = host) => root.querySelector('.cc-tabs .on')?.getAttribute('data-tab')
  const tab = async (name: string, root: Element = host) => {
    await inAct(async () => {
      root.querySelector<HTMLButtonElement>(`[data-tab="${name}"]`)!.click()
      await flush(3)
    })
    assert.equal(selected(root), name, 'fixture selected the requested tab')
  }
  const send = async () => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea[data-first-use-chat]')!
    await inAct(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'new message')
      ta.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const button = host.querySelector<HTMLButtonElement>('.cc-send')!
    assert.equal(button.disabled, false)
    await inAct(async () => { button.click(); await flush(3) })
    assert.deepEqual(calls, ['new message'], 'the composer issued exactly one message request')
  }
  const finish = async (success: boolean) => {
    assert.equal(typeof (success ? accept : refuse), 'function', 'the request is pending')
    await inAct(async () => { (success ? accept : refuse)!(); await flush(8) })
  }
  return { view, host, selected, tab, send, finish, warnings,
    close: async () => { await view.unmount(); resetConvos(); globalThis.fetch = originalFetch } }
}

for (const tab of ['inbox', 'docket', 'presented']) {
  test(`a successful desk send opens chat from ${tab}, only after acknowledgement`, async () => {
    const f = await fixture()
    try {
      await f.tab(tab)
      await f.send()
      assert.equal(f.selected(), tab, 'an unconfirmed send keeps the current tab')
      await f.finish(true)
      assert.equal(f.selected(), 'chat', 'the accepted send reveals the transcript')
      assert.equal(!!f.host.querySelector('.msgs-wrap .msgs'), true)
      assert.match(f.host.querySelector('.msgs-wrap .msgs')!.textContent!, /new message/)
    } finally { await f.close() }
  })
}

test('a refused desk send leaves the selected tab open', async () => {
  const f = await fixture()
  try {
    await f.tab('docket')
    await f.send()
    await f.finish(false)
    assert.equal(f.selected(), 'docket')
    assert.equal(f.warnings.some(line => line.includes('send refused')), true, 'failure was handled')
    assert.equal(f.host.querySelector('.msgs-wrap') === null, true)
  } finally { await f.close() }
})

test('sending from a pinned desk body retains its host and leaves another desk tab alone', async () => {
  const f = await fixture(true)
  try {
    const other = f.view.el.querySelector<HTMLElement>('[data-host="other"]')!
    await f.tab('presented', other)
    await f.tab('docket')
    const composer = f.host.querySelector('textarea[data-first-use-chat]')
    await f.send()
    await f.finish(true)
    assert.equal(f.selected(), 'chat')
    assert.equal(f.selected(other), 'presented', 'the change belongs to the sending desk only')
    assert.equal(f.host.isConnected && other.isConnected, true, 'both hosts stay mounted')
    assert.equal(f.host.querySelector('textarea[data-first-use-chat]') === composer, true, 'the pinned composer is retained')
  } finally { await f.close() }
})
