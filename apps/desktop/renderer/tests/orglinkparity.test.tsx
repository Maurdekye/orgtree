import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { OrgRows } from '../src/shell/orgrows'
import { HubContactChip, setKnownOrgs, resolveHubAddressAction } from '../src/canvas/agentmentions'
import { RefMdBody } from '../src/canvas/refmd'
import { useContextMenu } from '../src/canvas/contextmenu'
import { senderMenuAction } from '../src/canvas/objectactions'

function Sender() { const menu = useContextMenu(); return <><button className="sender-test" onContextMenu={e => {
  const entry = senderMenuAction(e.currentTarget, '@org:example', []); menu.open(e, entry ? [entry] : [])
}}>Reply</button>{menu.node}</> }
test('org row, React/Markdown links and Sender submenu share identity hover and menu', async t => {
  setKnownOrgs(['example']); t.after(() => setKnownOrgs([]))
  const picked: string[] = [], deleted: string[] = []
  const v = await mountView(<><OrgRows orgs={[{ slug: 'example', name: 'Display name', nodes: 0, live: 0, created: null }]}
    slug={null} onPick={s => picked.push(s)} onDelete={o => deleted.push(o.slug)} />
    <HubContactChip address="@org:example" /><RefMdBody world={{ org: 'example' }} html={{ __html: '<p>@org:example</p>' }} /><Sender /></>, el => el)
  t.after(() => v.unmount()); await flush(3)
  const links = [...v.el.querySelectorAll<HTMLElement>('.org[role="button"], .ref-hub')]
  assert.equal(links.length, 3)
  for (const link of links) {
    assert.equal(link.title, resolveHubAddressAction('@org:example').title)
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await inAct(() => link.dispatchEvent(e)); assert.equal(e.defaultPrevented, true)
    const labels = [...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el => el.textContent!.trim())
    assert.deepEqual(labels.filter(label => label !== 'Delete'), ['Open', 'Copy identity'])
    assert.equal(labels.includes('Delete'), link.classList.contains('org'), 'only a real confirmation owner enables deletion')
  }
  const sender = v.el.querySelector('.sender-test')!
  await inAct(() => sender.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const entry = [...document.querySelectorAll<HTMLElement>('.ctxmenu-item')].find(el => el.textContent?.includes('Sender'))!
  assert.equal(entry.title, links[0]!.title)
  await inAct(() => entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))); await flush(2)
  assert.deepEqual([...document.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')].map(el => el.textContent!.trim()), ['Open', 'Copy identity'])
  assert.deepEqual(picked, []); assert.deepEqual(deleted, [])
})
