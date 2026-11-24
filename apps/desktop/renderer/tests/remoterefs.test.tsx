// remoterefs.test.tsx: references in a window of an organization on a remote
// engine whose name there is taken on this computer
// (docs/rust-engine/remote-org.md, "Names").
//
// The organization "acme" of the remote engine Galaxy is listed here as
// "acme-galaxy", because this computer has an "acme" of its own. What agents
// write there says `@item:acme/...`: that is THEIR acme, the one this window
// shows, and never this computer's. What is typed here for them must say
// `@item:acme/...` too, since their engine knows no "acme-galaxy".
//
// Text is in the organization's own names; references held by the window are
// in this computer's. Reading maps one way, writing the other.
//
// Run:  node tests/run.mjs remoterefs
import { mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { refToken, resolveRef, type RefWorld } from '../src/canvas/reflinks'
import { parseRef, scanRefs } from '../src/canvas/workrefs'
import { useRemoteHere } from '../src/remotehere'
import { remoteFeed, remoteView } from './remotefeed.fixture'

function Here() { useRemoteHere(); return null }

const GALAXY = remoteView({ orgs: [
  { alias: 'acme-galaxy', remote_slug: 'acme', name: 'Acme', local_id: -1, gone: false },
  { alias: 'tools', remote_slug: 'tools', name: 'Tools', local_id: -2, gone: false },
  // a name the remote engine no longer lists keeps its alias but maps nothing
  { alias: 'old-galaxy', remote_slug: 'old', name: 'Old', local_id: -3, gone: true },
] })

async function windowOf(t: TestContext, remote: boolean) {
  const feed = remoteFeed(t, () => new Response('{}'))
  const view = await mountView(<Here />, el => el)
  t.after(() => view.unmount())
  await feed.remotes([GALAXY], remote ? GALAXY : undefined)
}

const world = (org: string): RefWorld => ({ org, items: new Map([['fix-login', 'fix-login']]) })

test('a local window reads and writes references as written', async t => {
  await windowOf(t, false)
  assert.equal(parseRef('@item:acme/fix-login')?.org, 'acme')
  assert.equal(refToken({ kind: 'item', org: 'acme-galaxy', id: 'fix-login' }), '@ticket:acme-galaxy/fix-login')
  assert.equal(resolveRef(parseRef('@item:acme/fix-login')!, world('acme-galaxy')).outcome, 'foreign')
})

test('in a remote window a reference to the organization’s own name there is this window’s organization', async t => {
  await windowOf(t, true)
  const ref = parseRef('@item:acme/fix-login')!
  assert.equal(ref.org, 'acme-galaxy', 'held under the name this computer lists it by')
  const resolved = resolveRef(ref, world('acme-galaxy'))
  assert.equal(resolved.outcome, 'ready', 'it is this window’s own item, not another organization’s')
  assert.equal(resolved.token, '@ticket:acme/fix-login', 'written from the reference alone it takes the ticket form, in the organization\u2019s own name; a token in text stays as written (the hits below)')
  // every form of token, and several in one text
  const hits = scanRefs('see @item:acme/fix-login, @doc:tools/d1, @mail:acme/node/lead/m1, @project:acme/web and @item:elsewhere/x')
  assert.deepEqual(hits.map(h => h.ref.org), ['acme-galaxy', 'tools', 'acme-galaxy', 'acme-galaxy', 'elsewhere'])
  assert.deepEqual(hits.map(h => h.token), ['@item:acme/fix-login', '@doc:tools/d1', '@mail:acme/node/lead/m1', '@project:acme/web', '@item:elsewhere/x'],
    'the text itself is untouched')
  // the alias, typed or pasted here, still means this organization
  assert.equal(parseRef('@item:acme-galaxy/fix-login')?.org, 'acme-galaxy')
  // an organization the remote engine no longer lists maps nothing
  assert.equal(parseRef('@item:old/x')?.org, 'old')
})

test('in a remote window a reference is written with the name the organization has on its own engine', async t => {
  await windowOf(t, true)
  assert.equal(refToken({ kind: 'item', org: 'acme-galaxy', id: 'fix-login' }), '@ticket:acme/fix-login')
  assert.equal(refToken({ kind: 'doc', org: 'acme-galaxy', id: 'd1' }), '@doc:acme/d1')
  assert.equal(refToken({ kind: 'mail', org: 'acme-galaxy', box: 'user', id: 'm1' }), '@mail:acme/user/m1')
  assert.equal(refToken({ kind: 'mail', org: 'acme-galaxy', box: 'node', node: 'lead', id: 'm1' }), '@mail:acme/node/lead/m1')
  assert.equal(refToken({ kind: 'agent', org: 'acme-galaxy', id: 'web', as: 'project' }), '@project:acme/web')
  assert.equal(refToken({ kind: 'app', org: 'tools', id: 'board' }), '@app:tools/board', 'a name that is the same on both sides is unchanged')
  assert.equal(refToken({ kind: 'item', org: 'elsewhere', id: 'x' }), '@ticket:elsewhere/x')
  // reading what was written gives the same reference back
  assert.deepEqual(parseRef(refToken({ kind: 'item', org: 'acme-galaxy', id: 'fix-login' })), { kind: 'item', org: 'acme-galaxy', id: 'fix-login' })
})
