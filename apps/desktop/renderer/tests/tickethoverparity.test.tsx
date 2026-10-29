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
import { MailReplyPreview } from '../src/canvas/mailreply'
import type { WorkItem } from '../src/types'
import { objectTooltipProps, registerObjectNativeTooltipDocument } from '../src/canvas/objecttooltip'

test('native object tooltip binds to the adopted document and ignores stale/cleaned-up reads', async t => {
  const original = globalThis.fetch
  const frame = document.createElement('iframe'); document.body.appendChild(frame)
  const owner = frame.contentDocument!, win = frame.contentWindow! as Window & typeof globalThis
  let settle: ((response: Response) => void) | undefined
  const reads: string[] = []
  globalThis.fetch = (async input => {
    reads.push(String(input))
    return new Promise<Response>(resolve => { settle = resolve })
  }) as typeof fetch
  const cleanup = registerObjectNativeTooltipDocument(owner)
  t.after(() => { cleanup(); frame.remove(); globalThis.fetch = original })
  const link = owner.createElement('button')
  for (const [key, value] of Object.entries(objectTooltipProps('ticket', 'native-ticket', 'org'))) if (value) link.setAttribute(key, value)
  owner.body.appendChild(link)
  const hover = async () => {
    await inAct(() => void link.dispatchEvent(new win.MouseEvent('pointerover', { bubbles: true })))
    await flush()
  }
  await hover()
  assert.equal(reads.length, 1, 'only the adopted document sees its hover')
  await inAct(() => settle!(new Response(JSON.stringify({ item: { title: 'Native title', status: 'open' } }), { status: 200 })))
  await flush()
  assert.equal(link.title, 'Open · native-ticket', 'the slug, not the title that is already inline')
  await inAct(() => void link.dispatchEvent(new win.MouseEvent('pointerout', { bubbles: true })))
  await hover()
  await inAct(() => void link.dispatchEvent(new win.MouseEvent('pointerout', { bubbles: true })))
  await inAct(() => settle!(new Response(JSON.stringify({ item: { title: 'Too late' } }), { status: 200 })))
  await flush()
  assert.equal(link.title, '', 'a reply after departure cannot restore stale hover text')
  await hover()
  cleanup()
  await inAct(() => settle!(new Response(JSON.stringify({ item: { title: 'After cleanup' } }), { status: 200 })))
  await flush()
  assert.equal(link.title, '', 'cleaned-up window hosts do not decorate retained DOM')
})

