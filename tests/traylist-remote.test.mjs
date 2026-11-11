// The tray's org list and organizations of remote engines (docs/rust-engine/remote-org.md):
// a remote row is marked with its engine's name, and shows no counts while its
// link is not connected. Run: node tests/run.mjs tests/traylist-remote.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// a worktree without node_modules names the dependency checkout (ORGTREE_TEST_DEPS)
const { build } = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-traylist-remote-test-'))
const out = path.join(temp, 'traylist.cjs')
await build({ entryPoints: ['apps/desktop/main/traylist.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
const { orgActivityRows, trayListHtml } = createRequire(import.meta.url)(out)

const rows = [
  { slug: 'alpha', name: 'Alpha Org', working: 2, live: 5, attention: 0 },
  { slug: 'idle-org', name: 'Idle', working: 0, live: 3, attention: 0 },
]

test('an organization on a remote engine says so in the tray list, and says when it is not connected', () => {
  const listed = orgActivityRows([
    { slug: 'alpha', name: 'Alpha Org', working: 2, live: 5 },
    { slug: 'far-lab', name: 'Far Lab', working: 1, live: 2, remote: { id: 'r1', name: 'Galaxy <b>', tag: 'galaxy', slug: 'far-lab', state: 'connected' } },
    { slug: 'beta-galaxy', name: 'Beta', working: 0, live: 3, remote: { id: 'r1', name: 'Galaxy <b>', tag: 'galaxy', slug: 'beta', state: 'offline' } },
    { slug: 'odd', name: 'Odd', working: 0, live: 1, remote: { name: 7 } },
  ])
  assert.deepEqual(listed, [
    { slug: 'alpha', name: 'Alpha Org', working: 2, live: 5, attention: 0 },
    { slug: 'far-lab', name: 'Far Lab', working: 1, live: 2, attention: 0, remote: { name: 'Galaxy <b>', connected: true } },
    { slug: 'beta-galaxy', name: 'Beta', working: 0, live: 3, attention: 0, remote: { name: 'Galaxy <b>', connected: false } },
    { slug: 'odd', name: 'Odd', working: 0, live: 1, attention: 0 },
  ], 'a local row has no remote member; a malformed mark is no mark')
  const html = trayListHtml(listed)
  // the engine's name follows the organization's, dimmed, as text
  assert.ok(html.includes('<span class="name">Far Lab<i class="on"> · Galaxy &lt;b&gt;</i></span>'), html)
  assert.ok(html.includes('title="Far Lab — 1 active / 2 hired — on Galaxy &lt;b&gt; (remote engine)"'), html)
  // not connected: no count this computer cannot vouch for, and the reason in the tooltip
  assert.ok(html.includes('title="Beta — on Galaxy &lt;b&gt; (remote engine), not connected"'), html)
  assert.ok(html.includes('<span class="name">Beta<i class="on"> · Galaxy &lt;b&gt;</i></span><span class="ct">–</span>'), html)
  assert.ok(html.includes('.on{font-style:normal;color:#9a9a9a}'), 'the mark uses the count column’s dim colour')
  // a local row is byte for byte what it was
  assert.ok(html.includes('<span class="name">Alpha Org</span><span class="ct">2/5</span>'))
  assert.equal(trayListHtml(rows), trayListHtml(rows.map(r => ({ ...r }))))
})
