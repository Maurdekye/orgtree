import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'
import { MailMessage } from '../src/events/segments'

declare const __SRC_DIR__: string

const row = (id: string, overrides: Partial<MailRow> = {}): MailRow => ({
  id, from: 'peer', kind: 'message', at: '2026-10-19T12:00:00Z',
  body: 'A normal message.', ...overrides,
})

test('actual urgent mail flags highlight transcript cards and inbox rows; prose alone does not', async t => {
  const urgent = row('urgent', { urgent: true, urgent_reason: 'time-sensitive' })
  const plain = row('plain', { body: 'This message mentions urgent, but is not flagged.' })
  const attentionOnly = row('attention', { mailbox_attention: true })
  const view = await mountView(<div>
    <MailMessage row={urgent} profile="operator" slug="fixture" nid="worker" />
    <MailMessage row={plain} profile="operator" slug="fixture" nid="worker" />
    <MailList org="fixture" delivered={[urgent, plain, attentionOnly]} />
  </div>, el => el)
  t.after(() => view.unmount())

  const transcriptCards = [...view.el.querySelectorAll<HTMLElement>('.turn-mail')]
  assert.equal(transcriptCards.length, 2)
  assert.ok(transcriptCards[0]!.classList.contains('urgent-mail'),
    'the transcript card uses the real urgent flag')
  assert.ok(transcriptCards[0]!.querySelector('.urgentkind'),
    'the transcript card keeps a text cue as well as color')
  assert.ok(!transcriptCards[1]!.classList.contains('urgent-mail'),
    'urgent wording in the body does not mark ordinary mail')
  assert.ok(!transcriptCards[1]!.querySelector('.urgentkind'))

  const inboxRows = [...view.el.querySelectorAll<HTMLElement>('.mailrow')]
  assert.equal(inboxRows.length, 3)
  assert.equal(view.el.querySelectorAll('.mailrow.urgent-mail').length, 1,
    'mailbox attention alone does not use the urgent mail color')
  assert.equal(inboxRows[0]!.querySelector('.urgentkind')?.textContent, 'urgent')

  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /:is\(\.turn-mail\.urgent-mail, \.msg\.user\.event-surface\.event-notice\.urgent-mail\)\s*\{[^}]*#ff4500/is,
    'transcript urgency uses the shared orangered color')
  assert.match(css, /\.mailrow\.urgent-mail\s*\{[^}]*#ff4500/i,
    'inbox urgency uses the shared orangered color')
})
