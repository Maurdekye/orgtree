import { mountView, inAct } from './harness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useWorkItems, useSelectedWork } from '../src/canvas/useworkitems'
import { DocketModal, AgentDocketView } from '../src/canvas/docket'
import { forgetWorkInflight } from '../src/api'
import { WORK_FOREGROUND_FORMAT as format } from '../src/workforeground'
import type { TreePayload, WorkItem, WorkItemsPayload } from '../src/types'

const row = (slug: string, archived = false): WorkItem => ({ slug, title: slug,
  rev: 1, view: 'list', status: archived ? 'done' : 'in_progress', archived,
  owner: { node: 'agent', generation: 1 }, owner_current: true, owner_state: 'live',
  at: '2026-09-27T10:00:00Z', updated_at: '2026-09-27T10:00:00Z',
  parent: null, parent_visible: true, participants: [], questions: [],
  attention_sources: [], effective_attention: false, acceptance: [], dependencies: [],
  delivery: null, manual_attention: null, dismissed: false, kind: 'code',
  done_so_far: [], working_on_next: [], evidence: [], history: [],
} as unknown as WorkItem)
const body = (archived = false): WorkItemsPayload => ({ format, revision: 'one',
  items: [row('active')], references: [row('active'), ...(archived ? [row('old-ticket', true)] : [])],
  ...(archived ? { archived: [row('old-ticket', true)], catalog: [1], next_cursor: null } : {}),
  counts: { active: 1, archived: 1, backlogged: 0, attention: 0 }, now: '' })
const reply = (body: unknown, status = 200) => ({ status, ok: status === 200,
  headers: new Headers(), json: async () => body }) as Response
const deferred = () => {
  let resolve!: (r: Response) => void
  const promise = new Promise<Response>(r => { resolve = r })
  return { promise, resolve }
}

test('close releases archive rows and references on failure and rejects late open completion', async t => {
  forgetWorkInflight()
  const first = deferred(), late = deferred()
  let opens = 0
  globalThis.fetch = async url => String(url).includes('archive_limit=100')
    ? (++opens === 1 ? first.promise : late.promise) : reply(body())
  let result: ReturnType<typeof useWorkItems>
  function Probe({ open, bump = 0 }: { open: boolean; bump?: number }) {
    result = useWorkItems('org', open, false, 60000, bump)
    return <div>{result.value?.archived?.length ?? 0}</div>
  }
  const view = await mountView(<Probe open={false} />, el => el)
  t.after(() => view.unmount())
  await view.render(<Probe open />)
  assert.equal(result!.value?.items.length, 1, 'foreground stays visible during archive load')
  await inAct(() => first.resolve(reply(body(true))))
  assert.equal(result!.value?.archived?.length, 1)
  await view.render(<Probe open bump={1} />)
  globalThis.fetch = async () => { throw new Error('offline') }
  await view.render(<Probe open={false} bump={1} />)
  assert.equal(result!.value?.archived, undefined)
  assert.deepEqual(result!.value?.references?.map(r => r.slug), ['active'])
  assert.equal(result!.status.failed, true)
  await inAct(() => late.resolve(reply(body(true))))
  assert.equal(result!.value?.archived, undefined, 'late page chain cannot repopulate closed archive')
})

test('org switch clears rows synchronously and rejects old org completion', async t => {
  forgetWorkInflight()
  const first = deferred(), second = deferred()
  globalThis.fetch = url => String(url).includes('/first/') ? first.promise : second.promise
  let result: ReturnType<typeof useWorkItems>
  function Probe({ org }: { org: string }) {
    result = useWorkItems(org)
    return <div>{result.value?.items.map(r => r.slug).join(',')}</div>
  }
  const view = await mountView(<Probe org="first" />, el => el)
  t.after(() => view.unmount())
  await view.render(<Probe org="second" />)
  await inAct(() => first.resolve(reply(body())))
  assert.equal(result!.value, null)
  await inAct(() => second.resolve(reply({ ...body(), items: [row('second-only')] })))
  assert.equal(view.el.textContent, 'second-only')
})

test('selection retention holds only one disabled-group row and never crosses org or agent', async t => {
  let selected: WorkItem | undefined
  function Probe({ scope = 'org:agent', id = 'old-ticket', item, open = false }:
    { scope?: string; id?: string; item?: WorkItem; open?: boolean }) {
    selected = useSelectedWork(scope, id, item, open, false)
    return <div>{selected?.slug}</div>
  }
  const view = await mountView(<Probe item={row('old-ticket', true)} open />, el => el)
  t.after(() => view.unmount())
  await view.render(<Probe />)
  assert.equal(selected?.slug, 'old-ticket')
  await view.render(<Probe scope="org:another-agent" />)
  assert.equal(selected, undefined)
  await view.render(<Probe item={row('active')} id="active" />)
  await view.render(<Probe id="active" />)
  assert.equal(selected, undefined, 'disappearing active row is not retained')
})

