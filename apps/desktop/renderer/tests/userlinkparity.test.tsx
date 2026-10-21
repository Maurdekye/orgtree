import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { UserMention } from '../src/canvas/usermention'
import { RefProse } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { useContextMenu } from '../src/canvas/contextmenu'
import { senderMenuAction } from '../src/canvas/objectactions'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectNavProvider, useObjectNavRegistry } from '../src/canvas/objectnav'
import { MailReplyPreview } from '../src/canvas/mailreply'

function Sender() { const menu = useContextMenu(), registry = useObjectNavRegistry(); return <><button className="sender-test" onContextMenu={e => {
  const entry = senderMenuAction(e.currentTarget, '@user', [], undefined, (registry as { openUserInbox?: () => void })?.openUserInbox)
  menu.open(e, entry ? [entry] : [])
}}>Reply</button>{menu.node}</> }
test('user identity links and Sender share their own menu, not a message or agent menu', async t => {
  const opened: unknown[] = [], world = { org: 'org' }, refs = { world, onOpen: (r: unknown) => opened.push(r) }
  const v = await mountView(<ObjectNavProvider><ObjectNavHost org="org" dogs={[]} openDog={() => {}} toast={() => {}}
    {...{ openMail: (m: unknown) => opened.push(m) }} />
    <UserMention refs={refs} /><RefProse text="@user" world={world} onOpen={refs.onOpen} />
    <RefMdBody world={world} onOpen={refs.onOpen} html={{ __html: '<p>@user</p>' }} /><Sender />
    <MailReplyPreview org="org" world={world} row={{ reply_to: { kind: 'mail', box: 'user', id: 'quoted', from: '@user', gist: 'Retained' } }} onOpen={refs.onOpen} />
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount()); await flush(2)
  const links = [...v.el.querySelectorAll<HTMLElement>('.ref-mail.ref-ready')].filter(el => el.textContent === '@user'); assert.equal(links.length, 3)
  for (const link of links) {
    assert.equal(link.title, "open the user's inbox")
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await inAct(() => link.dispatchEvent(event)); assert.equal(event.defaultPrevented, true)
    assert.deepEqual([...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el => el.textContent), ['Copy mention', 'Open inbox'])
  }
  await inAct(() => v.el.querySelector('.sender-test')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const entry = [...document.querySelectorAll<HTMLElement>('.ctxmenu-item')].find(el => el.textContent?.includes('Sender'))!
  assert.equal(entry.title, links[0]!.title)
  await inAct(() => entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  assert.deepEqual([...document.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')].map(el => el.textContent), ['Copy mention', 'Open inbox'])
  await inAct(() => v.el.querySelector('.reply-preview')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const actualSender = [...document.querySelectorAll<HTMLElement>('.ctxmenu-item')].find(el => el.textContent?.includes('Sender'))!
  assert.equal(actualSender.title, links[0]!.title)
  await inAct(() => actualSender.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  assert.deepEqual([...document.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')].map(el => el.textContent), ['Copy mention', 'Open inbox'])
  assert.deepEqual(opened, [])
})
