// remotepicker.test.tsx: in a window of an organization on a remote engine the
// folder picker browses THAT engine's disk (its listing is an engine route,
// relayed), and a language model server's address is dialed from there. Both
// say so (docs/rust-engine/remote-org.md, "What depends on the computer").
//
// Run:  node tests/run.mjs remotepicker
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { FolderPickerHost, pickFolder } from '../src/picker'
import { remoteAddressNote, useRemoteHere } from '../src/remotehere'
import { remoteFeed, remoteView } from './remotefeed.fixture'

function Here() { useRemoteHere(); return null }

async function picker(t: TestContext, remote: boolean) {
  const feed = remoteFeed(t, () => new Response(JSON.stringify({ path: '', home: '/home/orgtree', parent: null, dirs: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
  const view = await mountView(<><Here /><FolderPickerHost /></>, el => el)
  t.after(() => view.unmount())
  await feed.remotes([remoteView()], remote ? remoteView() : undefined)
  let picked: unknown
  await inAct(async () => { void pickFolder().then(r => { picked = r }); await flush() })
  t.after(() => { document.querySelector<HTMLElement>('.picker-overlay')?.click() })
  return { title: () => document.querySelector('.picker h3')?.textContent?.trim(), picked: () => picked }
}

test('a local window\u2019s folder picker is titled as before', async t => {
  const p = await picker(t, false)
  assert.equal(p.title(), 'choose a folder')
})

test('a remote window\u2019s folder picker says whose folders it lists', async t => {
  const p = await picker(t, true)
  assert.equal(p.title(), 'choose a folder on Galaxy')
  assert.equal(document.querySelector('.picker h3')?.getAttribute('title'), 'These are folders on Galaxy, the remote engine this organization runs on.')
})

test('the note for an address that the remote engine dials', () => {
  assert.equal(remoteAddressNote('Galaxy'), 'Addresses are as seen from Galaxy.')
})
