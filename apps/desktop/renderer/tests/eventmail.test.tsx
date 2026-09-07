import './harness'
import { mountView, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'

declare const __SRC_DIR__: string
const fixture = (variant: string) => JSON.parse(readFileSync(path.resolve(__SRC_DIR__, '../tests/fixtures/events', variant + '.json'), 'utf8')).private
const row = (id: string, variant: string, overrides: Partial<MailRow> = {}): MailRow => ({
  id, from: 'alpha', kind: 'message', at: '2026-09-06T12:00:00Z',
  body: 'Compatibility envelope with repetitive instructions', ev: fixture(variant), ...overrides,
})

test('inbox preserves reply, attachment and retract controls while showing unique typed body', async t => {
  const ev = { ...fixture('reply.document'), actor: { kind: 'agent', id: 'alpha' }, body: 'Unique reply C' }
  const pending = row('p', 'reply.document', { ev, attachments: [{ name: 'sample.txt', path: 'outbox/sample.txt', bytes: 4 }] })
  const replies: string[] = [], retracted: string[] = []
  const view = await mountView(<MailList org="fixture" pending={[pending]}
    onReply={(m, text) => replies.push(m.id + ':' + text)} onRetract={m => retracted.push(m.id!)}
    fileHref={p => '/download/' + p} />, h => h)
  t.after(() => view.unmount())
  const click = async (selector: string) => inAct(() => { (view.el.querySelector(selector) as HTMLElement).click() })
  assert.match(view.el.querySelector('.event-row-kind')!.textContent!, /Presentation reply/)
  await click('.mailrow')
  const message = view.el.querySelector('.mailer-read.event-linked_reply')!
  assert.ok(message, 'family styling belongs to the existing reading pane')
  assert.equal(message.querySelectorAll('.event-card').length, 0, 'no nested panel')
  assert.match(message.querySelector(':scope > .mailer-head')!.textContent!, /Presentation reply/)
  assert.match(view.el.querySelector('.event-body')!.textContent!, /Unique reply C/)
  assert.doesNotMatch(view.el.querySelector('.mailer-read')!.textContent!, /Compatibility envelope/)
  assert.equal(view.el.querySelector('a.attach-chip')!.getAttribute('href'), '/download/outbox/sample.txt')
  assert.ok(view.el.querySelector('.mail-reply'), 'existing reply control stays available')
  await click('button[title="retract (undelivered)"]')
  assert.deepEqual(retracted, ['p'])
  assert.ok(view.el.querySelector('.event-body'), 'retract click does not toggle selection')
})

test('typed notices group only matching variants and retain every complete body', async t => {
  const notices = [
    row('1', 'access.grant_changed', { from: '@system', kind: 'notice' }),
    row('2', 'access.grant_changed', { from: '@system', kind: 'notice' }),
    row('3', 'lifecycle.retired', { from: '@system', kind: 'notice' }),
    row('4', 'lifecycle.retired', { from: '@system', kind: 'notice' }),
    { id: '5', from: '@system', kind: 'notice', at: '2026-09-06T12:00:00Z', body: 'Unclassified old notice' },
  ]
  const view = await mountView(<MailList org="fixture" delivered={notices} />, h => h)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelectorAll('.mailrow').length, 3)
  await inAct(() => { (view.el.querySelector('.mailrow') as HTMLElement).click() })
  assert.equal(view.el.querySelectorAll('.mailer-read [data-event-variant="access.grant_changed"]').length, 2)
  assert.equal(view.el.querySelectorAll('.mailer-read [data-event-variant="lifecycle.retired"]').length, 0)
})

test('engine USER route has system authorship; untyped body is readable without recognizing its header', async t => {
  const engine = row('e', 'runtime.ui_crash_report', { from: '@user' })
  const legacy = row('l', 'ordinary.message', { ev: undefined, body: '[DONE] FROM worker\nuntagged original content' })
  const view = await mountView(<MailList delivered={[engine, legacy]} />, h => h)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('.mailrow .mfrom')!.textContent, '@system')
  await inAct(() => { (view.el.querySelectorAll('.mailrow')[1] as HTMLElement).click() })
  assert.match(view.el.querySelector('.mailer-body')!.textContent!, /\[DONE\] FROM worker/)
  assert.equal(view.el.querySelectorAll('.mailer-read [data-event-variant]').length, 0)
})
