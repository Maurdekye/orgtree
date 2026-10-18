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

async function mountInbox(t: TestContext, inbox: Inbox, slug = 'restore-test', tagChoices: string[] = []) {
  const oldFetch = globalThis.fetch
  globalThis.fetch = withoutMailTransfers((async (url: string) => {
    const path = String(url)
    const body = path.includes('/inbox') && path.includes('tags_only=true')
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
  const scrolled: HTMLElement[] = []
  W.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this) }
  t.after(() => { W.HTMLElement.prototype.scrollIntoView = oldScroll })
  const inbox = { pending: [], delivered: [mail('m1', '2026-10-17T10:00:00Z')], sent: [] }
  const first = await mountInbox(t, inbox, 'restore-same')
  await openRow(first.view, 0)
  assert.match(pane(first.view), /body-m1/, 'the control opened the selected message')
  await first.dispose()

  const reopened = await mountInbox(t, inbox, 'restore-same')
  assert.match(pane(reopened.view), /body-m1/,
    'reopening the inbox with the same arrival set should restore the last opened mail')
  assert.ok(scrolled.some(row => row.classList.contains('mailrow')),
    'restoring a mail also scrolls its row into view')
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
  await inAct(() => option('Review')!.click())
  assert.deepEqual(JSON.parse(W.localStorage.getItem(key) ?? 'null'), ['Alpha', 'Review'],
    'selection is persisted as soon as it changes')
  await first.dispose()

  const reopened = await mountInbox(t, inbox, slug, ['Alpha', 'Review'])
  const restored = reopened.view.el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
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
