import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Msg } from '../src/canvas/desk'
import { dismissUserMention, hasUnseenUserMention, clearMentionHighlight, resetSeenMentions } from '../src/canvas/agentmentions'
import type { ChatMessage, TreeNode } from '../src/types'

const message = (text: string, role = 'assistant'): ChatMessage => ({ role, text, tools: [] } as ChatMessage)
const render = (m: ChatMessage) => <Msg m={m} slug="mention-org" nid="worker" />

test('a two-paragraph @user reply has exactly one message-block highlight', async () => {
  const view = await mountView(render(message('Please review @user.\n\nThe second paragraph stays part of this reply.')), el => el)
  try {
    assert.equal(view.el.querySelectorAll('.msg.assistant p').length, 2, 'positive control: complete reply rendered')
    assert.equal(view.el.querySelectorAll('.mention-highlight').length, 1)
    assert.equal(view.el.querySelector('.msg.assistant')?.classList.contains('mention-highlight'), true)
    assert.equal(view.el.querySelector('.mention-highlight-line, p.mention-highlight, .ctx-target') === null, true)
  } finally { await view.unmount() }
})

test('dismissal clears attention while message highlight survives transient reset and remount', async t => {
  resetSeenMentions()
  const oldFetch = globalThis.fetch
  const posts: string[] = []
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    posts.push(String(url))
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true }) } as Response
  }) as typeof fetch
  t.after(() => { globalThis.fetch = oldFetch; resetSeenMentions() })
  const node = { id: 'worker', user_mention: { id: 'turn:row', event_id: 'reply-row' } } as TreeNode
  assert.equal(hasUnseenUserMention(node, 'mention-org'), true)
  const stored = message('Ready for you, @user.\n\nA second paragraph.')
  let view = await mountView(render(stored), el => el)
  const results = [view.el.querySelector('.msg')?.classList.contains('mention-highlight')]
  try {
    await inAct(async () => { await dismissUserMention('mention-org', 'worker', 'turn:row', 'reply-row', { highlight: true }); await flush(1) })
    assert.equal(hasUnseenUserMention(node, 'mention-org'), false, 'attention clears immediately')
    clearMentionHighlight('mention-org', 'worker')
    results.push(view.el.querySelector('.msg')?.classList.contains('mention-highlight'))
  } finally { await view.unmount() }
  resetSeenMentions() // a new renderer has no local attention/jump selection
  view = await mountView(render(JSON.parse(JSON.stringify(stored))), el => el)
  try { results.push(view.el.querySelector('.msg')?.classList.contains('mention-highlight')) }
  finally { await view.unmount() }
  assert.equal(posts.length, 1)
  assert.equal(posts[0]?.endsWith('/mention-seen'), true)
  assert.deepEqual(results, [true, true, true])
})

test('non-mentions and user/system messages do not acquire the agent highlight', async () => {
  const rows = [message('Ordinary reply'), message('email@user.com and @username and /@user/path'),
    message('Quoted by the operator @user', 'user'), message('System @user', 'system'),
    { ...message('Ordinary reply'), thinking: 'thinking about @user', tools: [] }]
  const view = await mountView(<>{rows.map((m, i) => <div key={i}>{render(m)}</div>)}</>, el => el)
  try {
    assert.equal(view.el.querySelectorAll('.msg').length >= rows.length, true, 'positive control: all roles rendered')
    assert.equal(view.el.querySelector('.mention-highlight') === null, true)
  } finally { await view.unmount() }
})

test('shared Msg highlights reconstructed ordered replies in an adopted transcript document', async () => {
  const other = document.implementation.createHTMLDocument('Pinned transcript')
  const holder = other.createElement('div'); other.body.append(holder)
  const m = message('First paragraph @user.\n\nSecond paragraph.')
  m.content_blocks = [{ kind: 'text', start: 0, end: m.text.length }]
  const view = await mountView(<>{createPortal(render(m), holder)}</>, el => el)
  try {
    assert.equal(holder.querySelectorAll('.msg.assistant p').length, 2)
    assert.equal(holder.querySelectorAll('.mention-highlight').length, 1)
    assert.equal(holder.querySelector('.msg')?.ownerDocument, other)
    assert.equal(holder.querySelector('.mention-highlight-line') === null, true)
  } finally { await view.unmount() }
})

test('attention navigation no longer imperatively adds or removes mention styling', () => {
  const source = readFileSync(path.join(__SRC_DIR__, 'canvas', 'desk.tsx'), 'utf8')
  const start = source.indexOf('const evId = mentionHighlight.eventId')
  const end = source.indexOf('}, [mentionHighlight,', start)
  assert.ok(start >= 0 && end > start, 'positive control: navigation effect located')
  const effect = source.slice(start, end)
  assert.doesNotMatch(effect, /classList\.(?:add|remove)\([^\n]*mention-highlight/)
  assert.doesNotMatch(effect, /classList\.(?:add|remove)\([^\n]*ctx-target/)
  assert.match(effect, /scrollIntoView/)
})

test('one softer theme-relative message layer replaces the nested paragraph layer', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.doesNotMatch(css, /\.mention-highlight-line\s*\{/)
  assert.match(css, /\.msg\.mention-highlight\s*\{[^}]*var\(--accent\) 10%/)
})
