import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { TransferPanel } from '../src/canvas/transfers'
import { InboxView, OrgInboxModal } from '../src/canvas/mail'
import type { MailTransfer } from '../src/api'

const sample = (state = 'uploading'): MailTransfer => ({ id:'local-fixture', direction:'upload',
  peer:'@net:fixture', message_id:'mail-fixture', state, attempt:1,
  files:[{id:'file-fixture',name:'retained.txt',total:100,confirmed:40,processed:60}] })
const heading = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.mail-transfers .linkish')!

function transport(t: TestContext, rows = [sample()]) {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async input => {
    const url = String(input); requests.push(url)
    return new Response(JSON.stringify(url.includes('/transfers') ? {transfers:rows,next_cursor:null}
      : url.includes('/org_inbox') ? {entries:[],total:0,unread:0}
      : {pending:[],delivered:[],sent:[]}), {headers:{'X-Orgtree-Instance':'transfers-fixture'}})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return requests
}

for (const agent of [undefined, 'user', 'agent-fixture']) {
  test(`Transfers starts collapsed and preserves expansion across polling: ${agent ?? 'org inbox'}`, async t => {
    t.mock.timers.enable({apis:['setTimeout']})
    const rows = [sample()]; const requests = transport(t, rows)
    const v = await mountView(<TransferPanel slug="fixture" agent={agent}/>, el=>el)
    t.after(()=>v.unmount()); await flush()
    assert.equal(heading(v.el).getAttribute('aria-expanded'), 'false')
    assert.match(heading(v.el).textContent!, /Transfers.*1 unfinished/)
    assert.equal(v.el.querySelector('.transfer-list'), null)
    await inAct(()=>heading(v.el).click())
    assert.equal(heading(v.el).getAttribute('aria-expanded'), 'true')
    assert.equal(v.el.querySelectorAll('.transfer-card').length, 1)
    assert.equal(v.el.querySelector('progress')!.value, 40)
    rows[0].files![0].confirmed = 70
    await v.tick(1000, ms=>t.mock.timers.tick(ms)); await flush()
    assert.ok(requests.filter(url=>url.includes('/transfers')).length >= 2)
    assert.equal(heading(v.el).getAttribute('aria-expanded'), 'true')
    assert.equal(v.el.querySelector('progress')!.value, 70)
    await inAct(()=>heading(v.el).click())
    assert.equal(v.el.querySelector('.transfer-list'), null)
    assert.equal(requests.some(url=>url.includes('/local-fixture')), false, 'disclosure never changes a transfer')
  })
}

test('completed-only Transfers has no count and a reopened view starts collapsed', async t => {
  transport(t, [sample('complete')])
  const v = await mountView(<TransferPanel slug="fixture"/>,el=>el); t.after(()=>v.unmount()); await flush()
  assert.match(heading(v.el).textContent!, /Transfers$/)
  await inAct(()=>heading(v.el).click()); assert.equal(v.el.querySelector('progress')!.value,100)
  await v.render(null); await v.render(<TransferPanel slug="fixture"/>); await flush()
  assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
  assert.equal(v.el.querySelector('.transfer-card'),null)
})

test('a new mailbox scope starts collapsed even if its component is reused', async t => {
  transport(t)
  const v=await mountView(<TransferPanel slug="fixture" agent="first"/>,el=>el);t.after(()=>v.unmount());await flush()
  await inAct(()=>heading(v.el).click())
  await v.render(<TransferPanel slug="fixture" agent="second"/>);await flush()
  assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
  await inAct(()=>heading(v.el).click())
  await v.render(<TransferPanel slug="another-org" agent="second"/>);await flush()
  assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
})

test('org inbox and desk mailbox use the same collapsed one-click disclosure',async t=>{
  transport(t)
  const surfaces=[<OrgInboxModal slug="fixture" map={new Map()} close={()=>{}} toast={()=>{}}
    inbox={{entries:[],total:0,unread:0,visible:true,holders:[]}}/>,
    <InboxView slug="fixture" nid="agent-fixture"/>]
  for(const surface of surfaces){
    const v=await mountView(surface,el=>el);await flush()
    try{
      assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
      assert.equal(v.el.querySelector('.transfer-card'),null)
      await inAct(()=>heading(v.el).click())
      assert.equal(v.el.querySelectorAll('.transfer-card').length,1)
    }finally{await v.unmount()}
  }
})

// ── SYMMETRY #15 (UX audit ux05 S7): transfer history LOADS MORE as you near
// the end, appending, with a manual Load more and a Retry for the failed page
// only - the same states and words as Hubchat's Settings history (integ/hubchat
// 1.2.6, 3f7f273) and the way Orgtree's other long lists grow. No page buttons.

const finished = (id: string): MailTransfer => ({ id, direction:'upload', peer:'@net:fixture', message_id:'mail-'+id,
  state:'complete', attempt:1, files:[{id:'file-'+id,name:id+'.txt',total:10,confirmed:10,processed:10}] })
const PAGES: Record<string, {transfers: MailTransfer[]; next_cursor: string | null}> = {
  '': {transfers:[finished('first-a'),finished('first-b')], next_cursor:'cursor-2'},
  'cursor-2': {transfers:[finished('second-a'),finished('second-b')], next_cursor:'cursor-3'},
  'cursor-3': {transfers:[finished('third-a')], next_cursor:null},
}

/** Paged fixture transport; `failOnce` makes that cursor's first request fail. */
function pagedTransport(t: TestContext, failOnce?: string) {
  const original = globalThis.fetch
  const cursors: string[] = []
  let failed = false
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://fixture')
    const headers = {'X-Orgtree-Instance':'transfers-fixture','Content-Type':'application/json'}
    if (!url.pathname.endsWith('/transfers'))
      return new Response(JSON.stringify({pending:[],delivered:[],sent:[]}), {headers})
    const cursor = url.searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    if (cursor === failOnce && !failed) {
      failed = true
      return new Response(JSON.stringify({error:'hub unavailable'}), {status:503, headers})
    }
    return new Response(JSON.stringify(PAGES[cursor]), {headers})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return cursors
}

/** A controllable IntersectionObserver: `seen()` reports every live watched
 *  element as in view, the way scrolling the list's end into view would.
 *  Installed on globalThis (what the bundled code's bare global reads; the
 *  harness's jsdom `window` is a different object) and on window. */
function observer(t: TestContext) {
  const hosts = [globalThis, window] as unknown as Record<string, unknown>[]
  const saved = hosts.map(host => Object.getOwnPropertyDescriptor(host, 'IntersectionObserver'))
  const live = new Set<{cb: IntersectionObserverCallback; els: Element[]}>()
  const Fake = class {
    rec: {cb: IntersectionObserverCallback; els: Element[]}
    constructor(cb: IntersectionObserverCallback) { this.rec = {cb, els:[]}; live.add(this.rec) }
    observe(el: Element) { this.rec.els.push(el) }
    unobserve() {}
    disconnect() { live.delete(this.rec) }
    takeRecords() { return [] }
  }
  for (const host of hosts) Object.defineProperty(host, 'IntersectionObserver', {configurable:true, writable:true, value:Fake})
  t.after(() => hosts.forEach((host, i) => saved[i]
    ? Object.defineProperty(host, 'IntersectionObserver', saved[i]!)
    : delete host.IntersectionObserver))
  return {
    count: () => live.size,
    seen: async () => {
      for (const rec of [...live]) await inAct(() => rec.cb(rec.els.map(target =>
        ({target, isIntersecting:true, intersectionRatio:1}) as unknown as IntersectionObserverEntry), {} as IntersectionObserver))
      await flush()
    },
  }
}
const cardIds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.transfer-card')].map(c => c.dataset.transferId)
const buttonNamed = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('.mail-transfers button')].find(b => b.textContent?.trim() === text) ?? null
async function openHistory(v: {el: HTMLElement}) {
  await inAct(() => heading(v.el).click())
  await inAct(() => v.el.querySelector<HTMLInputElement>('.mail-transfers input[type="checkbox"]')!.click())
  await flush()
}

