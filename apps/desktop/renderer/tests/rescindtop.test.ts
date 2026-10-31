// rescindtop.test.ts: USER 2026-10-31 14:09:43Z m91787acb55ee "remove the rescind option from top-level agents, it performs effectively
// identically to retire / dissolve". The agent settings dialog's "Agent actions" row offers Rescind only to an agent that has a
// superior (its stake comes out of that superior's grant); a top-level agent (parent = the user) is not offered it at all (hidden, not
// greyed out), and keeps Retire and Dissolve. Read from the source like derived.test.ts: AgentConfig takes ~30 props to mount.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

test('the Rescind button is rendered only when the agent is not top-level', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'modals.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const buttons = [...src.matchAll(/setAsking\('rescind'\)/g)]
  assert.equal(buttons.length, 1, 'one place opens the rescind confirm')
  const at = buttons[0]!.index!
  const before = src.slice(Math.max(0, at - 220), at)
  assert.match(before, /node\.state === 'live' && !isTopLevel\(node, map\) &&/, 'guarded by a live, non-top-level agent')
})

test('the Rescind confirm no longer has a top-level wording', () => {
  const src = readFileSync(path.join(__SRC_DIR__, 'canvas', 'modals.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const i = src.indexOf("asking === 'rescind'")
  assert.ok(i > 0)
  assert.doesNotMatch(src.slice(i, i + 700), /There is no superior grant to reduce/, 'a top-level agent never reaches it')
})
