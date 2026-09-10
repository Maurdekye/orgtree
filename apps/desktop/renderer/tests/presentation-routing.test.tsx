import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DocReader, PresentationCard } from '../src/canvas/docs'
import { Msg } from '../src/canvas/desk'

test('a document link opens its owner collection, selecting an older document outside the first page', async t => {
  const oldFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async url => {
    const path = String(url); calls.push(path)
    const doc = {id:'old',node:'alice',title:'Earlier proposal',body:'Selected proposal body',at:'2026-09-10T00:00:00Z'}
    const body = path.endsWith('/documents/old') ? doc : {documents:[
      {...doc,id:'new',title:'Newest proposal',evicted:false,node_state:'live'},
      {...doc,id:'foreign',node:'bob',title:'Other agent',evicted:false,node_state:'live'},
    ],total:105,next_offset:100}
    return {ok:true,status:200,headers:new Headers(),json:async()=>body} as Response
  }) as typeof fetch
  const view = await mountView(<DocReader slug="org" docId="old" toast={()=>{}} close={()=>{}} />, el=>el)
  t.after(async()=>{await view.unmount();globalThis.fetch=oldFetch})
  await inAct(async()=>{await flush()})
  assert.ok(view.el.querySelector('.gallery-agent'))
  assert.equal(view.el.querySelector('.doc-reader'),null)
  assert.match(view.el.querySelector('.mailrow.on')?.textContent ?? '',/Earlier proposal/)
  assert.match(view.el.querySelector('.mailer-read')?.textContent ?? '',/Selected proposal body/)
  assert.doesNotMatch(view.el.textContent ?? '',/Other agent/)
  assert.ok(calls.some(p=>p.includes('node=alice')))
})

test('successful presentation tools and HTML cards open documents through the same route', async t => {
  const opened: string[] = []
  const refs = {world:{org:'org'},onOpen:(r:any)=>opened.push(r.ref.id)}
  const view = await mountView(<>
    <Msg slug="org" nid="alice" refs={refs} m={{role:'assistant',tools:[{name:'orgtree_present',presentation:{id:'p1',title:'Proposal'}}]}} />
    <Msg slug="org" nid="alice" refs={refs} m={{role:'assistant',tools:[{name:'orgtree_present',error:'refused',presentation:{id:'bad',title:'Failed'}}]}} />
    <PresentationCard slug="org" doc={{id:'html',title:'Mockup',format:'html'}} onOpen={id=>opened.push(id)} className="html-card">Mockup</PresentationCard>
  </>,el=>el)
  t.after(()=>view.unmount())
  assert.equal(view.el.querySelectorAll('.presentation-chat-card').length,1)
  assert.ok(view.el.querySelector('.presentation-chat-card svg'))
  assert.equal(view.el.querySelector('.html-card')?.tagName,'BUTTON')
  await inAct(()=>{(view.el.querySelector('.presentation-chat-card') as HTMLElement).click();(view.el.querySelector('.html-card') as HTMLElement).click()})
  assert.deepEqual(opened,['p1','html'])
})
