import { flush, inAct, mountView, StrictMode } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AskCard } from '../src/canvas/asks'
import type { AskInfo, AskQuestion, AskTab } from '../src/types'

const first: AskQuestion = { question: 'Choose transport', header: 'Transport', multi: true,
  options: [{label:'Train',description:'Rail'}, {label:'Bus'}] }
const second: AskQuestion = { question: 'Explain timing', header: 'Timing' }
const third: AskQuestion = { question: 'Any notes?', header: 'Notes' }
const base = (modern: boolean, qs: AskQuestion[] = [first, second], rev=1): AskInfo => ({
  id:'q-original', node:'alpha', at:'2026-09-07T00:00:00Z', status:'open',
  kind:modern?'batch':'question', rev, revs:{ask:rev},
  ...(modern?{tabs:qs.map(q=>({kind:'question',...q}))}:{questions:qs}) })
const card = (a:AskInfo, slug='mine') => <StrictMode><AskCard ask={a} slug={slug} toast={()=>{}}/></StrictMode>
const input = (el:HTMLElement) => el.querySelector('.ask-other') as HTMLInputElement | null
async function click(el:HTMLElement, selector:string, label?:string) {
  const b=Array.from(el.querySelectorAll<HTMLButtonElement>(selector)).find(b=>label==null||b.textContent?.trim()===label)
  assert.ok(b,selector+' '+label)
  await inAct(()=>b.click())
}
async function type(el:HTMLElement,text:string) {
  const field=input(el);assert.ok(field)
  await inAct(()=>{
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(field,text)
    field.dispatchEvent(new Event('input',{bubbles:true}))
  })
}
const picks=(el:HTMLElement)=>Array.from(el.querySelectorAll('.ask-row.on .ask-row-body b')).map(e=>e.textContent)

for(const modern of [true,false]) {
  const kind=modern?'composed':'legacy'
  test(kind+' preserves all unchanged text and choices on append/rerender; submit uses latest revision',async t=>{
    const saved=globalThis.fetch;const sent:unknown[]=[]
    globalThis.fetch=(async(_,init)=>{sent.push(JSON.parse(String(init?.body)));return new Response('{}',{status:200})}) as typeof fetch
    const view=await mountView(card(base(modern)),e=>e)
    t.after(async()=>{await view.unmount();globalThis.fetch=saved})
    await click(view.el,'.ask-row','TrainRail');await click(view.el,'.ask-row','Other');await type(view.el,'Also walk')
    await click(view.el,'.ask-tabbtn','Timing');await type(view.el,'After lunch')
    await view.render(card(base(modern,[first,second,third],2)))
    assert.equal(view.el.querySelector('.ask-tabbtn.on')?.textContent,'Timing','active question stays put')
    assert.equal(input(view.el)?.value,'After lunch')
    await view.render(card(JSON.parse(JSON.stringify(base(modern,[first,second,third],3)))) )
    assert.equal(input(view.el)?.value,'After lunch','equal contents despite new revision/object')
    await click(view.el,'.ask-tabbtn','Transport')
    assert.deepEqual(picks(view.el),['Train','Other']);assert.equal(input(view.el)?.value,'Also walk')
    await click(view.el,'.ask-tabbtn','Notes');assert.equal(input(view.el)?.value,'')
    await type(view.el,'No luggage');await click(view.el,'.ask-submit');await flush()
    assert.deepEqual(sent, [modern?{revs:{ask:3},answers:[['Train','Also walk'],'After lunch','No luggage']}
      :{rev:3,selected:[['Train','Also walk'],'After lunch','No luggage']}])
  })

  for(const change of ['question','options','description','header','multi','work_item'] as const) {
    test(kind+' resets only question changed in '+change,async t=>{
      const view=await mountView(card(base(modern)),e=>e);t.after(()=>view.unmount())
      await click(view.el,'.ask-row','Other');await type(view.el,'Old choice')
      await click(view.el,'.ask-tabbtn','Timing');await type(view.el,'Keep me')
      const changed={...first,...(change==='question'?{question:'Different prompt'}
        :change==='options'?{options:[{label:'Boat'}]}
        :change==='description'?{options:[{label:'Train',description:'Different terms'},{label:'Bus'}]}
        :change==='header'?{header:'Changed'}:change==='multi'?{multi:false}:{work_item:'different-ticket'})}
      await view.render(card(base(modern,[changed,second],2)))
      assert.equal(input(view.el)?.value,'Keep me','unchanged neighbor remains')
      await click(view.el,'.ask-tabbtn',changed.header)
      assert.deepEqual(picks(view.el),[],'changed definition has no inherited choice')
      assert.equal(input(view.el),null,'changed definition has no inherited Other text')
    })
  }

  test(kind+' follows unchanged questions through reorder, forgets removal, and isolates request/org/node identity',async t=>{
    const view=await mountView(card(base(modern)),e=>e);t.after(()=>view.unmount())
    await click(view.el,'.ask-tabbtn','Timing');await type(view.el,'Original draft')
    await view.render(card(base(modern,[second,first],2)))
    assert.equal(input(view.el)?.value,'Original draft');assert.equal(view.el.querySelector('.ask-tabbtn.on')?.textContent,'Timing')
    await view.render(card(base(modern,[first],3)))
    await view.render(card(base(modern,[first,second],4)))
    await click(view.el,'.ask-tabbtn','Timing');assert.equal(input(view.el)?.value,'','removed draft does not resurrect')
    for(const [next,slug] of [[{...base(modern),id:'replacement'},'mine'],[{...base(modern),id:'replacement'},'other-org'],[{...base(modern),id:'replacement',node:'beta'},'other-org']] as const){
      await type(view.el,'Must not cross');await view.render(card(next,slug))
      await click(view.el,'.ask-tabbtn','Timing');assert.equal(input(view.el)?.value,'')
    }
  })
}

