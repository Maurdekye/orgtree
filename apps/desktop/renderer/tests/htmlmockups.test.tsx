import './harness'
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DocChips, DocReader, PresentationCard } from '../src/canvas/docs'
import { DocGalleryModal } from '../src/canvas/gallery'
import { mockupUrl } from '../src/api'

const htmlDoc = { id: 'mock1', title: 'Interactive prototype', at: '2026-09-06T15:00:00Z', format: 'html' as const }
const markdownDoc = { id: 'read1', title: 'Written plan', at: htmlDoc.at }
const maliciousBody = '<script>window.IN_APP_EXECUTION = true</script><button id="untrusted-control">unsafe</button>'

test('canvas and desk mockup cards are native new-tab links; markdown still opens its reader', async (t) => {
  const opened: string[] = []
  let parentClicks = 0
  const view = await mountView(<div onClick={() => { parentClicks++ }}>
    <DocChips slug="org" docs={[htmlDoc, markdownDoc]} onOpen={(id) => opened.push(id)} />
    <PresentationCard slug="org" doc={htmlDoc} className="doc-badge" onOpen={(id) => opened.push(id)}>
      {htmlDoc.title}
    </PresentationCard>
  </div>, (host) => host)
  t.after(() => view.unmount())
  const links = [...view.el.querySelectorAll('a')]
  assert.equal(links.length, 2)
  for (const link of links) {
    assert.equal(link.getAttribute('href'), '/api/orgs/org/documents/mock1/mockup')
    assert.equal(link.target, '_blank')
    assert.match(link.rel, /noopener/)
    assert.match(link.rel, /noreferrer/)
    assert.match(link.title, /new tab/)
  }
  await inAct(() => { (view.el.querySelector('button.doc-chip') as HTMLButtonElement).click() })
  assert.deepEqual(opened, ['read1'])
  assert.equal(parentClicks, 0)
  assert.equal(mockupUrl('name with space', 'id#fragment'), '/api/orgs/name%20with%20space/documents/id%23fragment/mockup')
})

test('document reference reader offers the mockup link without parsing its HTML in the application', async (t) => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => ({ ...htmlDoc, node: 'agent', body: maliciousBody }),
  } as Response)) as typeof fetch
  const view = await mountView(<DocReader slug="org" docId="mock1" toast={() => {}} close={() => {}} />, (host) => host)
  t.after(() => view.unmount())
  await flush()
  const link = view.el.querySelector('.mockup-open a') as HTMLAnchorElement
  assert.ok(link)
  assert.equal(link.target, '_blank')
  assert.equal(view.el.querySelector('.doc-reader-body'), null)
  assert.equal(view.el.querySelector('#untrusted-control'), null)
  assert.equal(view.el.querySelector('iframe'), null)
})

test('gallery mockup cards open a new tab and retain a dismissible metadata pane', async (t) => {
  useFakeClock()
  const calls: string[] = []
  let dismissed = false
  globalThis.fetch = (async (url, init) => {
    calls.push((init?.method ?? 'GET') + ' ' + String(url))
    if (init?.method === 'DELETE') dismissed = true
    const doc = { ...htmlDoc, node: 'agent', node_state: 'live', evicted: false }
    return { ok: true, status: 200, headers: new Headers(), json: async () =>
      String(url).endsWith('/documents') ? { documents: dismissed ? [] : [doc, { ...doc, id: 'evicted1', evicted: true }] }
        : { ...doc, body: maliciousBody },
    } as Response
  }) as typeof fetch
  const view = await mountView(<DocGalleryModal slug="org" toast={() => {}} close={() => {}} />, (host) => host)
  t.after(async () => { try { await view.unmount() } finally { realClock() } })
  await flush()
  const card = view.el.querySelector('a.doc-gallery-row') as HTMLAnchorElement
  assert.ok(card)
  assert.equal(card.target, '_blank')
  assert.equal(card.getAttribute('href'), '/api/orgs/org/documents/mock1/mockup')
  assert.equal(view.el.querySelector('.doc-gallery-row.evicted'), null,
    'evicted HTML entries stay out of the menu')
  assert.equal(view.el.querySelectorAll('.doc-gallery-row').length, 1,
    'available HTML entry is retained')
  // Prevent jsdom navigation; production activation is verified in Chromium.
  card.addEventListener('click', (e) => e.preventDefault())
  await inAct(() => card.click()); await flush()
  assert.ok(view.el.querySelector('.mockup-open a'))
  assert.equal(view.el.querySelector('#untrusted-control'), null)
  assert.equal(view.el.querySelector('.mailer-body'), null)
  const dismiss = view.el.querySelector('button[title="dismiss"]') as HTMLButtonElement
  await inAct(() => dismiss.click()); await flush()
  assert.ok(calls.includes('DELETE /api/orgs/org/documents/mock1'))
})
