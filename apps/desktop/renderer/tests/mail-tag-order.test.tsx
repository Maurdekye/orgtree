import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MailList, MailRowView } from '../src/canvas/mail'

const row = (tags: string[]) => ({ id: 'tag-order', from: 'lead', kind: 'message', at: '2026-10-19T19:00:00Z', body: 'Release update', tags })
const preview = (el: HTMLElement) => el.querySelector<HTMLElement>('.mailrow .l2')!
const names = (el: HTMLElement) => [...preview(el).querySelectorAll('.mail-tag[data-tag-key]')].map(t => t.textContent)
const filter = (selected: string[]) => ({ selected, choices: ['build', 'alpha', 'Review', 'release'], onChange: () => {} })

test('an active filter leads the three-tag preview followed by other stored tags', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha', 'Review'])]} tagFilter={filter([' REVIEW '])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review', 'build', 'alpha'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more'), null)
})

test('project rows show matching filters first and fill the preview without mutating mail order', async t => {
  const tags = ['build', 'alpha', 'Review', 'release']
  const v = await mountView(<MailList projectMail delivered={[row(tags)]} tagFilter={filter(['Review', 'alpha'])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review', 'alpha', 'build'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.textContent, '(+1)')
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.getAttribute('title'), 'release')
  assert.equal(preview(v.el).getAttribute('title'), 'build, alpha, Review, release', 'full labels remain available on hover')
  assert.deepEqual(tags, ['build', 'alpha', 'Review', 'release'], 'display ordering never mutates the mail')
})

test('without an active filter three tags stay in stored order without overflow', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha', 'Review'])]}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['build', 'alpha', 'Review'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more'), null)
})

test('two tags follow active filter priority without overflow', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha'])]} tagFilter={filter(['alpha'])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['alpha', 'build'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more') === null, true)
})

test('when every tag is filtered for, every tag is visible and no overflow pill remains', async t => {
  const v = await mountView(<MailList delivered={[row(['build', 'alpha', 'Review'])]} tagFilter={filter(['Review', 'build', 'alpha'])}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review', 'build', 'alpha'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more') === null, true)
})

test('mail previews cap stored tags at three across the zero-to-eight boundary', async t => {
  const v = await mountView(<MailList delivered={[]}/>, el => el)
  t.after(() => v.unmount())
  const all = ['build', 'alpha', 'Review', 'release', 'engine', 'ready', 'docs', 'test']
  for (let total = 0; total <= all.length; total++) {
    const tags = all.slice(0, total)
    await v.render(<MailList delivered={[row(tags)]}/>)
    assert.deepEqual(names(v.el), tags.slice(0, 3), `visible tags for total=${total}`)
    const more = preview(v.el).querySelector('.mail-tag-more')
    assert.equal(more?.textContent ?? null, total > 3 ? `(+${total - 3})` : null)
    assert.equal(more?.getAttribute('title') ?? null, total > 3 ? tags.slice(3).join(', ') : null)
  }
})

test('more than three matching filters are capped and normalized duplicates do not inflate the count', async t => {
  const v = await mountView(<MailRowView m={row(['build', 'alpha', 'Review', 'release'])}
    view={null} selected={false} party="lead" onClick={() => {}}
    filterTags={['Review', ' REVIEW ', 'release', 'alpha', 'build']}/>, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(names(v.el), ['Review', 'release', 'alpha'])
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.textContent, '(+1)')
  assert.equal(preview(v.el).querySelector('.mail-tag-more')?.getAttribute('title'), 'build')
})

test('the open message and active filter bar retain every tag', async t => {
  const tags = ['build', 'alpha', 'Review', 'release']
  const v = await mountView(<MailList pending={[row(tags)]}
    tagFilter={filter(['Review', 'release', 'alpha', 'build'])} selectOldestUnread/>, el => el)
  t.after(() => v.unmount())
  assert.equal(v.el.querySelectorAll('.mailer-head .mail-tag[data-tag-key]').length, 4)
  assert.equal(v.el.querySelectorAll('.mail-list-controls .mail-tag-active').length, 4)
  assert.equal(v.el.querySelector('.mailer-head .mail-tag-more'), null)
  assert.equal(names(v.el).length, 3)
})
