import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { ListenersView } from '../src/canvas/listenersdesk'
import { MailListenersView } from '../src/canvas/maillisteners'
import type { CanvasNode } from '../src/canvas/shared'
import { fmtFull } from '../src/timefmt'

test('listener fire and queue mail links use message identity hovers and menus', async t => {
  const saved = fetch, requests: string[] = []
  const mail = { id: 'original', from: 'writer', at: '2026-10-21T00:00:00Z', body: 'Full message', kind: 'message' }
  globalThis.fetch = (async input => { requests.push(String(input)); return new Response(JSON.stringify({ found: true, mail }), { status: 200 }) }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const node = { id: 'project', kind: 'project', state: 'live', children: [] } as unknown as CanvasNode
  const refs = { world: { org: 'org' }, onOpen: () => {} }
  const op = async (r: { op: string }) => r.op === 'listener_history'
    ? { history: [{ id: 1, at: mail.at, kind: 'event', message: 'Fired', listeners: [{ agent: 'reader', mail: 'original' }] }] }
    : { ack: true, history: [], working: [{ mail: 'original', copy: 'user-copy', agent: 'user' }] }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}} openMail={() => {}} />
    <ObjectMenuBoundary><ListenersView node={node} dogs={[]} map={new Map()} refs={refs} op={op as never} toast={() => {}} />
      <MailListenersView node={node} state={{ listeners: [], armed: [] }} rows={[]} ack map={new Map()} refs={refs} op={op as never} onOpenMail={() => {}} />
    </ObjectMenuBoundary></ObjectNavProvider>, el => el)
  t.after(() => v.unmount()); await inAct(async () => { await flush(4) })
  const links = [...v.el.querySelectorAll<HTMLElement>('button.fire-mail, button.listener-mail-link, button[data-action="open-job"]')]
  assert.equal(links.length, 3)
  for (const link of links) {
    await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await flush(2)
    assert.equal(link.title, `${link.dataset.action === 'open-job' ? 'open mail\n' : ''}${mail.from} · ${fmtFull(mail.at)} · ${mail.id}`)
    await inAct(() => link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))); await flush(2)
    assert.deepEqual([...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el => el.textContent), ['Open', 'Copy message text', 'Copy reference'])
  }
  assert.ok(requests.some(url => url.includes('/mail/user/user-copy')), 'held user job resolves its copy in the user inbox')
  assert.ok(requests.some(url => url.includes('/mail/node/original?node=project')), 'queue original resolves project mailbox')
  assert.ok(requests.some(url => url.includes('/mail/node/original?node=reader')), 'fire resolves listener mailbox')
})
