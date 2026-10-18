import { withoutMailTransfers } from './mailtransfers.fixture'
import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { InboxPanel } from '../src/App'
import { MailList } from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

const W = window as unknown as Window & typeof globalThis
if (!W.HTMLElement.prototype.scrollIntoView) W.HTMLElement.prototype.scrollIntoView = () => {}

const TREE = {
  slug: 'restore-test', name: 'Restore test', tiers: { opus: { name: 'Opus' } },
  roots: [], nodes: [], default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
  default_visibility: 'full',
} as unknown as TreePayload

type Inbox = { pending: unknown[]; delivered: unknown[]; sent: unknown[] }
const mail = (id: string, at: string) => ({
  id, from: 'agent-one', to: '@user', at, kind: 'message', body: `body-${id}`,
})

async function mountInbox(t: TestContext, inbox: Inbox, slug = 'restore-test', tagChoices: string[] = [],
  filterResponse: (tags: string[]) => Promise<Inbox> = async () => inbox) {
  const oldFetch = globalThis.fetch
  globalThis.fetch = withoutMailTransfers((async (url: string, init?: RequestInit) => {
    const path = String(url)
    const body = path.includes('/inbox/filter')
      ? await filterResponse(JSON.parse(String(init?.body ?? '{}')).tags ?? [])
      : path.includes('/inbox') && path.includes('tags_only=true')
      ? { tag_choices: tagChoices }
      : path.includes('/inbox') ? inbox
        : path.includes('/audiences') ? { audiences: [], requests: [] }
          : path.includes('/events') ? { events: [] } : {}
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch)
  const views: { unmount: () => Promise<void> }[] = []
  const view = await mountView(
      <CurrentOrg.Provider value={slug}>
        <InboxPanel slug={slug} tree={TREE} toast={() => {}} close={() => {}} jumpTo={null} />
    </CurrentOrg.Provider>,
    el => el)
  views.push(view)
  t.after(async () => {
    for (const v of views) await v.unmount()
    globalThis.fetch = oldFetch
  })
  await inAct(async () => { await flush(10) })
  return { view, dispose: async () => {
    await view.unmount()
    const i = views.indexOf(view)
    if (i >= 0) views.splice(i, 1)
  } }
}

function openRow(view: { el: HTMLElement }, index: number) {
  const row = view.el.querySelectorAll<HTMLElement>('.mailrow')[index]
  assert.ok(row, `positive control: mail row ${index} rendered`)
  return inAct(async () => {
    row.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush(3)
  })
}

const pane = (view: { el: HTMLElement }) =>
  view.el.querySelector('.mailer-read')?.textContent ?? ''

test('your inbox reopens the last mail when no new inbox mail arrived', async (t) => {
  const oldScroll = W.HTMLElement.prototype.scrollIntoView
  const oldRect=W.HTMLElement.prototype.getBoundingClientRect
  const descriptors=['clientHeight','offsetHeight','scrollHeight'].map(key=>[key,Object.getOwnPropertyDescriptor(W.HTMLElement.prototype,key)] as const)
  W.HTMLElement.prototype.scrollIntoView = function () { throw Error('restoration must not scroll ancestors') }
  const rect=(top:number,height:number)=>({left:0,right:200,top,bottom:top+height,width:200,height,x:0,y:top,toJSON(){}})
  W.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('mailer-list')?rect(100,200):this.classList.contains('mailrow')?rect(500,40):oldRect.call(this)}
  for(const [key,prior] of descriptors)Object.defineProperty(W.HTMLElement.prototype,key,{configurable:true,get(){return this.classList.contains('mailer-list')?(key==='scrollHeight'?1000:200):prior?.get?.call(this)??0}})
  t.after(() => { W.HTMLElement.prototype.scrollIntoView = oldScroll;W.HTMLElement.prototype.getBoundingClientRect=oldRect
    for(const [key,prior] of descriptors){if(prior)Object.defineProperty(W.HTMLElement.prototype,key,prior);else delete (W.HTMLElement.prototype as unknown as Record<string,unknown>)[key]}
  })
  const inbox = { pending: [], delivered: [mail('m1', '2026-10-17T10:00:00Z')], sent: [] }
  const first = await mountInbox(t, inbox, 'restore-same')
  await openRow(first.view, 0)
  assert.match(pane(first.view), /body-m1/, 'the control opened the selected message')
  await first.dispose()

  const reopened = await mountInbox(t, inbox, 'restore-same')
  assert.match(pane(reopened.view), /body-m1/,
    'reopening the inbox with the same arrival set should restore the last opened mail')
  assert.ok((reopened.view.el.querySelector('.mailer-list')?.scrollTop??0)>0,
    'restoring a mail centers its row by scrolling only the mailbox list')
})

test('selected inbox tags survive reopening and stay scoped to their inbox', async (t) => {
  const slug = 'tag-selection-persist'
  const otherSlug = 'tag-selection-other'
  const key = `orgtree-user-mail-tags:${slug}`
  const otherKey = `orgtree-user-mail-tags:${otherSlug}`
  W.localStorage.removeItem(key)
  W.localStorage.removeItem(otherKey)
  t.after(() => { W.localStorage.removeItem(key); W.localStorage.removeItem(otherKey) })
  const inbox = { pending: [], delivered: [mail('tagged-mail', '2026-10-17T10:00:00Z')], sent: [] }

  const first = await mountInbox(t, inbox, slug, ['Alpha', 'Review'])
  const trigger = first.view.el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
  assert.ok(trigger, 'positive control: inbox tag filter is mounted')
  await inAct(() => trigger.click())
  const option = (name: string) => [...first.view.el.ownerDocument.querySelectorAll<HTMLButtonElement>('button.mail-tag-choice')]
    .find(button => button.textContent?.trim() === name)
  await inAct(() => option('Alpha')!.click())
  await inAct(() => trigger.click())
  await inAct(() => option('Review')!.click())
  assert.deepEqual(JSON.parse(W.localStorage.getItem(key) ?? 'null'), ['Alpha', 'Review'],
    'selection is persisted as soon as it changes')
  await first.dispose()

  const reopened = await mountInbox(t, inbox, slug, ['Alpha', 'Review'])
  const restored = reopened.view.el.querySelector<HTMLElement>('.mail-tag-control')
  assert.match(restored?.textContent ?? '', /Alpha/)
  assert.match(restored?.textContent ?? '', /Review/)

  const other = await mountInbox(t, inbox, otherSlug, ['Alpha', 'Review'])
  const independent = other.view.el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
  assert.equal(independent?.textContent?.trim(), 'all tags', 'a different inbox starts with its own selection')
})

test('restoring the last opened mail wins over automatic unread selection', async (t) => {
  const slug = 'restore-unread-priority'
  W.sessionStorage.setItem(`orgtree-user-inbox-arrivals:${slug}`, JSON.stringify(['m2', 'm1']))
  W.sessionStorage.setItem(`orgtree-user-inbox-last-opened:${slug}`, 'm1')
  const inbox = {
    pending: [mail('m2', '2026-10-17T11:00:00Z')],
    delivered: [mail('m1', '2026-10-17T10:00:00Z')],
    sent: [],
  }
  const reopened = await mountInbox(t, inbox, slug)
  assert.match(pane(reopened.view), /body-m1/,
    'automatic unread selection must not overwrite the saved message before restore reads it')
  const selected = reopened.view.el.querySelector<HTMLElement>('.mailrow.on')
  assert.ok(selected?.textContent?.includes('body-m1'), 'the remembered mail row is selected')
})

test('a new inbox arrival prevents restoring the previous selection', async (t) => {
  const previous = { pending: [], delivered: [mail('m1', '2026-10-17T10:00:00Z')], sent: [] }
  const first = await mountInbox(t, previous, 'restore-arrival')
  await openRow(first.view, 0)
  await first.dispose()

  const withNewArrival = {
    pending: [],
    delivered: [mail('m2', '2026-10-17T11:00:00Z'), mail('m1', '2026-10-17T10:00:00Z')],
    sent: [],
  }
  const reopened = await mountInbox(t, withNewArrival, 'restore-arrival')
  assert.equal(reopened.view.el.querySelectorAll('.mailrow.on').length, 0,
    'a new arrival keeps today’s unselected all-read inbox behavior')
  assert.doesNotMatch(pane(reopened.view), /body-m1/)
})

test('a remembered mail that is no longer retained falls back to the default inbox view', async (t) => {
  const previous = {
    pending: [],
    delivered: [mail('m2', '2026-10-17T11:00:00Z'), mail('m1', '2026-10-17T10:00:00Z')],
    sent: [],
  }
  const first = await mountInbox(t, previous, 'restore-missing')
  await openRow(first.view, 1)
  assert.match(pane(first.view), /body-m1/)
  await first.dispose()

  const retainedOnly = { pending: [], delivered: [mail('m2', '2026-10-17T11:00:00Z')], sent: [] }
  const reopened = await mountInbox(t, retainedOnly, 'restore-missing')
  assert.equal(reopened.view.el.querySelectorAll('.mailrow.on').length, 0,
    'a missing remembered message must not be selected')
  assert.doesNotMatch(pane(reopened.view), /body-m1/)
})

test('a remembered mail excluded by the active tag filter is not restored', async (t) => {
  const view = await mountView(
    <MailList delivered={[{ ...mail('filtered', '2026-10-17T10:00:00Z'), tags: ['other'] }]}
      selectOldestUnread restoreSelectionId="filtered"
      tagFilter={{ selected: ['keep'], choices: ['keep'], onChange: () => {}, onSearch: () => {} }} />,
    el => el)
  t.after(async () => { await view.unmount() })
  await inAct(async () => { await flush(5) })
  assert.equal(view.el.querySelectorAll('.mailrow.on').length, 0,
    'restoration must respect the active filter even when the message is retained')
  assert.doesNotMatch(pane(view), /body-filtered/)
})

test('changing selected tags keeps the current list and unread control while results load', async (t) => {
  const slug = 'tag-filter-keeps-rendered-mail'
  const storageKey = `orgtree-user-mail-tags:${slug}`
  W.localStorage.setItem(storageKey, JSON.stringify(['Alpha', 'Review']))
  t.after(() => W.localStorage.removeItem(storageKey))
  const inbox = { pending: [], delivered: [{ ...mail('m1', '2026-10-17T10:00:00Z'), tags: ['Alpha', 'Review'] }], sent: [] }
  const filtered = { ...inbox, hidden_unread: 1, oldest_unread_id: 'hidden' }
  const nextFiltered = { ...inbox, hidden_unread: 0, oldest_unread_id: null }
  let resolveNext!: (value: Inbox) => void
  const mounted = await mountInbox(t, inbox, slug, ['Alpha', 'Review'], tags =>
    tags.length === 1 ? new Promise<Inbox>(resolve => { resolveNext = resolve }) : Promise.resolve(filtered as Inbox))
  const row = mounted.view.el.querySelector<HTMLElement>('.mailrow')
  const controls = mounted.view.el.querySelector<HTMLElement>('.mail-list-controls')
  const hiddenUnread = mounted.view.el.querySelector<HTMLElement>('.mail-hidden-unread')
  assert.ok(row && controls && hiddenUnread, 'positive control: filtered mail and unread control are rendered')
  await openRow(mounted.view, 0)
  assert.match(pane(mounted.view), /body-m1/)

  const removeReview = mounted.view.el.querySelector<HTMLButtonElement>('button[aria-label="Remove Review filter"]')
  assert.ok(removeReview, 'positive control: selected tag has a remove control')
  await inAct(async () => { removeReview.click(); await flush(5) })
  assert.equal(mounted.view.el.querySelector('.mail-list-controls') === controls, true,
    'changing a filter must keep the filter bar mounted')
  assert.equal(mounted.view.el.querySelector('.mailrow') === row, true,
    'the previous result stays visible until the new filtered result is ready')
  assert.equal(mounted.view.el.querySelector('.mail-hidden-unread') === hiddenUnread, true,
    'the unread control does not flash out while the request is pending')
  assert.match(pane(mounted.view), /body-m1/, 'a still-matching open mail remains open')

  await inAct(async () => { resolveNext(nextFiltered as Inbox); await flush(10) })
  assert.equal(mounted.view.el.querySelector('.mail-hidden-unread') === null, true,
    'the unread control updates when the new filtered result arrives')
})

test('tag and text filters close a detail pane when they hide its mail', async (t) => {
  const inbox = { pending: [], delivered: [{ ...mail('m1', '2026-10-17T10:00:00Z'), tags: ['Review'] }], sent: [] }
  const mounted = await mountInbox(t, inbox, 'filter-closes-open-mail', ['Alpha'])
  await openRow(mounted.view, 0)
  assert.match(pane(mounted.view), /body-m1/)

  const trigger = mounted.view.el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
  assert.ok(trigger)
  await inAct(() => trigger.click())
  const alpha = [...mounted.view.el.ownerDocument.querySelectorAll<HTMLButtonElement>('button.mail-tag-choice')]
    .find(button => button.textContent?.trim() === 'Alpha')
  assert.ok(alpha, 'positive control: tag option is rendered')
  await inAct(async () => { alpha.click(); await flush(10) })
  assert.doesNotMatch(pane(mounted.view), /body-m1/, 'a tag filter closes a detail pane for an excluded mail')

  const clearTags = mounted.view.el.querySelector<HTMLButtonElement>('button[aria-label="Clear tag filter"]')
  assert.ok(clearTags)
  await inAct(async () => { clearTags.click(); await flush(8) })
  assert.doesNotMatch(pane(mounted.view), /body-m1/, 'clearing tags does not reopen the closed detail pane')

  await openRow(mounted.view, 0)
  const search = mounted.view.el.querySelector<HTMLInputElement>('input.mail-filter')
  assert.ok(search)
  await inAct(async () => {
    search.value = 'no matching body'
    search.dispatchEvent(new W.Event('input', { bubbles: true }))
    await flush(3)
  })
  assert.doesNotMatch(pane(mounted.view), /body-m1/, 'a text filter closes a detail pane for an excluded mail')
  await inAct(async () => {
    search.value = ''
    search.dispatchEvent(new W.Event('input', { bubbles: true }))
    await flush(3)
  })
  assert.doesNotMatch(pane(mounted.view), /body-m1/, 'clearing text does not reopen the closed detail pane')
})
