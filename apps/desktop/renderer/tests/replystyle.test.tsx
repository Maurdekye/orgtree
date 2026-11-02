// Reply blocks restyled to the app's message-block language
// (@item:orgtree/restyle-reply-blocks-and-the-inline-quoted-reply,
// USER 2026-11-02 m0a48d522be9c).
import { inAct, flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import React from 'react'
import { MailReplyPreview } from '../src/canvas/mailreply'
import type { RefWorld } from '../src/canvas/reflinks'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const fixture = (name: string) => JSON.parse(readFileSync(
  path.resolve(__SRC_DIR__, '../tests/fixtures/events/' + name + '.json'), 'utf8')).private
const org = 'synthetic'
const world: RefWorld = { org, handles: new Set(['mail', 'item', 'doc']) }

/** every declaration the stylesheet gives one exact selector, in order */
const rules = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[1]).join(';')
}
const last = (decls: string, prop: string): string | undefined => {
  const all = [...decls.matchAll(new RegExp(`(?:^|[;\\s{])${prop}\\s*:\\s*([^;]+)`, 'g'))].map(m => m[1]!.trim())
  return all.at(-1)
}

test('§1 the reply block is a nested message block: quote edge, card border, page background', () => {
  const block = rules('.reply-preview')
  assert.equal(last(block, 'border-left'), '3px solid var(--line)', 'the app quote edge, not --accent')
  assert.doesNotMatch(block, /--accent/, 'no accent-coloured edge or tint at rest')
  assert.equal(last(block, 'border'), '1px solid var(--line-soft)', 'the event card border')
  assert.equal(last(block, 'border-radius'), '5px')
  assert.equal(last(block, 'background'), 'var(--bg)', 'the event card background')
})

test('§2 its head is left-aligned and wraps like the event head; the quote never scrolls inside', () => {
  const head = rules('.reply-preview-head')
  assert.equal(last(head, 'justify-content'), 'flex-start', 'not centred between icon and chip')
  assert.equal(last(head, 'flex-wrap'), 'wrap')
  assert.equal(last(head, 'font-size'), '11px', 'the event head size')
  assert.equal(last(head, 'border-bottom'), '1px solid var(--line-soft)')
  const quote = rules('.reply-preview blockquote')
  assert.equal(last(quote, 'overflow'), 'hidden')
  assert.equal(last(quote, '-webkit-line-clamp'), '3')
  assert.equal(last(quote, 'max-height'), undefined, 'clamped by lines, not a scrolling height')
  assert.match(rules('.reply-preview-content :is(.msg, .event-card, .event-surface, .turn-mail)'), /border-left:\s*0 !important/,
    'an embedded source card draws no second coloured edge')
})

test('§3 a linked reply does not repeat the card header\'s object chip; a stored snapshot keeps it', async () => {
  const ev = fixture('reply.mail')
  ev.object = { ...ev.object, org, box: 'user', id: 'm-original' }
  ev.quote = { from: 'liaison-opus', at: '2026-11-02T21:05:29Z', gist: 'The quoted text' }
  const linked = await mountView(<MailReplyPreview row={{ ev }} org={org} world={world} onOpen={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    const head = linked.el.querySelector('.reply-preview-head')!
    assert.match(head.textContent ?? '', /In reply to liaison-opus/)
    assert.equal(head.querySelector('.ref-chip'), null, 'the card header already shows this mail')
    assert.equal(linked.el.querySelector('.reply-preview blockquote')?.textContent, 'The quoted text')
    assert.equal(linked.el.querySelector('.reply-preview')?.getAttribute('role'), 'link', 'the whole block still opens the original')
  } finally { await linked.unmount() }
  const legacy = await mountView(<MailReplyPreview row={{ reply_to: { kind: 'mail', box: 'user', id: 'm-old', from: 'writer', gist: 'Old text' } }}
    org={org} world={world} onOpen={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(3) })
    assert.ok(legacy.el.querySelector('.reply-preview-head .ref-chip'), 'no header shows it elsewhere: the chip stays')
  } finally { await legacy.unmount() }
})
