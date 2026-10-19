import { useState } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { inAct, mountView } from './harness'
import { MailList } from '../src/canvas/mail'
import { includeSelectedMail, useInboxTagSelection } from '../src/inboxselection'
import type { MailEntry, InboxPayload } from '../src/types'

const rows: MailEntry[] = [
  { id: 'old', from: 'lead', kind: 'message', at: '2026-10-19T10:00:00Z', body: 'Currently open message', tags: ['alpha'] },
  { id: 'clicked', from: 'lead', kind: 'message', at: '2026-10-19T10:01:00Z', body: 'Clicked tagged message', tags: ['alpha', 'Review'] },
  { id: 'newest', from: 'lead', kind: 'message', at: '2026-10-19T10:02:00Z', body: 'Another matching message', tags: ['Review'] },
]
const lookup = async () => null
const box: InboxPayload = { pending: [], delivered: rows, sent: [] }
function Fixture({ mode = 'agent', initial = [] }: { mode?: string; initial?: string[] }) {
  const [tags, setTags] = useState(initial)
  const selection = useInboxTagSelection(`tag-click-${mode}`, box, tags, mode === 'user', lookup)
  const current = includeSelectedMail(box, selection.extra, tags)!
  return <MailList delivered={current.delivered} projectMail={mode === 'project'}
    selectOldestUnread={mode === 'user'} selectionRequest={mode === 'user' ? selection.request : undefined}
    onOpenMail={selection.remember} tagFilter={{ selected: tags, choices: ['alpha', 'Review'], onChange: setTags }}/>
}
const row = (el: HTMLElement, text: string) => [...el.querySelectorAll<HTMLElement>('.mailrow')].find(r => r.textContent?.includes(text))!
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')?.textContent ?? ''
const clickRow = async (el: HTMLElement, text: string) => inAct(() => row(el, text).click())
const clickTag = async (el: HTMLElement, text: string, tag = 'review') => inAct(() => row(el, text).querySelector<HTMLButtonElement>(`button[data-tag-key="${tag}"]`)!.click())

for (const mode of ['user', 'agent', 'project']) {
  test(`${mode} inbox opens the clicked tag's mail when the current mail drops out`, async t => {
    const v = await mountView(<Fixture mode={mode}/>, el => el)
    t.after(() => v.unmount())
    await clickRow(v.el, 'Currently open message')
    await clickTag(v.el, 'Clicked tagged message')
    assert.match(pane(v.el), /Clicked tagged message/)
    assert.match(v.el.querySelector('.mailrow.on')?.textContent ?? '', /Clicked tagged message/)
    assert.equal(v.el.querySelectorAll('.mailrow').length, 2)
    await v.render(<Fixture mode={mode}/>)
    assert.match(pane(v.el), /Clicked tagged message/, 'refresh retains the explicit choice')
    await clickRow(v.el, 'Clicked tagged message')
    assert.equal(v.el.querySelector('.mailrow.on') === null, true, 'the selected row still toggles off')
  })
}

test('adding a second normalized tag opens the clicked mail and requires every tag', async t => {
  const v = await mountView(<Fixture initial={[' ALPHA ']}/>, el => el)
  t.after(() => v.unmount())
  await clickRow(v.el, 'Currently open message')
  await clickTag(v.el, 'Clicked tagged message')
  assert.match(pane(v.el), /Clicked tagged message/)
  assert.equal(v.el.querySelectorAll('.mailrow').length, 1)
})

test('a current mail that still matches stays open', async t => {
  const v = await mountView(<Fixture/>, el => el)
  t.after(() => v.unmount())
  await clickRow(v.el, 'Another matching message')
  await clickTag(v.el, 'Clicked tagged message')
  assert.match(pane(v.el), /Another matching message/)
})

test('turning a tag filter off keeps the current mail', async t => {
  const v = await mountView(<Fixture initial={['REVIEW']}/>, el => el)
  t.after(() => v.unmount())
  await clickRow(v.el, 'Another matching message')
  await clickTag(v.el, 'Clicked tagged message')
  assert.match(pane(v.el), /Another matching message/)
  assert.equal(v.el.querySelectorAll('.mailrow').length, 3)
})

test('tag filtering preserves a reader-cleared pane', async t => {
  const v = await mountView(<Fixture/>, el => el)
  t.after(() => v.unmount())
  await clickRow(v.el, 'Currently open message')
  await clickRow(v.el, 'Currently open message')
  await clickTag(v.el, 'Clicked tagged message')
  assert.equal(v.el.querySelector('.mailrow.on') === null, true)
  assert.equal(v.el.querySelector('.mailer-body') === null, true)
})
