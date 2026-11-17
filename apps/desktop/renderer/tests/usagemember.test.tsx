// usagemember.test.tsx: the Usage panel in a window of an organization another
// desktop shares with this computer (a member: docs/rust-engine/remote-org.md,
// "What a member may do"), and the panel's error state in any window.
//
// USER 2026-11-17 mb356fe1b5546: "the usage panel loads forever" from NICK-PC's
// shared organization, while a standalone engine's loads. 12:35:58Z
// m1b95cceba206 "Show all members": a member is sent the owner's usage values.
// And the panel never waits forever: a read that fails or is refused says so.
//
// Run:  node tests/run.mjs usagemember
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { UsageModal } from '../src/App'
import { legacyAppBackend } from './appfeed-fixture'
import { remoteFeed, remoteView } from './remotefeed.fixture'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } })

const CLAUDE_ON = { id: 'claude', label: 'Claude', cli: 'Claude Code', tiers: [],
  status: { installed: true, connected: true, kind: 'subscription' }, hire_enabled: true, reason: null }

test('a member window shows the owner\'s usage figures it is sent', async (t: TestContext) => {
  const feed = remoteFeed(t, (url) => json(url.endsWith('/providers') ? { providers: [CLAUDE_ON] }
    : url === '/api/accounts' ? { accounts: [], host_identity: {} } : {}))
  const view = await mountView(<UsageModal toast={() => {}} close={() => {}} org="org" />, el => el)
  t.after(async () => { await view.unmount() })
  const here = remoteView({ name: 'NICK-PC', mode: 'host', scope: 'member' })
  await feed.remotes([here], here, {
    providers: { providers: [CLAUDE_ON] },
    accounts: { accounts: [], host_identity: {} },
    usage: { available: true, email: null, label: 'claude', observed_at: '2026-11-17T12:00:00Z',
      limits: [{ kind: 'weekly', label: 'weekly', percent: 46, resets_at: '2026-11-23T20:00:00Z' }] },
  })
  await inAct(async () => { await flush() })
  const text = view.el.textContent ?? ''
  assert.doesNotMatch(text, /loading…/, 'the figures came: no spinner')
  assert.match(text, /46\s*%/, 'the owner\'s weekly figure shows')
})

const ABSENT = (id: string) => ({ id, label: id, cli: id, tiers: [],
  status: { installed: false, connected: false, kind: 'subscription' }, hire_enabled: false, reason: 'not installed' })

test('a refused or failed usage read shows an error instead of an empty or endless panel', async (t: TestContext) => {
  const g = globalThis as unknown as Record<string, unknown>
  const saved = g.fetch
  t.after(() => { g.fetch = saved })
  const refused = { detail: 'This belongs to NICK-PC.', code: 'E17' }
  g.fetch = legacyAppBackend(((input: unknown) => {
    const path = new URL(String(input), 'http://localhost').pathname
    // no provider lane to draw a card for: before, a refused read left the panel blank
    if (/\/providers$/.test(path)) return Promise.resolve(json({ providers: [ABSENT('claude'), ABSENT('openai'), ABSENT('google')] }))
    if (path === '/api/accounts') return Promise.resolve(json(refused, 403))
    if (/usage/.test(path) || path === '/api/langservers') return Promise.resolve(json(refused, 403))
    return Promise.resolve(json({}))
  }) as typeof fetch)
  const view = await mountView(<UsageModal toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount() })
  await inAct(async () => { await flush(10) })
  const text = view.el.textContent ?? ''
  assert.doesNotMatch(text, /loading…/)
  const alert = view.el.querySelector<HTMLElement>('.usage-load-error[role="alert"]')
  assert.ok(alert, `the panel says why it has nothing to show: ${text}`)
  assert.match(alert.textContent ?? '', /Usage could not be loaded: This belongs to NICK-PC\./)
})

test('a member window of an owner too old to send its usage says so instead of loading forever', async (t: TestContext) => {
  const feed = remoteFeed(t, (url) => json(url.endsWith('/providers') ? { providers: [CLAUDE_ON] }
    : url === '/api/accounts' ? { accounts: [], host_identity: {} } : {}))
  const view = await mountView(<UsageModal toast={() => {}} close={() => {}} org="org" />, el => el)
  t.after(async () => { await view.unmount() })
  const here = remoteView({ name: 'NICK-PC', mode: 'host', scope: 'member', version: '4.6.0' })
  await feed.remotes([here], here, { providers: { providers: [CLAUDE_ON] }, accounts: { accounts: [], host_identity: {} } })
  await inAct(async () => { await flush() })
  const text = view.el.textContent ?? ''
  assert.doesNotMatch(text, /loading…/)
  const note = view.el.querySelector<HTMLElement>('.usage-load-error[role="note"]')
  assert.equal(note?.textContent, 'NICK-PC runs Orgtree 4.6.0, which does not send its usage to other computers. '
    + 'Update NICK-PC to 4.6.2 or later to see its usage here.')
})
