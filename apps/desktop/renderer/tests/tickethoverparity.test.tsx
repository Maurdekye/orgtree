import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { DocketRow } from '../src/canvas/docket'
import { WorkRefText, buildMentionIndex } from '../src/canvas/workrefs'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { ToolRefs } from '../src/canvas/toolrefs'
import { ToolChip } from '../src/canvas/desk'
import type { WorkItem } from '../src/types'

test('ticket row, typed/Markdown/bare refs and tool links share full-title hover and base menu', async t => {
  const original = globalThis.fetch
  let title = 'A full ticket title'
  const item = { slug: 'ticket-parity', title, status: 'open', owner: null, archived: false,
    at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z', questions: [],
    done_so_far: [], working_on_next: [], attention_sources: [] } as unknown as WorkItem
  const reads: string[] = [], opened: string[] = []
  globalThis.fetch = (async input => {
    const url = String(input); reads.push(url)
    return new Response(JSON.stringify(url.includes('/references') ? { references: [{ ...item, title }] } : { item: { ...item, title } }), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const world = { org: 'org', items: new Map([[item.slug, item.title]]), itemTitles: new Map([[item.slug, item.title]]) }
  const v = await mountView(<ObjectNavProvider>
    <ObjectNavHost org="org" dogs={[]} openDog={() => {}} openTicket={id => opened.push(id)} toast={() => {}} />
    <ObjectMenuBoundary>
      <DocketRow org="org" item={item} selected={false} ageTick={0} facts={new Map()}
        onClick={id => opened.push(id)} onDismiss={() => {}} />
      <RefChip r={resolveRef({ kind: 'item', org: 'org', id: item.slug }, world)} onOpen={() => {}} />
      <RefMdBody html={{ __html: `<p>@item:org/${item.slug} ${item.slug}</p>` }} world={world} onOpen={() => {}}
        mentions={{ index: buildMentionIndex([item]), onPick: () => {} }} />
      <WorkRefText text={item.slug} org="org" index={buildMentionIndex([item])} onPick={() => {}} />
      <ToolRefs org="org" owner="worker" agent={id => id} refs={[{ kind: 'ticket', id: item.slug }]} onWorkLink={() => {}} />
      <ToolChip t={{ id: 'created', name: 'orgtree_work', work: { slug: item.slug } }} slug="org" nid="worker" onWorkLink={() => {}} />
    </ObjectMenuBoundary>
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await flush(3)
  const links = [...v.el.querySelectorAll<HTMLElement>('.docket-row, [data-object-nav="ticket"]')]
  assert.equal(links.length, 7, 'actual row, React, Markdown typed/bare, React bare and two tool targets')
  const readsBeforeHover = reads.length
  for (const expectedTitle of [title, 'Renamed ticket, still the same target']) {
    title = expectedTitle
    let menu: (string | null)[] | undefined
    for (const link of links) {
      await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
      await flush(2)
      assert.equal(link.title, expectedTitle, 'hover resolves the authoritative full title, never a surface action hint')
      await inAct(() => link.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
      await flush(2)
      const labels = [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')].map(el => el.textContent)
      menu ??= labels
      assert.deepEqual(labels, menu)
      await inAct(() => link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    }
  }
  assert.ok(reads.length > readsBeforeHover, 'renames are read exactly on demand rather than permanently cached')
  assert.deepEqual(opened, [], 'hover and context opening do not navigate')
})