test('transfer history loads the next page near the end and appends it, with no page buttons (symmetry #15)', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const cursors = pagedTransport(t), io = observer(t)
  const v = await mountView(<TransferPanel slug="fixture"/>, el=>el); t.after(()=>v.unmount()); await flush()
  await openHistory(v)
  assert.deepEqual(cardIds(v.el), ['first-a','first-b'], 'the first page')
  assert.equal(buttonNamed(v.el, 'More transfers'), null, 'no page-forward button')
  assert.equal(buttonNamed(v.el, 'Previous transfers'), null, 'no page-back button')
  assert.equal(v.el.textContent?.includes('Page 1'), false, 'no page counter')
  assert.ok(buttonNamed(v.el, 'Load more'), 'Load more stays as the manual path')
  assert.ok(io.count() > 0, 'the end of the list is watched')

  await io.seen()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2'], 'nearing the end asks for the next page')
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a','second-b'], 'the next page is appended, not swapped in')

  await io.seen()
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a','second-b','third-a'])
  assert.equal(buttonNamed(v.el, 'Load more'), null, 'nothing left to load: no Load more')
  assert.equal(io.count(), 0, 'nothing left to load: the end is no longer watched')

  // the live poll still refreshes the FIRST page and keeps what was loaded
  const before = cursors.length
  await v.tick(5000, ms=>t.mock.timers.tick(ms)); await flush()
  assert.ok(cursors.slice(before).includes(''), 'polling re-reads the first page')
  assert.ok(!cursors.slice(before).some(Boolean), 'polling never re-reads later pages')
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a','second-b','third-a'], 'loaded pages survive a poll')
})

test('a failed later page shows the error with Retry for that page only, and Load more loads by hand (symmetry #15)', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const cursors = pagedTransport(t, 'cursor-2'), io = observer(t)
  const v = await mountView(<TransferPanel slug="fixture"/>, el=>el); t.after(()=>v.unmount()); await flush()
  await openHistory(v)

  await io.seen()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2'])
  const retry = buttonNamed(v.el, 'Retry')
  assert.ok(retry, 'the failure offers Retry')
  assert.equal(retry.closest('[role="status"],[role="alert"]') !== null, true, 'the error is announced')
  assert.deepEqual(cardIds(v.el), ['first-a','first-b'], 'loaded rows stay put')

  await io.seen()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2'], 'nothing loads by itself while a page error stands')

  const firstPageReads = cursors.filter(c => c === '').length
  await inAct(() => retry.click()); await flush()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2','cursor-2'], 'Retry repeats the failed page')
  assert.equal(cursors.filter(c => c === '').length, firstPageReads, 'Retry does not start over from the first page')
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a','second-b'])
  assert.equal(buttonNamed(v.el, 'Retry'), null, 'the error clears')

  await inAct(() => buttonNamed(v.el, 'Load more')!.click()); await flush()
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a','second-b','third-a'], 'Load more loads the next page by hand')
})
