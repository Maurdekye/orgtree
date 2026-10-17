import { flush,inAct,mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useMailTagChoices } from '../src/usemailtags'
function Catalog({revision='boot:1',query=''}:{revision?:string;query?:string}){
  const page=useMailTagChoices('fixture',{pending:[],delivered:[],sent:[],mail_revision:revision},query,true)
  return <div data-labels={page.labels.join(',')} data-error={page.error??''}><button onClick={page.loadMore}>more</button></div>
}
const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
test('mail revision refreshes used choices even when visible IDs stay empty; unrelated rerender does not',async()=>{
  const old=globalThis.fetch;let reads=0
  globalThis.fetch=(async()=>response({tag_choices:++reads===1?['Deleted tag','Keep']:['Keep']})) as typeof fetch
  const v=await mountView(<Catalog/>,el=>el)
  try{
    await inAct(async()=>{await flush(5)})
    assert.equal(v.el.querySelector('[data-labels]')?.getAttribute('data-labels'),'Deleted tag,Keep')
    await v.render(<Catalog/>);await inAct(async()=>{await flush(3)})
    assert.equal(reads,1,'an unrelated record render must not refetch tags')
    await v.render(<Catalog revision="boot:2"/>);await inAct(async()=>{await flush(5)})
    assert.equal(reads,2)
    assert.equal(v.el.querySelector('[data-labels]')?.getAttribute('data-labels'),'Keep')
  }finally{await v.unmount();globalThis.fetch=old}
})
test('manual tag search reaches later cursor pages after an empty first page',async()=>{
  const old=globalThis.fetch,urls:string[]=[]
  globalThis.fetch=(async(input:RequestInfo|URL)=>{const url=String(input);urls.push(url)
    return response(url.includes('after=cursor-a')?{tag_choices:['Target'],next_tag_cursor:null}:{tag_choices:[],next_tag_cursor:'cursor-a'})
  }) as typeof fetch
  const v=await mountView(<Catalog query="arg"/>,el=>el)
  try{
    await inAct(async()=>{await flush(8)})
    assert.equal(v.el.querySelector('[data-labels]')?.getAttribute('data-labels'),'Target')
    assert.equal(urls.length,2)
    assert.ok(urls[1]?.includes('after=cursor-a'))
  }finally{await v.unmount();globalThis.fetch=old}
})
test('an obsolete catalog search cannot replace the newer query',async()=>{
  const old=globalThis.fetch;let finish:((r:Response)=>void)|undefined
  globalThis.fetch=(async(input:RequestInfo|URL)=>String(input).includes('prefix=old')
    ?new Promise<Response>(resolve=>{finish=resolve}):response({tag_choices:['New result']})) as typeof fetch
  const v=await mountView(<Catalog query="old"/>,el=>el)
  try{
    assert.ok(finish,'old query is actually pending')
    await v.render(<Catalog query="new"/>);await inAct(async()=>{await flush(5)})
    await inAct(async()=>{finish!(response({tag_choices:['Obsolete']}));await flush(5)})
    assert.equal(v.el.querySelector('[data-labels]')?.getAttribute('data-labels'),'New result')
  }finally{await v.unmount();globalThis.fetch=old}
})
