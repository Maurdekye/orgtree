// viewingroup.test.tsx — every message menu groups its "View in …" entries
// (USER 2026-11-25 21:38:09Z md7da554ce837, chats panel on 4.7.0-alpha.6:
// "on message context menus group the  'view in" items together"; docket
// message-context-menus-group-the-view-in-entries-t). One shared rule in
// mailMenuEntries (canvas/mailidentity.ts), which every message menu goes
// through: the chats panel's bubbles (DmPanel), mail rows (MailList: the
// classic inbox, agent/project mailboxes, desk Mail tabs; the Attention view)
// and mail links (objectnavhost: transcripts, bodies, presentations). The
// group is its own separated section, in one order: View in chat, View in
// classic inbox, View in transcript, then any other "View in …".
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs viewingroup

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as identity from '../src/canvas/mailidentity'
import { mailMenuEntries } from '../src/canvas/mailidentity'
import { mailRowMenuEntries } from '../src/canvas/mail'
import { VIEW_IN_CHAT, VIEW_IN_CLASSIC } from '../src/mailboxpref'
import type { MenuEntry } from '../src/canvas/contextmenu'

const labels = (entries: MenuEntry[]) => entries.map(e => (e === 'sep' ? '-' : e.label))
const item = (label: string): MenuEntry => ({ label, onSelect() {} })
const copy = { copy() {}, canCopy: true, reference: '@mail:o/user/m1', copyReference() {} }
const COPY = ['Copy message text', 'Copy reference']

test('the shared order is View in chat, View in classic inbox, View in transcript', () => {
  assert.deepEqual((identity as { VIEW_IN_ORDER?: unknown }).VIEW_IN_ORDER,
    [VIEW_IN_CHAT, VIEW_IN_CLASSIC, 'View in transcript'], 'mailidentity exports VIEW_IN_ORDER')
})

test('a chats bubble: its own entries, then the View in group in the shared order, then copy', () => {
  // the bubble's leading list as DmPanel builds it today (View in entries scattered, Sender… among them)
  const leading = ['Reply', 'Mark as read', 'View in @worker’s inbox', 'View in transcript', 'Sender…', 'View in classic inbox'].map(item)
  assert.deepEqual(labels(mailMenuEntries({ leading, ...copy })),
    ['Reply', 'Mark as read', 'Sender…', '-', 'View in classic inbox', 'View in transcript', 'View in @worker’s inbox', '-', ...COPY])
})

test('a mail link: Open, then both views as a group, then copy', () => {
  const leading = ['Open', VIEW_IN_CLASSIC, VIEW_IN_CHAT].map(item)
  assert.deepEqual(labels(mailMenuEntries({ leading, ...copy })), ['Open', '-', VIEW_IN_CHAT, VIEW_IN_CLASSIC, '-', ...COPY])
})

test('a menu of only View in entries gets no empty section; one with none is unchanged', () => {
  assert.deepEqual(labels(mailMenuEntries({ leading: [item('View in transcript'), item(VIEW_IN_CHAT)], ...copy })),
    [VIEW_IN_CHAT, 'View in transcript', '-', ...COPY])
  assert.deepEqual(labels(mailMenuEntries({ leading: [item('Reply'), item('Delete')], ...copy })), ['Reply', 'Delete', '-', ...COPY])
  assert.deepEqual(labels(mailMenuEntries({ leading: [], ...copy })), COPY)
})

test('a mail row (MailList, Attention): View in chat leaves the Open/Reply block for its own section', () => {
  const noop = () => {}
  const row = { id: 'm1', from: 'worker', to: '@user', subject: 's', body: 'hello', _wait: true } as never
  const entries = mailRowMenuEntries(row, { selected: false, open: noop, close: noop, reply: noop, markRead: noop,
    remove: noop, viewInChat: noop } as never, { el: null, org: 'o', reference: '@mail:o/user/m1' })
  assert.deepEqual(labels(entries), ['Open', 'Reply', 'Mark as read', 'Delete', '-', VIEW_IN_CHAT, '-', ...COPY])
})
