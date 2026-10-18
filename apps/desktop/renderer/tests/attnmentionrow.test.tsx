// attnmentionrow.test.tsx — the Attention list's @user MENTION ROW (user
// 2026-10-18 14:39Z, docket inbox-list-user-mention-rows-look-bad-stray-ment:
// "this looks bad, get an opus to clean that up").
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 a mention row is drawn as the inbox draws an unread mail that
//      mentions @user (the urgent attention cue, user 14:38-14:41Z): line 1
//      is the agent, a "mention" pill in the row's pill language and the
//      time; line 2 is one excerpt;
//   §2 the excerpt is cut at word boundaries, keeps @user in it and carries
//      at most a leading and a trailing ellipsis, never one beside @user.
// The geometry (one line, @user in view, pill height) is checked in real
// Chromium by attnmention-visual.mjs.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs attnmentionrow

import test from 'node:test'
import assert from 'node:assert/strict'
import { flush, mountView } from './harness'
import { legacyAppBackend } from './appfeed-fixture'
import { resetSeenMentions } from '../src/canvas/agentmentions'
import { AttentionQueue } from '../src/attention/AttentionQueue'
import { forgetAttentionMode } from '../src/attention/mode'
import { fmtShort } from '../src/timefmt'
import type { TreeNode, TreePayload } from '../src/types'

// blurbs as the engine sends them (runtime/convo.rs user_mention_blurb: up to
// 48 characters each side of @user, cut mid-word and marked with '…')
const cases: [blurb: string, excerpt: string][] = [
  // the user's screenshot: both ends cut mid-word by the engine
  ['…nd you one short message @user. It can already message y…', '…you one short message @user. It can already message…'],
  // the @user sentence's own start fits, so the excerpt begins there
  ['Done with the migration. Heads up @user: it finished cleanly.', 'Heads up @user: it finished cleanly.'],
  // a short lead-in is shown whole
  ['All checks passed — @user ready for your inspection.', 'All checks passed — @user ready for your inspection.'],
  // a long lead-in keeps the nearest whole words, few enough (24 characters)
  // that @user stays in view in the narrowest list
  ['please make sure that the overnight build and the smoke tests are done before @user wakes up',
    '…tests are done before @user wakes up'],
  ['@user the slot is free for you now.', '@user the slot is free for you now.'],
  ['…ssage @user please look', '… @user please look'],
]
const nodes = cases.map(([blurb], i) => ({
  id: `worker-${String.fromCharCode(97 + i)}`, state: 'live', tier: 'haiku', children: [],
  user_mention: { id: `${i + 1}:0`, turn_id: i + 1, seq: 0, event_id: `ev-${i}`, blurb, at: `2026-10-18T1${i}:00:00Z` },
})) as unknown as TreeNode[]

async function mount(t: import('node:test').TestContext) {
  resetSeenMentions()
  forgetAttentionMode()
  const oldFetch = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/work-items') ? { items: [], archived: [], backlogged: [] }
      : url.includes('/inbox') ? { pending: [], archive: [] } : {}
    return { ok: true, status: 200, headers: new Headers(), json: async () => body }
  }) as typeof fetch)
  t.after(() => { globalThis.fetch = oldFetch; resetSeenMentions(); forgetAttentionMode() })
  const tree = { slug: 'org', roots: nodes, asks: [] } as unknown as TreePayload
  const view = await mountView(<AttentionQueue slug="org" tree={tree} toast={() => {}} onFocusAgent={() => {}}
    treeStatus={{ loading: false, stale: false, unavailable: false }} />, (h) => h)
  t.after(() => view.unmount())
  await flush(6)
  const row = (node: TreeNode) => view.el.querySelector<HTMLElement>(
    `[data-attn-row="mention:${node.id}:${(node as unknown as { user_mention: { id: string } }).user_mention.id}"] .attn-mention-row`)
  return { view, row }
}
const classes = (el: Element | null | undefined) => [...(el?.children ?? [])].map((c) => c.className)

/* ─── §1 the row ─────────────────────────────────────────────────────────── */

test('§1 a mention row is drawn as an unread mail row: agent, mention pill and time, then one excerpt', async (t) => {
  const { row } = await mount(t)
  const el = row(nodes[0]!)
  assert.ok(el, 'positive control: the mention row renders')
  assert.ok(el!.classList.contains('mailrow') && el!.classList.contains('unread'), el!.className)
  assert.ok(el!.classList.contains('urgent'), 'the attention cue a mention mail row wears (hasMailAttention)')
  assert.deepEqual(classes(el), ['l1', 'l2'])
  const l1 = el!.querySelector(':scope > .l1')
  assert.deepEqual(classes(l1), ['mfrom', 'mentionkind', 'mtime'])
  assert.equal(l1!.querySelector('.mfrom')!.textContent, 'worker-a')
  assert.equal(l1!.querySelector('.mentionkind')!.textContent, 'mention')
  assert.equal(l1!.querySelector('.mtime')!.textContent, fmtShort('2026-10-18T10:00:00Z'))
  assert.equal(el!.querySelector('.badge') === null, true, 'no generic grey badge')
  const l2 = el!.querySelector(':scope > .l2')
  assert.deepEqual(classes(l2), ['mail-preview-text'], 'one excerpt, not two cut-out halves')
  assert.equal(l2!.querySelector('.attn-mention-token')?.textContent, '@user', 'the token stays marked')
})

/* ─── §2 the excerpt ─────────────────────────────────────────────────────── */

test('§2 the excerpt is cut at word boundaries with @user in it and no ellipsis beside it', async (t) => {
  const { row } = await mount(t)
  cases.forEach(([blurb, excerpt], i) => {
    const text = row(nodes[i]!)?.querySelector('.l2 .mail-preview-text')?.textContent
    assert.equal(text, excerpt, blurb)
    assert.equal(/…@user|@user…/.test(text ?? ''), false, `${blurb}: no ellipsis against @user`)
    assert.equal((text ?? '').slice(1, -1).includes('…'), false, `${blurb}: ellipses only at the ends`)
  })
})
