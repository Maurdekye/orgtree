// "— 28 min later —" and "Idle for 28m" say the same quiet time: only one shows (USER 2026-11-03 19:16:01Z m7ce661ebe984).
import test from 'node:test'
import assert from 'node:assert/strict'
import { gapDividerText } from '../src/canvas/statemarker'
import type { ChatMessage } from '../src/types'

const at = (min: number) => new Date(Date.parse('2026-11-03T10:00:00Z') + min * 60e3).toISOString()
const chat = (min: number): ChatMessage => ({ role: 'assistant', text: 'hi', ts: at(min), seq: min } as ChatMessage)
const marker = (min: number, prevSecs: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'system', kind: 'state', state: 'active', prev_state: 'idle', prev_secs: prevSecs, text: 'x', ts: at(min), seq: min, ...over } as ChatMessage)

test('a marker right after the gap that covers it hides the divider (the screenshot: Idle for 28m after 28 min)', () => {
  assert.equal(gapDividerText(marker(0, 20, { state: 'idle', prev_state: 'active' }), marker(28, 28 * 60), true), null)
})

test('no marker keeps the divider', () => {
  assert.equal(gapDividerText(chat(0), chat(28), true), '28 min')
  assert.equal(gapDividerText(chat(0), chat(120), true), '2 h')
})

test('a marker of 10 s next to a 28-minute gap does not explain it: the divider stays', () => {
  assert.equal(gapDividerText(chat(0), marker(28, 10), true), '28 min')
  assert.equal(gapDividerText(marker(0, 10), chat(28), true), '28 min')
})

test('a marker suppressed under one second does not count', () => {
  assert.equal(gapDividerText(chat(0), marker(28, 0), true), '28 min')
})

test('the 50% line: exactly half hides it, just under keeps it', () => {
  assert.equal(gapDividerText(chat(0), marker(28, 14 * 60), true), null)
  assert.equal(gapDividerText(chat(0), marker(28, 14 * 60 - 1), true), '28 min')
})

test('a marker BEFORE the divider never hides it (its ended span lies before that row); a short gap never shows one', () => {
  assert.equal(gapDividerText(marker(0, 60 * 60), chat(60), true), '60 min')
  assert.equal(gapDividerText(chat(0), chat(4), true), null)
  assert.equal(gapDividerText(chat(0), chat(28), false), null, 'only the first row of a message gets one')
})
