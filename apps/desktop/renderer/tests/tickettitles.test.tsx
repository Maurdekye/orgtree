// tests/tickettitles.test.tsx — USER 2026-10-27 m7bb9eb904138: "ticket ajd presentation links should renerr ss
// their full nsme, notmtheir slug" (@item:orgtree/4-5-0-apps-and-specific-panels-can-be-mentioned-t, tickets; the
// presentation half is @rig-opus's). A ticket mention chip shows the item's current full title, read through the
// bounded work-item-references read of the exact slugs on screen and read again on every docket_changed frame. The
// slug stays the chip's token and the ticket menu's Copy slug; whether the item exists stays the docket's to judge.
// Each test uses its own org slug: answers are kept per org.
import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {useMemo} from 'react'
import {RefProse,resolveRef,useRefRoutes} from '../src/canvas/reflinks'
import type {RefWorld} from '../src/canvas/reflinks'
import {RefMdBody} from '../src/canvas/refmd'
import {WorkRefText,buildMentionIndex,parseRef} from '../src/canvas/workrefs'
import {docketFeed} from '../src/canvas/itemrefs'
import {md} from '../src/canvas/shared'

const tick=async()=>{for(let i=0;i<6;i++)await flush()}
type Row={slug:string;title:string;status:string}

function docket(t:test.TestContext,rows:Row[]){
 const reads:string[][]=[],original=globalThis.fetch,state={fail:false}
 globalThis.fetch=async(raw)=>{const url=new URL(String(raw),'http://local')
  if(!/\/work-item-references$/.test(url.pathname))return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}})
  const names=(url.searchParams.get('names')??'').split(',').filter(Boolean);reads.push(names)
  if(state.fail)return new Response(JSON.stringify({error:'docket unavailable'}),{status:503,headers:{'Content-Type':'application/json'}})
  const references=rows.filter(r=>names.includes(r.slug)).map(r=>({...r,parent:null,archived:false,rev:1}))
  return new Response(JSON.stringify({references}),{headers:{'Content-Type':'application/json'}})
 }
 t.after(()=>{globalThis.fetch=original})
 return{rows,reads,state}
}
function Surface({slug,text,markdown}:{slug:string;text:string;markdown?:boolean}){
 const agents=useMemo(()=>new Map<string,unknown>(),[])
 const refs=useRefRoutes(slug,agents,{onOpenItem:()=>{}})
 return markdown?<RefMdBody className="md" html={md(text)} world={refs.world} onOpen={refs.onOpen}/>
  :<p><RefProse text={text} world={refs.world} onOpen={refs.onOpen}/></p>
}
const chips=(el:HTMLElement)=>[...el.querySelectorAll<HTMLElement>('.ref-chip.ref-item.ref-ready')].map(c=>({text:c.textContent,copy:c.getAttribute('data-copy-ticket-title'),live:c.tagName==='BUTTON'}))

test('a ticket chip shows the item\'s current title, read once for the slugs on screen',async t=>{
 const slug='titles-read',d=docket(t,[{slug:'build-the-docs',title:'Build the docs site from main',status:'in_progress'},{slug:'review-docs',title:'Review the docs',status:'review'}])
 const view=await mountView(<Surface slug={slug} text={`Tracked in @item:${slug}/build-the-docs and @item:${slug}/review-docs; see @item:other/build-the-docs.`}/>,el=>el)
 t.after(()=>view.unmount());await inAct(tick)
 assert.deepEqual(chips(view.el),[
  {text:'Build the docs site from main',copy:'Build the docs site from main',live:true},
  {text:'Review the docs',copy:'Review the docs',live:true}])
 assert.deepEqual(d.reads,[['build-the-docs','review-docs']],'one bounded read; another org\'s ticket is never read here')
 assert.match(view.el.textContent??'',/@item:other\/build-the-docsother org/,'another org keeps its token and verdict')
})

test('Markdown bodies show the same titles, leaving code alone',async t=>{
 const slug='titles-md',d=docket(t,[{slug:'build-the-docs',title:'Build the docs site from main',status:'open'}])
 const view=await mountView(<Surface slug={slug} markdown text={`Tracked in @item:${slug}/build-the-docs.\n\nQuoted: \`@item:${slug}/build-the-docs\``}/>,el=>el)
 t.after(()=>view.unmount());await inAct(tick)
 const chip=view.el.querySelector<HTMLElement>(`[data-ref-token="@item:${slug}/build-the-docs"]`)!
 assert.deepEqual([chip.tagName,chip.textContent,chip.getAttribute('data-copy-ticket-title')],['BUTTON','Build the docs site from main','Build the docs site from main'])
 assert.equal(view.el.querySelector('code')?.textContent,`@item:${slug}/build-the-docs`)
 assert.equal(d.reads.length,1)
})

test('every docket write reads the titles on screen again; other frames do not',async t=>{
 const slug='titles-live',d=docket(t,[{slug:'build-the-docs',title:'Build the docs site from main',status:'open'}])
 const view=await mountView(<Surface slug={slug} text={`See @item:${slug}/build-the-docs.`}/>,el=>el)
 t.after(()=>view.unmount());await inAct(tick)
 d.rows[0]!.title='Publish the docs site'
 assert.equal(docketFeed(slug,{type:'custom_apps_changed'}),false)
 await inAct(tick)
 assert.equal(chips(view.el)[0]!.text,'Build the docs site from main','no docket frame, no read')
 assert.equal(docketFeed(slug,{type:'docket_changed'}),true)
 await inAct(tick)
 assert.equal(chips(view.el)[0]!.text,'Publish the docs site')
 assert.equal(d.reads.length,2,'one read per docket frame')
})

test('without a title the chip keeps its slug, and a name read never makes a ticket absent',async t=>{
 const slug='titles-fallback',d=docket(t,[])
 d.state.fail=true
 const failed=await mountView(<Surface slug={slug} text={`See @item:${slug}/build-the-docs.`}/>,el=>el)
 t.after(()=>failed.unmount());await inAct(tick)
 assert.deepEqual(chips(failed.el),[{text:'build-the-docs',copy:null,live:true}],'a failed read is not an answer: the slug, still a link')
 d.state.fail=false
 const missing=await mountView(<Surface slug={slug+'-2'} text={`See @item:${slug}-2/no-such-item.`}/>,el=>el)
 t.after(()=>missing.unmount());await inAct(tick)
 assert.deepEqual(chips(missing.el),[{text:'no-such-item',copy:null,live:true}],'the docket, not the name read, judges existence')
 // the docket's own list names an item without any read
 const world:RefWorld={org:'acme',itemTitles:new Map([['a-b','The A B item']])}
 assert.equal(resolveRef(parseRef('@item:acme/a-b')!,world).label,'The A B item')
 assert.equal(resolveRef(parseRef('@item:acme/a-b')!,{org:'acme'}).label,'a-b','no list, no reader: the slug')
})

test('a docket item named by its slug in prose keeps the words the author wrote',async t=>{
 docket(t,[{slug:'build-the-docs',title:'Build the docs site from main',status:'open'}])
 const index=buildMentionIndex([{slug:'build-the-docs',title:'Build the docs site from main'}])
 const view=await mountView(<WorkRefText text="see build-the-docs today" index={index} onPick={()=>{}}/>,el=>el)
 t.after(()=>view.unmount());await inAct(tick)
 assert.equal(view.el.textContent,'see build-the-docs today')
})
