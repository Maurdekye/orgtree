import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { HubContactChip, setHubchatInstalled, resolveHubAddressAction } from '../src/canvas/agentmentions'
import { RefMdBody } from '../src/canvas/refmd'
import { ToolRefs } from '../src/canvas/toolrefs'
import { useContextMenu } from '../src/canvas/contextmenu'
import { senderMenuAction } from '../src/canvas/objectactions'
import { hubAddressTitle } from '../src/canvas/netmentions'

function Sender() { const menu = useContextMenu(); return <><button className="sender-test" onContextMenu={e => {
  const entry = senderMenuAction(e.currentTarget, '@net:sample.123456', []); menu.open(e, entry ? [entry] : [])
}}>Reply</button>{menu.node}</> }
for (const installed of [false, true]) test(`remote contact menus and tooltips agree (Hubchat installed=${installed})`, async t => {
  setHubchatInstalled(installed)
  const saved = window.open, opened: string[] = []; window.open = ((url: unknown) => { opened.push(String(url)); return null }) as typeof window.open
  t.after(() => { window.open = saved; setHubchatInstalled(false) })
  const address = '@net:sample.123456'
  const v = await mountView(<><HubContactChip address={address} /><RefMdBody world={{ org: 'org' }} html={{ __html: `<p>${address}</p>` }} />
    <ToolRefs refs={[{ kind: 'hub' as never, id: address }]} /><Sender /></>, el => el)
  t.after(() => v.unmount()); await inAct(async () => { await flush(2) })
  const links = [...v.el.querySelectorAll<HTMLElement>('[data-hub-address]')]; assert.equal(links.length, 3)
  for (const link of links) {
    assert.equal(link.title, hubAddressTitle(address))
    assert.ok(link.title.endsWith(resolveHubAddressAction(address).title))
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await inAct(() => link.dispatchEvent(event)); assert.equal(event.defaultPrevented, true)
    const items = [...document.querySelectorAll<HTMLButtonElement>('.ctxmenu [role="menuitem"]')]
    assert.deepEqual(items.map(el => el.textContent), ['Open in Hubchat', 'Copy identity'])
    assert.equal(items[0]!.disabled, !installed)
    if (!installed) assert.equal(items[0]!.title, "Hubchat isn't installed")
  }
  await inAct(() => v.el.querySelector('.sender-test')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const entry = [...document.querySelectorAll<HTMLElement>('.ctxmenu-item')].find(el => el.textContent?.includes('Sender'))!
  assert.equal(entry.title, links[0]!.title)
  await inAct(() => entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  assert.deepEqual([...document.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')].map(el => el.textContent), ['Open in Hubchat', 'Copy identity'])
  assert.deepEqual(opened, [])
})