test('ticket row, typed/Markdown/bare refs, inbox reply and tools share live status/slug hover and base menu', async t => {
  const original = globalThis.fetch
  let title = 'A full ticket title'
  let status = 'open', archived = false
  const item = { slug: 'ticket-parity', title, status: 'open', owner: null, archived: false,
    at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z', questions: [],
    done_so_far: [], working_on_next: [], attention_sources: [] } as unknown as WorkItem
  const reads: string[] = [], opened: string[] = []
  globalThis.fetch = (async input => {
    const url = String(input); reads.push(url)
    return new Response(JSON.stringify(url.includes('/references') ? { references: [{ ...item, title, status, archived }] } : { item: { ...item, title, status, archived } }), { status: 200 })
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
      <WorkRefText text={item.slug} index={buildMentionIndex([item])} onPick={() => {}} />
      <ToolRefs org="org" owner="worker" agent={id => id} refs={[{ kind: 'ticket', id: item.slug }]} onWorkLink={() => {}} />
      <ToolChip t={{ id: 'created', name: 'orgtree_work', work: { slug: item.slug } }} slug="org" nid="worker" onWorkLink={() => {}} />
      <MailReplyPreview row={{ reply_to: { id: item.slug, kind: 'work_item', org: 'org', gist: 'Ticket context' } }} org="org" world={world} onOpen={() => {}} />
    </ObjectMenuBoundary>
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await flush(3)
  const links = [...v.el.querySelectorAll<HTMLElement>('.docket-row, [data-object-nav="ticket"]')]
  assert.equal(links.length, 8, 'actual row, React, Markdown typed/bare, React bare, two tool targets and inbox reply')
  const readsBeforeHover = reads.length
  for (const state of [{ status: 'open', label: 'Open', title },
    { status: 'blocked', label: 'Blocked', title: 'Renamed ticket, still the same target' },
    { status: 'done', label: 'Archived', title: 'Renamed ticket, still the same target', archived: true }]) {
    title = state.title; status = state.status; archived = !!state.archived
    let menu: (string | null)[] | undefined
    for (const link of links) {
      await inAct(() => void link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
      await flush(2)
      assert.equal(link.title, `${state.label} · ${item.slug}`, 'hover resolves current state and shows the slug, never the title the link already draws')
      await inAct(() => void link.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
      await flush(2)
      const labels = [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')].map(el => el.textContent)
      menu ??= labels
      assert.deepEqual(labels, menu)
      await inAct(() => void link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    }
  }
  assert.ok(reads.length > readsBeforeHover, 'renames are read exactly on demand rather than permanently cached')
  assert.deepEqual(opened, [], 'hover and context opening do not navigate')
})

test('ticket status labels match the docket; unknown or absent status shows only the slug', async t => {
  const original = fetch
  let served: Record<string, unknown> = {}
  globalThis.fetch = (async () => new Response(JSON.stringify({ item: { title: 'Complete title', ...served } }))) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const cleanup = registerObjectNativeTooltipDocument(document)
  t.after(cleanup)
  const view = await mountView(<button {...objectTooltipProps('ticket', 'status-labels', 'org')}>ticket</button>, el => el)
  t.after(view.unmount)
  const link = view.el.querySelector('button')!
  const states = [
    ['open', 'Open'], ['in_progress', 'In progress'], ['blocked', 'Blocked'],
    ['review', 'Agent review'], ['approved', 'Approved — not landed'], ['deploy_ready', 'Deploy Ready'],
    ['done', 'Done'], ['dropped', 'Dropped'], ['backlogged', 'Backlogged'], ['superseded', 'Superseded'],
  ] as const
  for (const [status, label] of states) {
    served = { status }
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await flush(3)
    assert.equal(link.title, `${label} · status-labels`)
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
  }
  for (const status of [undefined, null, '', 'future-status', '__proto__', 12, {}]) {
    served = { status }
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await flush(3)
    assert.equal(link.title, 'status-labels', 'unknown status must not be invented')
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
  }
  served = { status: 'done', archived: true }
  await inAct(() => void link.dispatchEvent(new MouseEvent('focusin', { bubbles: true }))); await flush(3)
  assert.equal(link.title, 'Archived · status-labels')
})

test('concurrent ticket hovers share one read, and a later focus rereads changed status', async t => {
  const original = fetch
  let settle: ((response: Response) => void) | undefined, reads = 0
  globalThis.fetch = (() => { ++reads; return new Promise<Response>(resolve => { settle = resolve }) }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const cleanup = registerObjectNativeTooltipDocument(document)
  t.after(cleanup)
  const view = await mountView(<><button {...objectTooltipProps('ticket', 'concurrent-ticket', 'org')}>one</button>
    <button {...objectTooltipProps('ticket', 'concurrent-ticket', 'org')}>two</button></>, el => el)
  t.after(view.unmount)
  const [one, two] = [...view.el.querySelectorAll('button')]
  await inAct(() => { one!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })); two!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })) })
  assert.equal(reads, 1)
  await inAct(() => settle!(new Response(JSON.stringify({ item: { title: 'Ticket', status: 'open' } })))); await flush(3)
  assert.equal(one!.title, 'Open · concurrent-ticket'); assert.equal(two!.title, one!.title)
  await inAct(() => void one!.dispatchEvent(new MouseEvent('focusin', { bubbles: true })))
  assert.equal(reads, 2, 'settled result was not retained as a cache')
  await inAct(() => settle!(new Response(JSON.stringify({ item: { title: 'Ticket', status: 'done' } })))); await flush(3)
  assert.equal(one!.title, 'Done · concurrent-ticket')
})

test('a ticket hover names the slug; an item of another org adds its org, and a ticket with no title still reads as its slug', async t => {
  const original = fetch
  let served: Record<string, unknown> = { title: 'Complete title', status: 'open' }
  globalThis.fetch = (async () => new Response(JSON.stringify({ item: served }))) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const cleanup = registerObjectNativeTooltipDocument(document, () => 'home')
  t.after(cleanup)
  const view = await mountView(<><button id="same" {...objectTooltipProps('ticket', 'shared-slug', 'home')}>same</button>
    <button id="other" {...objectTooltipProps('ticket', 'shared-slug', 'away')}>other</button></>, el => el)
  t.after(view.unmount)
  const hover = async (id: string) => {
    const link = view.el.querySelector<HTMLElement>('#' + id)!
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))); await flush(3)
    const title = link.title
    await inAct(() => void link.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    return title
  }
  assert.equal(await hover('same'), 'Open · shared-slug', 'an item of the viewed org: the bare slug')
  assert.equal(await hover('other'), 'Open · away/shared-slug', 'an item of a different org carries its org')
  served = { title: '', status: 'in_progress' }
  assert.equal(await hover('same'), 'In progress · shared-slug', 'a blank title does not hide the slug')
})
