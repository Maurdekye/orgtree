import './harness'
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Msg } from '../src/canvas/desk'
import { MailList } from '../src/canvas/mail'
import { decodeEventRow, isEvent } from '../src/events/decode'
import { isSegments } from '../src/events/wire'
import { transcriptEntries } from '../src/events/systemruns'
import type { ChatMessage } from '../src/types'

declare const __SRC_DIR__: string
const at = '2026-11-08T21:00:00Z'
const body = (name: string, n: string | number = 2) =>
  `Project "${name}" was dissolved by the user. Its whole subtree was retired (${n} node(s)).`
const node = (name: string) => ({ kind: 'node', org: 'fixture', id: name, name, generation: 1 })
function notice(text: string, object: unknown = null, from = '@system', engine = true) {
  return { id: text, from, kind: 'notice', notice: true, at, body: text,
    ev: { v: 1, variant: 'ordinary.notice', actor: { kind: engine ? 'system' : 'agent', id: engine ? '@system' : from },
      engine_authored: engine, object, body: text } }
}
const delivery = (rows: ReturnType<typeof notice>[]): ChatMessage => ({ role: 'user', text: rows.map(r => r.body).join('\n\n'),
  ts: at, steered: true, receipt: 'Delivered after a tool call.', segments: [{ kind: 'mail', rows }] })
const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
async function render(t: test.TestContext, rows: ReturnType<typeof notice>[]) {
  const view = await mountView(<Msg m={delivery(rows)} slug="fixture" nid="worker" />, h => h)
  t.after(() => view.unmount())
  return view.el
}
const titles = (el: HTMLElement) => [...el.querySelectorAll('.event-head strong')].map(e => flat(e.textContent))
const lines = (el: HTMLElement) => [...el.querySelectorAll('.event-change-line')].map(e => flat(e.textContent))

for (const historic of [false, true]) test(`project notices: two ${historic ? 'historic node-object' : 'null-object'} dissolves are separate cards in delivery order`, async t => {
  const rows = ['p1', 'p2'].map((name, i) => notice(body(name, i ? 5 : 2), historic ? node(name) : null))
  const el = await render(t, rows)
  assert.deepEqual(titles(el), ['Project dissolved', 'Project dissolved'])
  assert.deepEqual(lines(el), ['p1 dissolved · 1 node retired with it', 'p2 dissolved · 4 nodes retired with it'])
  assert.equal(el.querySelectorAll('.event-lifecycle').length, 2)
  assert.equal(el.querySelectorAll('.turn-mail-passive').length, 2)
  assert.equal(el.querySelectorAll('.turn-mail-head time').length, 2)
  assert.deepEqual([...el.querySelectorAll('.event-actor')].map(e => e.textContent), ['User', 'User'])
  assert.equal(el.querySelector('.msgtext'), null, 'no combined plain message block')
  assert.equal(el.querySelector('.transcript-system-run'), null, 'each card stays unfolded')
  assert.ok(transcriptEntries([delivery(rows)]).every(e => !e.system), 'desk run grouping keeps cards separate')
  const contexts = [...el.querySelectorAll<HTMLDetailsElement>('.event-context')]
  assert.deepEqual(contexts.map(e => e.open), [false, false])
  for (const [i, context] of contexts.entries()) {
    assert.deepEqual([...context.querySelectorAll('[data-event-field]')].map(e => e.getAttribute('data-event-field')), ['node', 'by', 'nodes'])
    assert.equal(flat(context.querySelector('[data-event-field="nodes"]')?.textContent), `Nodes${i ? 5 : 2}`)
  }
})

test('project notices: bad-object historic notice does not hide its ordinary message batch sibling', async t => {
  const project = notice(body('p1'), node('p1'))
  const ordinary = { ...notice('A normal message', null, 'peer', false), kind: 'message', notice: false,
    ev: { ...notice('A normal message', null, 'peer', false).ev, variant: 'ordinary.message' } }
  const before = JSON.stringify(project)
  const el = await render(t, [project, ordinary])
  assert.deepEqual(titles(el), ['Project dissolved', 'Message'])
  assert.match(el.querySelector('.event-ordinary .event-body')!.textContent!, /A normal message/)
  assert.equal(JSON.stringify(project), before, 'rendering never mutates stored wire data')
  assert.equal(isEvent(project.ev), false, 'canonical schema still rejects the historic object')
  assert.equal(decodeEventRow(project, 'operator').kind, 'known', 'compatibility runs before row validation')
  assert.equal(isSegments(delivery([project, ordinary]).segments, 'operator'), true)
})

