import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { MailList } from '../src/canvas/mail'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { ToolChip } from '../src/canvas/desk'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview } from '../src/canvas/replypreview'
import { fmtFull } from '../src/timefmt'

for (const box of ['user', 'org', 'node'] as const) test(`mail ${box} identity shares hover and base menu on actual link surfaces`, async t => {
  const saved = fetch, opened: string[] = [], changed: string[] = []
  const mail = { id: 'mail-parity-' + box, from: 'writer', at: '2026-10-21T00:00:00Z', body: 'Complete message body', kind: 'message' }
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: true, mail }), { status: 200 })) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const ref = { kind: 'mail' as const, org: 'org', box, node: box === 'node' ? 'reader' : undefined, id: mail.id }
  const token = `@mail:org/${box}/${box === 'node' ? 'reader/' : ''}${mail.id}`
  const world = { org: 'org', agents: new Map([['reader', 'reader']]) }
  const host = { openMail: (m: { id: string }) => opened.push(m.id) }
  const v = await mountView(<ObjectNavProvider>
    <ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}} {...host} />
    <ObjectMenuBoundary>
      <MailList org="org" delivered={[mail]} refOf={() => token} toast={() => {}} onRead={() => changed.push('read')} />
      <RefChip r={resolveRef(ref, world)} onOpen={() => opened.push(mail.id)} />
      <RefMdBody html={{ __html: `<p>${token}</p>` }} world={world} onOpen={() => opened.push(mail.id)} />
      <ToolChip t={{ id: 'sent', name: 'orgtree_message', mail: { id: mail.id, to: box === 'user' ? 'user_inbox' : box === 'org' ? '@org:org' : 'reader' } }} slug="org" nid="reader" onMailLink={() => opened.push(mail.id)} />
      <MailReplyPreview row={{ reply_to: { ...ref, from: mail.from, at: mail.at, gist: 'Retained quote' } }} org="org" world={world} onOpen={() => opened.push(mail.id)} />
      {box === 'node' && <ReplyPreview reply={{ org: 'org', agent: 'reader', generation: 1, eventId: 'event', mailId: mail.id }} available onLocate={() => opened.push(mail.id)} />}
    </ObjectMenuBoundary>
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(5) })
  const links = [...v.el.querySelectorAll<HTMLElement>('.mailrow, .ref-mail.ref-ready, .maillink, button.reply-preview-jump')]
  assert.equal(links.length, box === 'node' ? 6 : 5)
  for (const link of links) {
    await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await flush(2)
    assert.equal(link.title, `${mail.from} · ${fmtFull(mail.at)} · ${mail.id}`)
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await inAct(() => link.dispatchEvent(event)); await flush(3)
    assert.equal(event.defaultPrevented, true)
    const labels = [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')].map(el => el.textContent!.trim())
    assert.ok(['Open', 'Close'].includes(labels[0]))
    assert.deepEqual(labels.filter(label => !['Open', 'Close', 'Reply', 'Mark as read', 'Retract (undelivered)', 'Delete'].includes(label)), ['Copy message text', 'Copy reference'])
  }
  assert.deepEqual(opened, [], 'hover/menu cannot route or change message state')
  assert.deepEqual(changed, [])
})

test('mail reference copy fetches every body chunk in its exact box; Open routes only on selection', async t => {
  const saved = fetch, requests: string[] = [], writes: string[] = [], opened: unknown[] = []
  const nav = window.navigator, descriptor = Object.getOwnPropertyDescriptor(nav, 'clipboard')
  Object.defineProperty(nav, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text) } } })
  t.after(() => { globalThis.fetch = saved; if (descriptor) Object.defineProperty(nav, 'clipboard', descriptor); else Reflect.deleteProperty(nav, 'clipboard') })
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://test'); requests.push(url.pathname + url.search)
    const chunk = Number(url.searchParams.get('chunk') || 0)
    return new Response(JSON.stringify({ found: true, mail: { id: 'chunk-mail', from: 'writer', at: '2026-10-21T00:00:00Z',
      body: ['  first\n', '\nsecond  '][chunk], chunk_index: chunk, chunk_total: 2, complete: false } }), { status: 200 })
  }) as typeof fetch
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}}
    {...{ openMail: (m: unknown) => opened.push(m) }} /><ObjectMenuBoundary>
    <RefChip r={resolveRef({ kind: 'mail', org: 'org', box: 'node', node: 'reader', id: 'chunk-mail' }, { org: 'org', agents: new Map([['reader', 'reader']]) })} onOpen={() => {}} />
  </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  const link = v.el.querySelector('.ref-mail')!
  const right = async () => { await inAct(() => link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))); await flush(3) }
  const choose = async (label: string) => { const button = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')].find(el => el.textContent === label)!; assert.ok(button); await inAct(() => button.click()); await flush(3) }
  await right(); assert.deepEqual(opened, []); await choose('Copy message text')
  assert.deepEqual(writes, ['  first\n\nsecond  '], 'whole body preserves original whitespace')
  assert.ok(requests.some(url => url.includes('chunk=1')))
  assert.ok(requests.every(url => url.startsWith('/api/orgs/org/mail/node/chunk-mail?node=reader')))
  await right(); await choose('Copy reference'); assert.equal(writes[1], '@mail:org/node/reader/chunk-mail')
  await right(); await choose('Open'); assert.deepEqual(opened, [{ id: 'chunk-mail', to: 'reader' }])
})
