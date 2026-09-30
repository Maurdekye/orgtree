import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DocGalleryModal } from '../src/canvas/gallery'

const noop = () => {}
const docs = [
  {id:'retired',node:'retired-agent',title:'Hidden retired document',at:'2026-09-30T13:00:00Z',node_state:'archived',evicted:false},
  {id:'new',node:'alice',title:'Newest visible document',at:'2026-09-30T12:00:00Z',node_state:'live',evicted:false},
  {id:'old',node:'alice',title:'Older document',at:'2026-09-29T12:00:00Z',node_state:'live',evicted:false},
]

test('fresh gallery opens newest visible content, preserves choices on refresh, and resets on reopen', async t => {
  useFakeClock()
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async url => {
    const path = String(url); calls.push(path)
    const doc = docs.find(d => path.endsWith(`/documents/${d.id}`))
    return {ok:true,status:200,headers:new Headers(),json:async()=> doc ? {...doc,body:`body of ${doc.id}`} : {documents:docs}} as Response
  }) as typeof fetch
  const panel = <DocGalleryModal slug="opening-org" toast={noop} close={noop} />
  const view = await mountView(panel, el => el)
  t.after(async()=>{await view.unmount();globalThis.fetch=original;realClock()})
  await flush()
  assert.match(view.el.querySelector('.mailrow.on')?.textContent ?? '', /Newest visible/)
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /body of new/)
  assert.equal(calls.filter(p => /\/documents\?/.test(p)).length, 1, 'reuse the first list request')
  assert.equal(calls.filter(p => /\/documents\/[^/?]+$/.test(p)).length, 1, 'fetch only the selected body')
  const older = [...view.el.querySelectorAll('.mailrow')].find(r => /Older document/.test(r.textContent ?? ''))!
  await inAct(()=> (older as HTMLElement).click())
  await flush()
  await advance(5001)
  await flush()
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /body of old/, 'polling preserves manual selection')
  await view.render(null)
  await view.render(panel)
  await flush()
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /body of new/, 'each fresh open resets to newest')
})

test('explicit gallery jump selects its document and survives clearing the handled jump', async t => {
  const original = globalThis.fetch
  globalThis.fetch = (async url => {
    const path = String(url), doc = docs.find(d => path.endsWith(`/documents/${d.id}`))
    return {ok:true,status:200,headers:new Headers(),json:async()=>doc ? {...doc,body:`body of ${doc.id}`} : {documents:docs,located:'old'}} as Response
  }) as typeof fetch
  const view = await mountView(<DocGalleryModal slug="jump-org" toast={noop} close={noop} jumpTo={{id:'old',seq:1}} />, el=>el)
  t.after(async()=>{await view.unmount();globalThis.fetch=original})
  await flush()
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /body of old/)
  await view.render(<DocGalleryModal slug="jump-org" toast={noop} close={noop} />)
  await flush()
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '', /body of old/)
})