test('mixed batch addition preserves question, credit and scope decisions by their own request identities',async t=>{
  const credit:AskTab={kind:'credits',id:'c1',old:1,new:3,reason:'More work'}
  const scope:AskTab={kind:'scope',id:'s1',item:{kind:'tool',tool:'web'},label:'Web',reason:'Research'}
  const make=(rev:number,questions=[second],cr=credit):AskInfo=>({...base(true,questions,rev),revs:{ask:rev,credits:1,scope:1},
    tabs:[...questions.map(q=>({kind:'question' as const,...q})),cr,scope]})
  const view=await mountView(card(make(1)),e=>e);t.after(()=>view.unmount())
  await type(view.el,'Question draft');await click(view.el,'.ask-tabbtn','credits');await click(view.el,'.ask-row','deny')
  await click(view.el,'.ask-row','approve — live from its next turn')
  await view.render(card(make(2,[second,third])))
  await click(view.el,'.ask-tabbtn','Timing');assert.equal(input(view.el)?.value,'Question draft')
  await click(view.el,'.ask-tabbtn','credits');assert.deepEqual(picks(view.el),['deny'])
  await click(view.el,'.ask-tabbtn','tool: web');assert.deepEqual(picks(view.el),['approve — live from its next turn'])
  await view.render(card(make(3,[second,third],{...credit,new:5})))
  await click(view.el,'.ask-tabbtn','credits');assert.deepEqual(picks(view.el),[],'changed request resets only its decision')
  await click(view.el,'.ask-tabbtn','Timing');assert.equal(input(view.el)?.value,'Question draft')
})


test('adding credit and scope requests does not reset the question draft',async t=>{
  const view=await mountView(card(base(true,[second])),e=>e);t.after(()=>view.unmount())
  await type(view.el,'Still composing')
  await view.render(card({...base(true,[second]),revs:{ask:1,credits:1,scope:1},tabs:[
    {kind:'question',...second},
    {kind:'credits',id:'new-credit',old:1,new:4,reason:'Capacity'},
    {kind:'scope',id:'new-scope',item:{kind:'tool',tool:'web'},label:'Web',reason:'Research'},
  ]}))
  assert.equal(input(view.el)?.value,'Still composing')
  assert.equal(view.el.querySelectorAll('.ask-tabbtn.done').length,1,'new decisions start empty')
})
