import { flush,inAct,mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MailReplyPreview } from '../src/canvas/mailreply'
import { ReplyPreview,ReplySourceProvider } from '../src/canvas/replypreview'
import type { RefWorld,ResolvedRef } from '../src/canvas/reflinks'

const org='synthetic'
const doc=(id:string)=>({id,kind:'document',from:'writer',at:'',gist:'Retained quoted context'})
const world:RefWorld={org,handles:new Set(['doc','mail','item'])}
const fullTitle='Project slots: UI/UX mockups and a deliberately long presentation title for narrow reply quotes'
const source={org,agent:'writer',generation:1,eventId:'event',quote:'Quoted source text'}
const readyWorld={...world,docs:new Map([['doc-one',fullTitle],['doc-two','Other presentation']])}

test('legacy presentation quotes resolve the exact title without exposing their id',async()=>{
  const previous=globalThis.fetch,reads:string[]=[]
  globalThis.fetch=(async input=>{reads.push(String(input));return new Response(JSON.stringify({id:'doc-one',node:'writer',title:fullTitle,body:'Body',at:''}),{headers:{'Content-Type':'application/json'}})}) as typeof fetch
  const view=await mountView(<MailReplyPreview row={{reply_to:doc('doc-one')}} org={org} world={world} onOpen={()=>{}}/>,el=>el)
  try{
    await inAct(async()=>{await flush(6)})
    const header=view.el.querySelector('.reply-preview-head')!
    assert.match(header.textContent??'',/Project slots: UI\/UX mockups/)
    assert.doesNotMatch(header.textContent??'',/doc-one/)
    assert.ok(reads.some(url=>url.endsWith('/documents/doc-one')))
    assert.match(view.el.querySelector('.reply-presentation-link')?.getAttribute('title')??'',/Project slots: UI\/UX mockups/)
  }finally{await view.unmount();globalThis.fetch=previous}
})

test('multi-reply presentation links keep distinct titles and full-title tooltips',async()=>{
  const opened:ResolvedRef[]=[]
  const view=await mountView(<MailReplyPreview row={{replies:[doc('doc-one'),doc('doc-two')]}} org={org} world={readyWorld} onOpen={r=>opened.push(r)}/>,el=>el)
  try{
    const blocks=[...view.el.querySelectorAll<HTMLElement>('.reply-preview')]
    assert.equal(blocks.length,2)
    for(const [i,title] of [fullTitle,'Other presentation'].entries()){
      const link=blocks[i].querySelector<HTMLButtonElement>('.reply-presentation-link');assert.ok(link)
      assert.equal(link.textContent,title);assert.ok(link.title.includes(title))
      await inAct(()=>link.click())
    }
    assert.deepEqual(opened.map(r=>r.ref.id),['doc-one','doc-two'])
  }finally{await view.unmount()}
})

test('missing and unreadable presentation quotes show a plain fallback without raw ids',async()=>{
  const previous=globalThis.fetch
  globalThis.fetch=(async()=>new Response(JSON.stringify({error:'Not readable'}),{status:404,headers:{'Content-Type':'application/json'}})) as typeof fetch
  const view=await mountView(<MailReplyPreview row={{reply_to:doc('missing-doc')}} org={org} world={{...world,docs:new Map()}} onOpen={()=>assert.fail('missing presentation opened')}/>,el=>el)
  try{
    assert.match(view.el.textContent??'',/presentation (removed|unavailable)/i)
    assert.doesNotMatch(view.el.querySelector('.reply-preview-head')?.textContent??'',/missing-doc/)
    await view.render(<MailReplyPreview row={{reply_to:doc('unreadable-doc')}} org={org} world={world} onOpen={()=>assert.fail('unreadable presentation opened')}/>)
    await inAct(async()=>{await flush(6)})
    assert.match(view.el.textContent??'',/presentation (removed|unavailable)/i)
    assert.doesNotMatch(view.el.querySelector('.reply-preview-head')?.textContent??'',/unreadable-doc/)
  }finally{await view.unmount();globalThis.fetch=previous}
})

test('the whole object quote opens its canonical target with click, Enter and Space',async()=>{
  const opened:ResolvedRef[]=[]
  const view=await mountView(<MailReplyPreview row={{reply_to:doc('doc-one')}} org={org} world={readyWorld} onOpen={r=>opened.push(r)}/>,el=>el)
  try{
    for(const reply of [doc('doc-one'),{id:'fix-quote',kind:'work_item',from:'writer',at:'',gist:'Item context'},
      {id:'mail-one',kind:'mail',org,box:'node',node:'writer',from:'writer',at:'',gist:'Mail context'}]){
      await view.render(<MailReplyPreview row={{reply_to:reply}} org={org} world={readyWorld} onOpen={r=>opened.push(r)}/>)
      const block=view.el.querySelector<HTMLElement>('.reply-preview')!
      assert.equal(block.tabIndex,0);assert.ok(block.title.length>0)
      await inAct(()=>block.querySelector<HTMLElement>('blockquote')!.click())
      for(const key of ['Enter',' '])await inAct(()=>block.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})))
      assert.deepEqual(opened.slice(-3).map(r=>r.ref.id),[reply.id,reply.id,reply.id])
    }
  }finally{await view.unmount()}
})

test('the full chat quote is focusable and activates its locate callback',async()=>{
  let located=0
  const view=await mountView(<ReplyPreview reply={source} available onLocate={()=>located++}/>,el=>el)
  try{
    const block=view.el.querySelector<HTMLElement>('.reply-preview')!
    assert.equal(block.tabIndex,0)
    await inAct(()=>block.querySelector<HTMLElement>('blockquote')!.click())
    await inAct(()=>block.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})))
    assert.equal(located,2)
  }finally{await view.unmount()}
})

test('nested links, jump buttons and remove buttons retain their own actions',async()=>{
  let links=0,located=0,removed=0
  const view=await mountView(<ReplySourceProvider value={()=><a href="#nested" onClick={e=>{e.preventDefault();links++}}>Nested link</a>}>
    <ReplyPreview reply={source} available onLocate={()=>located++} onRemove={()=>removed++}/>
  </ReplySourceProvider>,el=>el)
  try{
    await inAct(()=>view.el.querySelector<HTMLAnchorElement>('a')!.click())
    assert.equal(links,1);assert.equal(located,0)
    await inAct(()=>view.el.querySelector<HTMLButtonElement>('.reply-preview-jump')!.click())
    assert.equal(located,1,'inner jump must not activate twice')
    await inAct(()=>view.el.querySelector<HTMLButtonElement>('[aria-label="Remove reply"]')!.click())
    assert.equal(removed,1);assert.equal(located,1,'remove must not navigate')
  }finally{await view.unmount()}
})

test('foreign presentation ids never resolve against this org or open local targets',async()=>{
  let opened=0
  const view=await mountView(<MailReplyPreview row={{reply_to:{...doc('doc-one'),org:'elsewhere'}}} org={org} world={readyWorld} onOpen={()=>opened++}/>,el=>el)
  try{
    await inAct(()=>view.el.querySelector<HTMLElement>('blockquote')!.click())
    assert.equal(opened,0);assert.doesNotMatch(view.el.textContent??'',/Project slots: UI\/UX mockups/)
  }finally{await view.unmount()}
})
