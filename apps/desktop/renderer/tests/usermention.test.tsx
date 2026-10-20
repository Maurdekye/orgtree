// usermention.test.tsx — the user, wherever they hold a slot, keep a
// listener or watch, or listen to a mail queue (docket
// let-the-user-manually-hold-a-number-of-a-project). USER 2026-10-20
// 13:50Z (coordinator m0c7ed2b83916): "wherever a user-held slot, a user
// place in the mail queue or a user listener or watch shows up where an
// agent name would, render the standard user mention, the same chip an @user
// mention gets elsewhere. Don't use the word 'you'." The engine names the
// user "user" (a reserved word: no agent has it); the desk draws it as the
// @user chip.
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 the chip is the app's own @user chip: the same RefChip a mention of
//      @user in prose gets (class, label, title, the click that opens the
//      user's inbox); inert where the surface cannot open the inbox
//   §2 the engine's data name is the one word the desk recognises
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usermention

import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { RefChip } from '../src/canvas/reflinks'
import { UserMention, USER_NAME, isUserName, userMentionRef } from '../src/canvas/usermention'
import { QueueChip } from '../src/canvas/mail'

const world = { org: 'org' } as never

test('§1 the user is drawn as the standard @user mention chip', async (t) => {
  const opened: unknown[] = []
  const refs = { world, onOpen: (r: unknown) => opened.push(r) } as never
  const mine = await mountView(<UserMention refs={refs} />, (el) => el)
  t.after(() => mine.unmount())
  const theirs = await mountView(<RefChip r={userMentionRef(world)} onOpen={() => {}} />, (el) => el)
  t.after(() => theirs.unmount())
  assert.equal(mine.el.innerHTML, theirs.el.innerHTML, 'the very markup RefChip draws for an @user mention')
  const chip = mine.el.querySelector<HTMLButtonElement>('button.ref-chip.ref-mail.ref-ready')
  assert.ok(chip, 'a live chip when the surface can open the inbox')
  assert.equal(chip.textContent, '@user')
  assert.match(chip.title, /open the user's inbox/)
  await inAct(async () => { chip.click() })
  assert.equal(opened.length, 1)
  assert.deepEqual((opened[0] as { ref: { box?: string } }).ref.box, 'user', 'it opens the user\'s box')
  assert.ok(!/\byou\b/i.test(mine.el.textContent ?? ''), 'never the word "you"')
})

test('§1 where the surface cannot open the inbox the chip is inert, still @user', async (t) => {
  const bare = await mountView(<UserMention />, (el) => el)
  t.after(() => bare.unmount())
  const chip = bare.el.querySelector('.ref-chip.ref-mail')
  assert.ok(chip, 'the chip is still drawn')
  assert.equal(chip.tagName, 'SPAN', 'but not a control')
  assert.equal(chip.textContent, '@user')
})

test('§1 a queue chip naming the user draws the chip, not a name nobody has', async (t) => {
  const q = await mountView(<QueueChip q={{ held_by: 'user', ack: true }} />, (el) => el)
  t.after(() => q.unmount())
  assert.ok(q.el.querySelector('.ref-chip.ref-mail'), 'the user is the @user chip')
  assert.match(q.el.textContent ?? '', /@user · awaiting ack/)
  const delivered = await mountView(<QueueChip q={{ held_by: 'user', ack: false }} />, (el) => el)
  t.after(() => delivered.unmount())
  assert.match(delivered.el.textContent ?? '', /→\s*@user/)
  assert.ok(!/\byou\b/i.test(delivered.el.textContent ?? ''))
})

test('§2 the engine\'s data name for the user is the one word the desk recognises', () => {
  assert.equal(USER_NAME, 'user')
  assert.equal(isUserName('user'), true)
  assert.equal(isUserName('worker'), false)
  assert.equal(isUserName('@user'), false, '@user is the actor sentinel of other surfaces, not the data name')
})
