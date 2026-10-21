import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { resolveFullMailCopyText } from '../src/canvas/copytext'
import type { CopyableMailRow } from '../src/canvas/copytext'
import { DeskChat } from '../src/canvas/desk'
import { MailList } from '../src/canvas/mail'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview } from '../src/canvas/replypreview'
import { CopyFeedback, ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { refreshConvo, resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const preview = '[MAIL BY REFERENCE id=copy-mail] abbreviated...'
const full = '  Full message\n\nwith exact trailing whitespace  \n'
const row = { id: 'copy-mail', body: preview, truncated: true }

for (const [name, fetcher] of Object.entries<() => Promise<CopyableMailRow | null>>({
  missing: async () => null,
  rejected: async () => { throw Error('synthetic lookup failure') },
  'still truncated': async () => ({ ...row }),
})) test(`full mail resolution refuses ${name} lookup`, async () => {
  await assert.rejects(resolveFullMailCopyText(row, fetcher), /full message|incomplete|unavailable/i)
})

test('complete local text copies without a lookup and preserves whitespace', async () => {
  assert.equal(await resolveFullMailCopyText({ body: full }, async () => { throw Error('must not fetch') }), full)
})
test('full lookup preserves exact text', async () => {
  assert.equal(await resolveFullMailCopyText(row, async () => ({ body: full })), full)
})
test('incomplete local mail without an identity cannot pretend to be complete', async () => {
  await assert.rejects(resolveFullMailCopyText({ body: preview, truncated: true }, async () => null))
})
test('missing middle chunk never returns a partial assembly', async () => {
  await assert.rejects(resolveFullMailCopyText({ ...row, chunk_total: 3 }, async (_, chunk) =>
    chunk === 1 ? null : { body: String(chunk), chunk_total: 3, chunk_index: chunk, complete: chunk === 2 }))
})
test('failed middle chunk never returns the local preview', async () => {
  await assert.rejects(resolveFullMailCopyText({ ...row, chunk_total: 2 }, async (_, chunk) => {
    if (chunk === 1) throw Error('chunk unavailable')
    return { body: 'first', chunk_total: 2, chunk_index: 0, complete: false }
  }))
})
test('unterminated unknown-length chunks fail at the bounded cap', async () => {
  let calls = 0
  await assert.rejects(resolveFullMailCopyText(row, async (_, chunk) => {
    calls++; return { body: 'part', complete: false, chunk_index: chunk ?? 0 }
  }))
  assert.equal(calls, 128)
})
test('known chunks and terminated unknown-length chunks retain exact ordering', async () => {
  for (const known of [true, false]) {
    assert.equal(await resolveFullMailCopyText({ ...row, complete: false }, async (_, chunk) => ({
      body: chunk === 0 ? '  first\n' : '\nlast  ', chunk_index: chunk,
      ...(known ? { chunk_total: 2 } : {}), complete: chunk === 1,
    })), '  first\n\nlast  ')
  }
})

const writer: CanvasNode = { id: 'writer', generation: 2, state: 'live', tier: 'sol', children: [],
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } }

for (const surface of ['transcript', 'mail list', 'mail reply', 'transcript reply', 'mail identity'] as const) {
  for (const mode of ['missing', 'rejected', 'success'] as const) test(`${surface} copy ${mode}: honest feedback and clipboard preservation`, async t => {
    const savedFetch = fetch, nav = window.navigator
    const descriptor = Object.getOwnPropertyDescriptor(nav, 'clipboard')
    let clipboard = 'previous clipboard contents', writes = 0, lookups = 0, copying = false
    Object.defineProperty(nav, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      clipboard = text; writes++
    } } })
    t.after(() => {
      globalThis.fetch = savedFetch
      if (descriptor) Object.defineProperty(nav, 'clipboard', descriptor)
      else Reflect.deleteProperty(nav, 'clipboard')
      resetConvos()
    })
    resetConvos(); localStorage.clear()
    const server = new FakeServer()
    server.messages = [{ role: 'user', text: preview, seq: 0, event_id: 'mail-turn', segments: [{ kind: 'mail', rows: [
      { ...row, from: 'sender', kind: 'message', at: '2026-10-21T00:00:00Z' },
    ] }] }]
    installFetch(server)
    const baseFetch = fetch
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/mail/')) {
        lookups++
        if (copying && mode === 'rejected') throw Error('synthetic lookup failure')
        return new Response(JSON.stringify({ found: !copying || mode === 'success',
          mail: copying ? { id: row.id, body: full } : row }), { status: 200 })
      }
      return baseFetch(input, init)
    }) as typeof fetch
    const toasts: string[][] = [], toast = (lines: string[]) => { toasts.push(lines) }
    const world = { org: 'org', agents: new Map([['writer', 'writer']]) }
    const ref = { kind: 'mail' as const, org: 'org', box: 'node' as const, node: 'writer', id: row.id }
    const content = surface === 'transcript' ? <DeskChat node={writer} map={new Map([[writer.id, writer]])}
      slug="org" op={async () => ({})} toast={toast} bare />
      : surface === 'mail list' ? <MailList org="org" delivered={[{ ...row, from: 'sender', at: '2026-10-21T00:00:00Z' }]} toast={toast} />
      : surface === 'mail reply' ? <MailReplyPreview org="org" world={world} row={{ reply_to: { ...ref, from: 'sender', gist: preview } }} />
      : surface === 'transcript reply' ? <ReplyPreview reply={{ org: 'org', agent: 'writer', generation: 2,
        eventId: 'mail:' + row.id, mailId: row.id, quote: preview }} available={false} onLocate={() => {}} />
      : <ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={toast} />
        <ObjectMenuBoundary><RefChip r={resolveRef(ref, world)} onOpen={() => {}} /></ObjectMenuBoundary></ObjectNavProvider>
    const view = await mountView(<CopyFeedback.Provider value={toast}>{content}</CopyFeedback.Provider>, el => el)
    t.after(() => view.unmount())
    if (surface === 'transcript') await inAct(async () => { await refreshConvo('org', 'writer'); await flush(5) })
    const selector = surface === 'transcript' ? '[data-reply-mail="copy-mail"] .event-body'
      : surface === 'mail list' ? '.mailrow' : surface === 'mail identity' ? '.ref-mail' : '.reply-preview'
    const target = view.el.querySelector(selector)
    assert.equal(Boolean(target), true, 'actual copy target mounted')
    await inAct(() => { target!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    await flush(4)
    const button = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
      .find(el => ['Copy contents', 'Copy message text'].includes(el.textContent ?? ''))
    assert.equal(Boolean(button), true, 'actual copy action available')
    assert.equal(button!.disabled, false)
    copying = true
    await inAct(() => { button!.click() }); await flush(8)
    assert.ok(lookups > 0, 'lookup really executed')
    if (mode === 'success') {
      assert.equal(clipboard, full); assert.equal(writes, 1)
      assert.ok(toasts.flat().some(line => /copied/i.test(line)))
    } else {
      assert.equal(clipboard, 'previous clipboard contents', 'failed full copy preserves clipboard')
      assert.equal(writes, 0)
      assert.ok(toasts.flat().some(line => /could not copy.*full message/i.test(line)), 'explicit failure feedback')
      assert.equal(toasts.flat().some(line => /copied/i.test(line)), false, 'no success toast')
    }
  })
}
