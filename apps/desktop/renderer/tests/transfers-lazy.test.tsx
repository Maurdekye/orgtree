// transfers-lazy.test.tsx — the transfers tab fills the whole tab and loads
// its history as you scroll, with no Load more (USER 2026-11-25 13:01:34Z
// m97f5f119dea3 "the transfers content should be restructured to fill the
// full tab rather than being this limited scroll, and it should, like
// everything else, load lazily as you scroll and not have a load more
// button"; docket mailboxes-transfers-becomes-its-own-tab-in-every).
//
// The rule is the inbox's (MailList `.mailer-list` onScroll): within 240 px of
// the end, the next part loads. One component (TransferPanel tab mode) serves
// every mailbox's transfers tab.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs transfers-lazy

import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { TransferPanel } from '../src/canvas/transfers'
import type { MailTransfer } from '../src/api'

const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
/** the declarations of the rule whose selector list is exactly `sel` (the last one wins, as in CSS) */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const all = [...css.matchAll(new RegExp(`(?:^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))]
  return all.map(m => m[1]!).join(';')
}

const finished = (id: string): MailTransfer => ({ id, direction:'upload', peer:'@net:fixture', message_id:'mail-'+id,
  state:'complete', attempt:1, files:[{id:'file-'+id,name:id+'.txt',total:10,confirmed:10,processed:10}] })
const PAGES: Record<string, {transfers: MailTransfer[]; next_cursor: string | null}> = {
  '': {transfers:[finished('first-a'),finished('first-b')], next_cursor:'cursor-2'},
  'cursor-2': {transfers:[finished('second-a')], next_cursor:null},
}
function pagedTransport(t: TestContext) {
  const original = globalThis.fetch
  const cursors: string[] = []
  globalThis.fetch = (async input => {
    const url = new URL(String(input), 'http://fixture')
    const headers = {'X-Orgtree-Instance':'transfers-fixture','Content-Type':'application/json'}
    if (!url.pathname.endsWith('/transfers')) return new Response(JSON.stringify({pending:[],delivered:[],sent:[]}), {headers})
    const cursor = url.searchParams.get('cursor') ?? ''
    cursors.push(cursor)
    return new Response(JSON.stringify(PAGES[cursor]), {headers})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return cursors
}
const cardIds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.transfer-card')].map(c => c.dataset.transferId)
/** lays the scroller out as a real tab would: a 600 px view over `height` px of rows, scrolled to `top` */
function layout(el: HTMLElement, height: number, top: number) {
  Object.defineProperty(el, 'clientHeight', {configurable:true, get: () => 600})
  Object.defineProperty(el, 'scrollHeight', {configurable:true, get: () => height})
  el.scrollTop = top
}

test('the tab is the scroll area: no inner fixed-height box, no card around the list', () => {
  const list = rule('.mail-transfers.tab .transfer-list')
  assert.match(list, /max-height:\s*none/, 'the tab\u2019s list has no height cap')
  assert.match(list, /overflow(-y)?:\s*visible/, 'and no scroll box of its own')
  const section = rule('.mail-transfers.tab')
  assert.match(section, /overflow-y:\s*auto/, 'the tab body scrolls')
  assert.match(section, /flex:\s*1 1 auto/, 'and takes the whole height')
  assert.match(section, /min-height:\s*0/)
  assert.match(section, /border:\s*0/, 'no card border, as inbox and sent')
  const pane = rule('.mail-transfers-pane')
  assert.match(pane, /display:\s*flex/, 'the pane hands its height to the panel')
  assert.match(pane, /flex-direction:\s*column/)
})

test('the transfers tab has no Load more and no "N transfers" line; the next page arrives as you scroll near the end', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const cursors = pagedTransport(t)
  const v = await mountView(<TransferPanel slug="fixture" tab={{visible:true}}/>, el=>el); t.after(()=>v.unmount()); await flush()
  await inAct(() => v.el.querySelector<HTMLInputElement>('.mail-transfers input[type="checkbox"]')!.click()); await flush()
  assert.deepEqual(cardIds(v.el), ['first-a','first-b'], 'the first page')
  const buttons = [...v.el.querySelectorAll('button')].map(b => b.textContent?.trim())
  assert.equal(buttons.includes('Load more'), false, 'no Load more button')
  assert.equal(/\d+ transfers\./.test(v.el.textContent ?? ''), false, 'no "N transfers." summary line (inbox and sent have none)')

  const scroller = v.el.querySelector<HTMLElement>('.mail-transfers.tab')!
  assert.ok(scroller, 'the tab\u2019s own section is the scroller')
  // far from the end: nothing loads
  layout(scroller, 3000, 0)
  await inAct(() => { scroller.dispatchEvent(new window.Event('scroll')) }); await flush()
  assert.deepEqual(cursors.filter(Boolean), [], 'a scroll far from the end loads nothing')
  // within 240 px of the end (the inbox's rule): the next page, appended
  layout(scroller, 3000, 3000 - 600 - 100)
  await inAct(() => { scroller.dispatchEvent(new window.Event('scroll')) }); await flush()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2'], 'nearing the end asks for the next page')
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a'], 'appended under the first')
  await inAct(() => { scroller.dispatchEvent(new window.Event('scroll')) }); await flush()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2'], 'the end of the history asks for nothing more')
})

test('a first page shorter than the tab loads on until the end is out of reach (no scroll possible)', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const cursors = pagedTransport(t)
  const v = await mountView(<TransferPanel slug="fixture" tab={{visible:true}}/>, el=>el); t.after(()=>v.unmount()); await flush()
  const scroller = v.el.querySelector<HTMLElement>('.mail-transfers.tab')!
  layout(scroller, 400, 0)
  await inAct(() => v.el.querySelector<HTMLInputElement>('.mail-transfers input[type="checkbox"]')!.click()); await flush(); await flush()
  assert.deepEqual(cursors.filter(Boolean), ['cursor-2'], 'a page that does not fill the tab reads the next one')
  assert.deepEqual(cardIds(v.el), ['first-a','first-b','second-a'])
})

test('a hidden transfers tab never pages (it has no height)', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  const cursors = pagedTransport(t)
  const v = await mountView(<TransferPanel slug="fixture" tab={{visible:false}}/>, el=>el); t.after(()=>v.unmount()); await flush()
  await inAct(() => v.el.querySelector<HTMLInputElement>('.mail-transfers input[type="checkbox"]')!.click()); await flush(); await flush()
  assert.deepEqual(cursors.filter(Boolean), [], 'nothing beyond the live first page'
)
})
