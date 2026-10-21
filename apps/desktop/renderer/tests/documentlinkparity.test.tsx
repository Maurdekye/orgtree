import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { PresentationCard } from '../src/canvas/docs'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { RefChip, resolveRef } from '../src/canvas/reflinks'
import { RefMdBody } from '../src/canvas/refmd'
import { ToolChip } from '../src/canvas/desk'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview } from '../src/canvas/replypreview'

for (const gallery of ['agent', 'global']) test(`document identity shares title and base menu across ${gallery} gallery and every reference`, async t => {
  const saved = fetch, opened: string[] = []
  const doc = { id: 'parity-document-' + gallery, node: 'writer', presented_by: 'writer', title: 'Canonical presentation title',
    at: '2026-10-21T00:00:00Z', format: 'markdown' as const, node_state: 'live', evicted: false, body: 'Body' }
  globalThis.fetch = (async input => {
    const path = String(input)
    return new Response(JSON.stringify(path.endsWith('/documents/viewed') ? { ok: true } : path.includes('/documents?')
      ? { documents: [doc], total: 1, offset: 0, next_offset: null, opening_id: doc.id } : doc), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })
  const world = { org: 'org', docs: new Map([[doc.id, doc.title]]) }
  const v = await mountView(<ObjectNavProvider>
    <ObjectNavHost org="org" dogs={[]} openDog={() => {}} openDocument={id => opened.push(id)} toast={() => {}} />
    <ObjectMenuBoundary>
      <PresentationCard slug="org" doc={doc} className="parity-card" onOpen={id => opened.push(id)}>Card</PresentationCard>
      <RefChip r={resolveRef({ kind: 'doc', org: 'org', id: doc.id }, world)} onOpen={() => {}} />
      <RefMdBody html={{ __html: `<p>@doc:org/${doc.id}</p>` }} world={world} onOpen={() => {}} />
      <ToolChip t={{ id: 'presented', name: 'orgtree_present', presentation: doc }} slug="org" nid="writer" onOpenDoc={id => opened.push(id)} />
      <MailReplyPreview row={{ reply_to: { id: doc.id, kind: 'document', from: 'writer', gist: 'Quoted context' } }} org="org" world={world} onOpen={() => {}} />
      <ReplyPreview reply={{ org: 'org', agent: 'writer', generation: 1, eventId: 'event', docId: doc.id }}
        available onLocate={() => opened.push('reply')} presentationTitle={doc.title} />
      {gallery === 'agent' ? <AgentGalleryView slug="org" nid="writer" toast={() => {}} />
        : <DocGalleryModal slug="org" toast={() => {}} close={() => {}} />}
    </ObjectMenuBoundary>
  </ObjectNavProvider>, el => el)
  t.after(() => v.unmount())
  await flush(8)
  const links = [...v.el.querySelectorAll<HTMLElement>('.parity-card, .ref-doc.ref-ready, .presentation-chat-card, button.reply-presentation-link, .doc-gallery-row')]
  assert.equal(links.length, 7, 'actual card, React/Markdown, tool, two reply targets and gallery row')
  let base: string[] | undefined
  for (const link of links) {
    await inAct(() => link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    await flush(2)
    assert.equal(link.title, doc.title)
    const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await inAct(() => link.dispatchEvent(event)); await flush(3)
    assert.equal(event.defaultPrevented, true, 'the inner document owns its menu, including inside reply frames')
    const labels = [...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) > .ctxmenu-branch > [role="menuitem"]')].map(el => el.textContent!.trim())
    assert.ok(['Open reader', 'Open', 'Close'].includes(labels[0]), 'only the real gallery selection changes Open/Close')
    const common = labels.filter(label => !['Open reader', 'Open', 'Close', 'Reply', 'Dismiss'].includes(label))
    base ??= common
    assert.deepEqual(common, base)
    assert.deepEqual(common, ['Presenter… ▸', 'Copy title', 'Copy reference', 'Download as Markdown'])
  }
  assert.deepEqual(opened, [], 'hover/context do not open or delete content')
})
