import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { MentionNavigator } from '../src/shell/mentionnavigation'
import type { MentionPage, NavigationMention } from '../src/shell/mentionnavigation'
import { MentionLanding, requestMentionLanding } from '../src/canvas/mentionlanding'
import { ShortcutsSettings } from '../src/canvas/shortcutsettings'

const entry = (id: string, kind: 'mail' | 'work' = 'mail'): NavigationMention => ({
  id, cursor: `2026-10-22T23:00:00Z|${id}`, at: '2026-10-22T23:00:00Z',
  target: kind === 'mail' ? { kind, id: 'mail-one', to: 'user_inbox' } : { kind, item: 'ticket-one' },
  blurb: 'Ready for review, @user. The change is complete.',
})

test('separate rapid presses serialize; oldest does not wrap, seen records are not filtered', async () => {
  const reads: (string | undefined)[][] = [], opened: string[] = [], notices: string[] = []
  const pages: MentionPage[] = [
    { latest_id: '2', mention: entry('2') }, { latest_id: '2', mention: entry('1', 'work') },
    { latest_id: '2', mention: null }, { latest_id: '3', mention: entry('3') },
  ]
  const navigator = new MentionNavigator(async (org, before, latest) => {
    reads.push([org, before, latest]); await Promise.resolve(); return pages.shift()!
  }, (_, mention) => opened.push(mention.id), notice => notices.push(notice))
  navigator.activate('one')
  await Promise.all([navigator.go(), navigator.go(), navigator.go(), navigator.go()])
  assert.deepEqual(opened, ['2', '1', '3'])
  assert.deepEqual(notices, ['No older @user mentions'])
  assert.equal(reads[1][1], entry('2').cursor)
  assert.equal(reads[2][1], entry('1').cursor)
  assert.equal(reads[3][1], entry('1').cursor, 'end does not reset the cursor')
})

test('empty and failed reads keep navigation in place; org switches discard stale responses', async () => {
  let resolve!: (page: MentionPage) => void
  const opened: string[] = [], notices: string[] = []
  const navigator = new MentionNavigator(() => new Promise(done => { resolve = done }),
    org => opened.push(org), notice => notices.push(notice))
  navigator.activate('old')
  const pending = navigator.go(); await Promise.resolve()
  navigator.activate('new')
  resolve({ latest_id: '1', mention: entry('1') }); await pending
  assert.deepEqual(opened, [])
  const empty = new MentionNavigator(async () => ({ latest_id: null, mention: null }),
    () => assert.fail('empty history navigated'), notice => notices.push(notice))
  empty.activate('new'); await empty.go()
  assert.deepEqual(notices, ['No @user mentions yet'])
  const failed = new MentionNavigator(async () => { throw Error('offline') },
    () => assert.fail('failed read navigated'), notice => notices.push(notice))
  failed.activate('new'); await failed.go()
  assert.equal(notices.at(-1), 'Could not load @user mentions')
})

test('mail landing highlights the matching original prose; edited ticket exposes its retained excerpt', async () => {
  const scrolled: string[] = []
  const saved = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.textContent ?? '') }
  const view = await mountView(<div className="mailer-read">
    <MentionLanding org="org" kind="mail" id="mail-one" />
    <div className="md"><p>Ready for review, @user. The change is complete.</p></div>
  </div>, el => el)
  try {
    await inAct(() => requestMentionLanding('org', entry('1')))
    await inAct(() => new Promise(resolve => setTimeout(resolve, 40)))
    assert.equal(view.el.querySelectorAll('p.mention-navigation-highlight').length, 1)
    assert.equal(view.el.querySelector<HTMLElement>('.mention-landing')!.hidden, true)
    await view.unmount()
    const ticket = await mountView(<div className="mailer-read">
      <MentionLanding org="org" kind="work" id="ticket-one" /><p>Edited description.</p>
    </div>, el => el)
    try {
      await inAct(() => requestMentionLanding('org', entry('2', 'work')))
      await inAct(() => new Promise(resolve => setTimeout(resolve, 40)))
      const excerpt = ticket.el.querySelector<HTMLElement>('.mention-landing')!
      assert.equal(excerpt.hidden, false)
      assert.ok(excerpt.textContent?.includes('Ready for review, @user'))
      assert.ok(scrolled.length >= 2)
    } finally { await ticket.unmount() }
  } finally { HTMLElement.prototype.scrollIntoView = saved; if (view.el.isConnected) await view.unmount() }
})

test('Settings reference includes Shift+F4 and its repeated-press behavior', async () => {
  const view = await mountView(<ShortcutsSettings mac={false} />, el => el)
  try {
    assert.ok(view.el.textContent?.includes('Go to the latest @user mention; press again for older mentions'))
    const row = [...view.el.querySelectorAll('.set-row')].find(el => el.textContent?.includes('Go to the latest @user mention'))
    assert.deepEqual([...row!.querySelectorAll('kbd')].map(el => el.textContent), ['Shift', 'F4'])
  } finally { await view.unmount() }
})
