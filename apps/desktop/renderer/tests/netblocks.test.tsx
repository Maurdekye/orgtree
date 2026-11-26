import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import type { TreePayload } from '../src/types'

// Blocking (Mail hub 2.6.0; docket blocking-contacts-on-the-hub-hubchat-1-4-0-orgtr). The
// mailservers tab reads GET /api/orgs/{org}/net/blocks. An older or remote engine answers
// without the two lists, partly, oddly or not at all: the tab must read that as "no
// blocking info" and never throw (@coordinator-opus m9a218cde2383, after @rig-sol-b's
// bounce me28407a0bc97: NetSection read blocks.blocked.length off {transfers: []}).
const NET = { slug: 'home.fixture.123abc', hubs: [{ id: 'a', address: 'http://hub-a.invalid', name: 'Fixture hub', version: '2.6.0',
  enabled: true, connected: true, queued: 0, blocks: [], blocked_by: [],
  roster: [{ slug: 'alice.fixture.aa0011', org_name: 'Alice', kind: 'person', online: true }] }] } as unknown as TreePayload['net']

async function mailservers(t: test.TestContext, answer: () => Response) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).endsWith('/net/blocks') ? answer()
    : new Response(JSON.stringify(String(input).endsWith('/org_inbox') ? { entries: [], total: 0, unread: 0 } : { transfers: [] }),
      { headers: { 'X-Orgtree-Instance': 'fixture' } })) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const view = await mountView(<OrgInboxModal slug="mine" map={new Map()} toast={() => {}} close={() => {}}
    inbox={{ entries: [], total: 0, unread: 0, visible: true, holders: [] } as unknown as TreePayload['org_inbox']} net={NET} />, host => host)
  t.after(() => view.unmount())
  await flush(6)
  const tab = [...view.el.querySelectorAll('button')].find(b => b.textContent?.trim().toLowerCase().startsWith('mailservers'))
  assert.ok(tab, 'mailservers tab exists')
  await inAct(() => tab.click()); await flush(6)
  const list = [...view.el.querySelectorAll('.oi-net .oi-hub')].find(h => /blocked contacts/.test(h.textContent ?? ''))
  return { text: view.el.querySelector('.oi-net')?.textContent ?? '', list: list?.textContent ?? null,
    signs: [...view.el.querySelectorAll('.oi-net .oi-blocked[role="img"]')].map(s => s.getAttribute('aria-label')),
    buttons: [...view.el.querySelectorAll('.oi-net button.link, .oi-net button.conn-x')].map(b => b.querySelector('svg[data-testid="BlockIcon"].oi-blocked') ? 'blocked sign' : b.textContent) }
}
const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status, headers: { 'X-Orgtree-Instance': 'fixture' } })

for (const [what, answer] of [
  ['an answer with neither list (an engine before blocking)', json({ transfers: [] })],
  ['lists that are null', json({ blocked: null, blocked_by: null })],
  ['lists of the wrong type', json({ blocked: 'x', blocked_by: { a: 1 } })],
  ['an error status', json({ detail: 'no such route' }, 404)],
  ['a server error', json({ detail: 'boom' }, 500)],
  ['a body that is not JSON', () => new Response('<html>', { headers: { 'X-Orgtree-Instance': 'fixture' } })],
] as [string, () => Response][]) {
  test(`mailservers survives ${what}: no blocking info, no list, still a block button`, async t => {
    const r = await mailservers(t, answer)
    assert.match(r.text, /Fixture hub/, 'the tab rendered')
    assert.equal(r.list, null, 'no blocked contacts list')
    assert.deepEqual(r.signs, [], 'no red sign')
    assert.deepEqual(r.buttons, ['blocked sign'], 'Alice still has a block button (the blocked status sign, USER alpha.8 via @coordinator-opus m2d6e12a94c56)')
  })
}

test('a partial answer keeps only its well-formed entries', async t => {
  const r = await mailservers(t, json({ blocked: [null, { address: 5 }, { address: 'alice.fixture.aa0011', set_by: '@user', reason: null, at: '2026-11-24T21:40:00Z' }],
    blocked_by: [7, null, 'cy.fixture.cc0033'] }))
  assert.ok(r.list, 'the blocked contacts list shows')
  assert.match(r.list!, /blocked by you/)
  assert.match(r.list!, /has blocked this org/)
  assert.deepEqual(r.signs, ['blocked'], 'Alice, on the roster, wears the red sign')
})

test('control: a well-formed answer shows the list and the sign', async t => {
  const r = await mailservers(t, json({ blocked: [{ address: 'alice.fixture.aa0011', set_by: 'rhea', reason: 'spam', at: '2026-11-24T21:40:00Z' }], blocked_by: [] }))
  assert.match(r.list ?? '', /blocked by @rhea — spam/)
  assert.deepEqual(r.signs, ['blocked'])
})
