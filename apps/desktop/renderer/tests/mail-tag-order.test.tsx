import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MailList } from '../src/canvas/mail'

const row = (tags: string[]) => ({ id: 'tag-order', from: 'lead', kind: 'message', at: '2026-10-19T19:00:00Z', body: 'Release update', tags })
const preview = (el: HTMLElement) => el.querySelector<HTMLElement>('.mailrow .l2')!
const names = (el: HTMLElement) => [...preview(el).querySelectorAll('.mail-tag[data-tag-key]')].map(t => t.textContent)
const filter = (selected: string[]) => ({ selected, choices: ['build', 'alpha', 'Review', 'release'], onChange: () => {} })

test('a collapsed row shows the active filter tag instead of its first stored tag', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha', 'Review'])]} tagFilter={filter([' REVIEW '])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.textContent, '+2')
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.getAttribute('title'), 'build, alpha')
})

test('project rows expose every matching filter in filter order and count only the remaining tags', async t => {
  const tags = ['build', 'alpha', 'Review', 'release']
  const v = await mountView(<MailList projectMail delivered={[row(tags)]} tagFilter={filter(['Review', 'alpha'])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review', 'alpha'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.textContent, '+2')
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.getAttribute('title'), 'build, release')
  assert.equal(preview(v.el).getAttribute('title'), 'build, alpha, Review, release', 'full labels remain available on hover')
  assert.deepEqual(tags, ['build', 'alpha', 'Review', 'release'], 'display ordering never mutates the mail')
})

test('without an active filter the existing single-tag overflow stays unchanged', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha', 'Review'])]}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['build'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.textContent, '+2')
})

test('two tags keep their stored order even with an active filter', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha'])]} tagFilter={filter(['alpha'])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['build', 'alpha'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more') === null, true)
})

test('when every tag is filtered for, every tag is visible and no overflow pill remains', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha', 'Review'])]} tagFilter={filter(['Review', 'build', 'alpha'])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review', 'build', 'alpha'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more') === null, true)
})