const tree = { slug: 'org', name: 'org', roots: [], tiers: {}, asks: [] } as unknown as TreePayload
function setup() {
  forgetWorkInflight()
  localStorage.clear()
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.pathname + url.search)
    if (url.pathname.endsWith('work-items-foreground')) return reply(body(url.searchParams.get('archive_limit') === '100'))
    if (url.pathname.endsWith('work-item-references')) return reply({ references:
      (url.searchParams.get('names') ?? '').split(',').filter(n => n === 'old-ticket')
        .map(n => row(n, true)) })
    if (url.pathname.includes('/work-items/')) {
      const id = url.pathname.split('/').pop()!
      const { view: _view, ...item } = row(id, id === 'old-ticket')
      return reply({ item: { ...item, objective: 'Description', reply_recipients: [{ node: 'agent', state: 'live', role: 'owner' }] } })
    }
    return reply({})
  }
  return calls
}
const modal = (org = 'org', jumpTo?: string) => <DocketModal slug={org} tree={tree}
  toast={() => {}} close={() => {}} jumpTo={jumpTo} />
const archiveBox = (el: HTMLElement) => el.querySelector('.docket-showarchived input') as HTMLInputElement
async function draft(el: HTMLElement) {
  const textarea = el.querySelector('.mailer-read textarea') as HTMLTextAreaElement
  assert.ok(textarea, 'hydrated detail has a reply composer')
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'keep this draft')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return textarea
}

test('main docket keeps selected archive detail and draft mounted after close with no other rows', async t => {
  setup()
  const view = await mountView(modal(), el => el)
  t.after(() => view.unmount())
  await inAct(() => archiveBox(view.el).click())
  const rows = [...view.el.querySelectorAll('.docket-row')]
  const old = rows.find(el => el.textContent?.includes('old-ticket')) as HTMLElement
  assert.ok(old)
  await inAct(() => old.click())
  const textarea = await draft(view.el)
  await inAct(() => archiveBox(view.el).click())
  assert.equal(view.el.querySelector('.mailer-read textarea'), textarea, 'same mounted composer')
  assert.equal(textarea.value, 'keep this draft')
  assert.equal(view.el.querySelectorAll('.docket-row').length, 1)
  await view.render(modal('other'))
  assert.equal(view.el.querySelector('.mailer-read textarea'), null, 'selection cannot cross orgs')
})

test('agent docket keeps selected archive draft when its filtered rows become empty', async t => {
  setup()
  const props = { slug: 'org', nid: 'agent', facts: new Map(), toast: () => {},
    refs: { world: { org: 'org' }, onOpen: () => {} } }
  const render = (open: boolean) => <AgentDocketView {...props} showArchived={open}
    mine={open ? [row('old-ticket', true)] : []} boundedReferences />
  const view = await mountView(render(true), el => el)
  t.after(() => view.unmount())
  await inAct(() => (view.el.querySelector('.docket-row') as HTMLElement).click())
  const textarea = await draft(view.el)
  await view.render(render(false))
  assert.equal(view.el.querySelector('.mailer-read textarea'), textarea)
  assert.equal(textarea.value, 'keep this draft')
})

test('unknown historical jump uses exact lookup and opens archive; stale navigation cannot override a row click', async t => {
  const calls = setup()
  const view = await mountView(modal('org', 'old-ticket'), el => el)
  t.after(() => view.unmount())
  assert.ok(calls.some(c => c.includes('work-item-references?names=old-ticket')))
  assert.equal(archiveBox(view.el).checked, true)
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /old-ticket/)
  const wait = deferred()
  const original = globalThis.fetch
  globalThis.fetch = url => String(url).includes('names=slow-ticket') ? wait.promise : original(url)
  await view.render(modal('org', 'slow-ticket'))
  await inAct(() => (view.el.querySelector('.docket-row') as HTMLElement).click())
  await inAct(() => wait.resolve(reply({ references: [row('slow-ticket', true)] })))
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /active/)
  assert.doesNotMatch(view.el.querySelector('.mailer-read')?.textContent ?? '', /slow-ticket/)
})
