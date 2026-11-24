// Synthetic org mailbox for netblocks-visual (blocking, Mail hub 2.6.0; docket
// blocking-contacts-on-the-hub-hubchat-1-4-0-orgtr; @coordinator-opus m366025ce9de1 ruling C).
// The real OrgInboxModal with a synthetic engine API (window.fetch): no engine,
// no hub. Hub A is 2.6.0 (it has answered with `blocks`), hub B is 2.5.0 (no
// `blocking`, so it never sends the lists). Cy has blocked the org; the org's
// message to Cy ended `failed` with the engine's words. Driven by window.__blocks.
import { createRoot } from 'react-dom/client'
import { OrgInboxModal } from '../src/canvas/mail'
import { setNetRoster } from '../src/canvas/netmentions'
import type { NetBlock, NetBlocks, OrgInboxEntry } from '../src/types'

const ALICE = 'alice.fixture.aa0011', CY = 'cy.fixture.cc0033', BOB = 'bob.fixture.bb0022'
const NET: NetBlock = {
  slug: 'home.fixture.123abc',
  hubs: [
    { id: 'a', address: 'http://hub-a.invalid:7370', name: 'Hub A', version: '2.6.0', enabled: true, connected: true, queued: 0,
      blocks: [], blocked_by: [CY],
      roster: [
        { slug: ALICE, org_name: 'Alice', kind: 'person', online: true },
        { slug: CY, org_name: 'Cy Labs', kind: 'org', online: true },
      ] },
    { id: 'b', address: 'http://hub-b.invalid:7370', name: 'Hub B', version: '2.5.0', enabled: true, connected: true, queued: 0,
      roster: [{ slug: BOB, org_name: 'Bob', kind: 'person', online: true }] },
  ],
}
// the engine's words (net/blocks.rs `refused`) for a send Cy's block refused
const FAILED: OrgInboxEntry = {
  id: 'o1', dir: 'out', peer: CY, body: 'Hello Cy, here is the summary you asked for.', at: '2026-11-24T21:30:00Z',
  by: 'helper-opus', state: 'failed', state_at: '2026-11-24T21:30:02Z', tries: 1,
  last_err: `you have been blocked by @net:${CY} and cannot message them`,
}
let blocks: NetBlocks = { blocked: [], blocked_by: [CY] }
const calls: { method: string; url: string; body?: unknown }[] = []
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input), method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ method, url, body })
  if (url.endsWith('/net/blocks')) {
    if (method === 'POST') {
      const { address, blocked } = body as { address: string; blocked: boolean }
      blocks = { ...blocks, blocked: blocked
        ? [...blocks.blocked.filter((b) => b.address !== address), { address, set_by: '@user', reason: null, at: '2026-11-24T21:40:00Z' }]
        : blocks.blocked.filter((b) => b.address !== address) }
    }
    return json(blocks)
  }
  if (url.includes('/org_inbox')) return json({ entries: [FAILED], total: 1, unread: 0 })
  return json({ entries: [], total: 0, transfers: [] }) // the transfer panel's list, as the other fixtures answer
}) as typeof fetch
setNetRoster('blocks-fixture', NET)
const root = createRoot(document.getElementById('root')!)
const show = (jumpTo: string | null) => root.render(
  <OrgInboxModal key={jumpTo ?? 'servers'} slug="blocks-fixture" net={NET} map={new Map()} toast={() => {}} close={() => {}}
    jumpTo={jumpTo} jumpSeq={jumpTo ? 1 : null}
    inbox={{ entries: [FAILED], total: 1, unread: 0, holders: ['helper-opus'], visible: true, multi_holder_enabled: false }} />)
Object.assign(window, { __blocks: { show, calls, ALICE, CY, BOB } })
show(null)