for (const [verb, title, action] of [
  ['created', 'Project created', 'created'], ['retired', 'Project retired', 'retired'],
  ['restored', 'Project restored', 'restored'], ['permanently deleted', 'Project deleted', 'deleted'],
]) test(`project notices: ${verb} uses lifecycle layout and the recorded agent actor`, async t => {
  const el = await render(t, [notice(`Project "team-x" was ${verb} by "lead-x".`)])
  assert.deepEqual(titles(el), [title])
  assert.deepEqual(lines(el), [`team-x ${action}`])
  assert.equal(flat(el.querySelector('.event-actor')?.textContent), 'lead-x')
  const context = el.querySelector('.event-context')!
  assert.deepEqual([...context.querySelectorAll('[data-event-field]')].map(e => e.getAttribute('data-event-field')), ['node', 'by'])
  assert.match(context.querySelector('[data-event-field="by"]')!.textContent!, /lead-x/)
})

test('project notices: one raw node means no accompanying node suffix; one trailing newline is accepted', async t => {
  const el = await render(t, [notice(body('solo', 1) + '\n')])
  assert.deepEqual(lines(el), ['solo dissolved'])
})

test('project notices: an envelope SYSTEM sender also proves authorship', async t => {
  const el = await render(t, [notice(body('p1'), node('p1'), '@system', false)])
  assert.deepEqual(titles(el), ['Project dissolved'])
})

test('project notices: matching user and agent prose stays ordinary', async t => {
  for (const from of ['peer', '@user']) {
    const row = notice(body('p1'), null, from, false)
    if (from === '@user') row.ev.actor.kind = 'user'
    const el = await render(t, [row])
    assert.deepEqual(titles(el), ['Notice'])
    assert.equal(el.querySelector('.event-change'), null)
    assert.match(el.querySelector('.event-body')!.textContent!, /Its whole subtree/)
  }
})

for (const text of [
  'Project "p1" was dissolved by the user.',
  'Project "p1" was retired by the user. Its whole subtree was retired (2 node(s)).',
  body('p1') + ' Extra', body('p1').replace('Project', 'project'),
  body('p1', 0), body('p1', '02'), body('p1', '9007199254740992'),
  ' ' + body('p1'), body('p1') + '\n\n',
]) test(`project notices: unrecognised format stays ordinary: ${JSON.stringify(text)}`, async t => {
  const el = await render(t, [notice(text)])
  assert.deepEqual(titles(el), ['Notice'])
  assert.equal(el.querySelector('.event-change'), null)
})

test('project notices: other schema errors stay rejected, including malformed node references', () => {
  for (const ev of [
    { ...notice(body('p1'), node('p1')).ev, v: 2 },
    { ...notice(body('p1'), node('p1')).ev, extra: 'not allowed' },
    { ...notice(body('p1'), { ...node('p1'), extra: 'not allowed' }).ev },
    { ...notice(body('p1'), { kind: 'node', id: 'p1' }).ev },
  ]) assert.equal(decodeEventRow({ ev }, 'operator').kind, 'unsupported')
})

test('project notices: inbox kind chip uses the same project card title', async t => {
  const view = await mountView(<MailList org="fixture" delivered={[notice(body('p1'), node('p1'))]} />, h => h)
  t.after(() => view.unmount())
  assert.equal(flat(view.el.querySelector('.event-row-kind')?.textContent), 'Project dissolved')
})

test('project notices: engine wording and five verbs stay pinned to the compatibility parser', () => {
  const source = readFileSync(path.resolve(__SRC_DIR__, '../../../../engine/rs/orgtree-engine/src/domain/lifecycle.rs'), 'utf8')
  for (const literal of ['Project \\"{}\\" was {verb} by {actor}.', ' Its whole subtree was retired ({} node(s)).',
    '"created"', '"retired"', '"dissolved"', '"permanently deleted"', '"restored"']) assert.ok(source.includes(literal), literal)
})
