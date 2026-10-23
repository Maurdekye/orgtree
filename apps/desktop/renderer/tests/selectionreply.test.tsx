import { FakeServer, installFetch, flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { appendReplyTarget, selectionReplyContext, replyWire, displayReplyWire, replyContext } from '../src/eventReply'
import { sourceDomRange, selectedSourceRange } from '../src/canvas/selectionmap'
import { md } from '../src/canvas/shared'
import { appendSelection, contextBytes, selectionSnapshot, sourceDigest } from '../src/replySelection'
import type { SelectionTarget } from '../src/replySelection'
import { ReplySelectionSurface } from '../src/canvas/replyselection'
import { MailReplyBox } from '../src/canvas/mail'
import { verifySelectionProjection } from '../src/canvas/selectionprojection'
import { Msg } from '../src/canvas/desk'
import { TranscriptSelectionContext } from '../src/canvas/transcriptselection'
import { CurrentOrg } from '../src/popout'

function body(source: string, plain = false) {
  const root=document.createElement('div'); root.setAttribute('data-selection-source','')
  if(plain)root.textContent=source;else root.innerHTML=md(source).__html
  document.body.append(root);return root
}
function textNode(root: Element, text: string, occurrence=0): Text {
  const walker=document.createTreeWalker(root,4);let node:Node|null
  while((node=walker.nextNode()))if(node.textContent===text){if(occurrence--===0)return node as Text}
  throw Error(`missing text node ${JSON.stringify(text)}`)
}
function selection(node:Node,start:number,end:number) {
  const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);return range
}
function sourceText(source:string,range:{start:number;end:number}|null){return range?[...source].slice(range.start,range.end).join(''):null}

test('selection source map distinguishes repeated text by Markdown position and excludes link destinations',()=>{
  const source='First **same** then [same](https://example.invalid/same) and same.'
  const root=body(source)
  try{
    const link=root.querySelector('a')!;const range=selection(link.firstChild!,0,4)
    const mapped=selectedSourceRange(root,source,range)
    assert.equal(sourceText(source,mapped),'same')
    assert.equal(mapped?.start,source.indexOf('[same]')+1)
    const strong=root.querySelector('strong')!
    assert.equal(selectedSourceRange(root,source,selection(strong.firstChild!,0,4))?.start,source.indexOf('**same**')+2)
  }finally{root.remove()}
})

test('selection source map preserves CRLF, emoji, combining marks and RTL in literal code',()=>{
  const source='```text\r\n😀e\u0301 שלום\r\nnext\r\n```'
  const root=body(source)
  try{
    const code=root.querySelector('code')!;const text=code.firstChild!
    const range=selection(text,0,'😀e\u0301 שלום'.length)
    const mapped=selectedSourceRange(root,source,range)
    assert.equal(sourceText(source,mapped),'😀e\u0301 שלום')
    assert.equal(mapped?.start,[...source.slice(0,source.indexOf('😀'))].length)
    assert.equal(root.querySelectorAll('.code-copy').length,1,'copy chrome is present but not source prose')
  }finally{root.remove()}
})

test('selection source map handles headings, lists, tables, entities and code literals',()=>{
  for(const source of ['# Heading\n\n- first\n- **second**','| Name | State |\n| --- | --- |\n| first | second |','first &amp; **second**','first `second`']){
    const root=body(source)
    try{const node=textNode(root,'second');assert.equal(sourceText(source,selectedSourceRange(root,source,selection(node,0,6))),'second')}
    finally{root.remove()}
  }
  const plain='&amp; 😀 text';const root=body(plain,true)
  try{assert.equal(sourceText(plain,selectedSourceRange(root,plain,selection(root.firstChild!,0,5),'plain')),'&amp;')}
  finally{root.remove()}
})

test('selection source map refuses synthetic content and cross-source gestures',()=>{
  const root=body('one two')
  try{
    const node=root.firstChild!.firstChild!;const range=selection(node,0,3)
    root.append(document.createTextNode('synthetic closer'))
    assert.equal(selectedSourceRange(root,'one two',range),null)
    const other=body('outside')
    try{range.setEnd(other.firstChild!.firstChild!,3);assert.equal(selectedSourceRange(root,'one two',range),null)}finally{other.remove()}
  }finally{root.remove()}
})

test('selection source map treats reference labels and rendered math as atomic source units',()=>{
  const source='See @doc:demo/plan and $x^2$.';const root=body(source)
  try{
    const p=root.querySelector('p')!;const text=p.firstChild as Text
    const chip=document.createElement('button');chip.setAttribute('data-ref-token','@doc:demo/plan');chip.textContent='Renamed presentation'
    const start=text.textContent!.indexOf('@doc:demo/plan');const tail=text.splitText(start);tail.deleteData(0,'@doc:demo/plan'.length);p.insertBefore(chip,tail)
    assert.equal(sourceText(source,selectedSourceRange(root,source,selection(chip.firstChild!,0,7))),'@doc:demo/plan')
    const math=root.querySelector('.katex')!;const range=document.createRange();range.selectNodeContents(math)
    assert.equal(sourceText(source,selectedSourceRange(root,source,range)),'$x^2$')
  }finally{root.remove()}
})

test('selection snapshots preserve exact text and enforce UTF8 aggregate limits',async()=>{
  const hash=await sourceDigest('  😀 passage\n')
  const selector={part:'mail.body',projection:'source-v1' as const,unit:'unicode-scalar' as const,expected_sha256:hash,start:0,end:12}
  const snapshot=selectionSnapshot('  😀 passage\n',selector,1)
  assert.equal(snapshot.excerpt,'  😀 passage\n')
  assert.equal(hash.length,64)
  assert.equal(new TextEncoder().encode(contextBytes('א'.repeat(200),'prefix')).length,256)
  const draft={target:{kind:'mail' as const,org:'demo',id:'m1'},selection:selector,snapshot}
  assert.equal(appendSelection([draft],draft).length,1)
  assert.throws(()=>appendSelection(Array.from({length:8},(_,i)=>({...draft,selection:{...selector,start:i+20}})),draft),/8 selected/)
})

test('selection menu stages an exact passage, preserves text and restores a refused mail send',async t=>{
  const originalCrypto=Object.getOwnPropertyDescriptor(globalThis,'crypto')
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto})
  const prior=globalThis.fetch;installFetch(new FakeServer());const fallback=globalThis.fetch
  globalThis.fetch=(async(input,init)=>String(input).includes('/reply-source')?new Response(JSON.stringify({text:'one passage two',revision:1,sha256:'hash',projection:'source-v1',unit:'unicode-scalar',offset:0,next_offset:null,total_scalars:15}),{status:200}):fallback(input,init))as typeof fetch
  t.after(()=>{globalThis.fetch=prior;if(originalCrypto)Object.defineProperty(globalThis,'crypto',originalCrypto)})
  const sent:SelectionTarget[][]=[];const source='one passage two'
  const view=await mountView(<CurrentOrg.Provider value="demo"><div className="mailer-read">
    <ReplySelectionSurface source={{org:'demo',target:{kind:'mail',org:'demo',id:'m1'},part:{part:'mail.body'},text:source}}><p>{source}</p></ReplySelectionSurface>
    <MailReplyBox slug="demo" target="writer" objectActions onSend={(_text,_files,_notice,_broadcast,_object,selections)=>{sent.push(selections??[]);return Promise.reject(Error('Source changed before sending'))}} />
  </div></CurrentOrg.Provider>,el=>el)
  t.after(()=>view.unmount())
  const ta=view.el.querySelector('textarea')!;const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!
  await inAct(()=>{setter.call(ta,'Explain this');ta.dispatchEvent(new Event('input',{bubbles:true}))})
  const node=view.el.querySelector('p')!.firstChild!;const range=selection(node,4,11)
  const selected=document.getSelection()!;selected.removeAllRanges();selected.addRange(range)
  await inAct(async()=>{node.parentElement!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:20,clientY:30}));await flush(5)})
  const button=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent?.trim()==='Reply to selection')
  assert.equal(!!button,true)
  await inAct(async()=>{button!.click();await flush(20)})
  assert.equal(view.el.querySelector('.selection-excerpt')?.textContent,'passage')
  assert.equal(ta.value,'Explain this')
  await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click();await flush(10)})
  assert.equal(sent.length,1);assert.equal(sent[0]![0]!.selection.start,4);assert.equal(sent[0]![0]!.selection.end,11)
  assert.equal(ta.value,'Explain this');assert.equal(view.el.querySelector('.selection-excerpt')?.textContent,'passage')
  assert.equal(view.el.textContent!.includes('Source changed before sending'),true)
  selected.removeAllRanges()
})

test('selection reverse mapping identifies the second repeated passage and refuses modified DOM',()=>{
  const source='first **same** then [same](https://example.invalid)';const root=body(source)
  try{
    const start=source.indexOf('[same]')+1;const range=sourceDomRange(root,source,start,start+4)
    assert.equal(range?.toString(),'same');assert.equal(range?.startContainer.parentElement?.tagName,'A')
    root.append(document.createTextNode('synthetic'));assert.equal(sourceDomRange(root,source,start,start+4),null)
  }finally{root.remove()}
})

test('selection event drafts retain independent ranges and send only selectors',()=>{
  const selector={part:'text',projection:'source-v1' as const,unit:'unicode-scalar' as const,expected_sha256:'a'.repeat(64),start:0,end:3}
  const snapshot=selectionSnapshot('one two',selector,4)
  const target={source_event_ref:{org:'demo',agent:'writer',generation:1,eventId:'e7'}}
  const first=selectionReplyContext({target,selection:selector,snapshot},target.source_event_ref)
  const other={...first,selection:{...snapshot,selector:{...selector,start:4,end:7},excerpt:'two'}}
  assert.equal(appendReplyTarget([first],other).length,2)
  assert.equal(appendReplyTarget([first],first).length,1)
  assert.deepEqual(replyWire(first),{target,selection:selector})
  assert.equal(replyContext({...target,quoted_context:'one',selection:snapshot})?.selection?.excerpt,'one')
  assert.equal(replyContext(displayReplyWire(first))?.selection?.excerpt,'one')
})

test('settled transcript prose, thoughts and JSON fields stage distinct source parts in the owning box',async t=>{
  const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto})
  const prior=globalThis.fetch;installFetch(new FakeServer());const fallback=globalThis.fetch
  globalThis.fetch=(async(input,init)=>String(input).includes('/toolinput/')?new Response(JSON.stringify({input:{'a/b':'input phrase'}}),{status:200})
    :String(input).includes('/reply-source')?new Response(JSON.stringify({revision:1}),{status:200}):fallback(input,init))as typeof fetch
  t.after(()=>{globalThis.fetch=prior;if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor)})
  const sent:SelectionTarget[][]=[]
  const view=await mountView(<CurrentOrg.Provider value="demo"><TranscriptSelectionContext.Provider value={{org:'demo',agent:'writer',generation:1}}><div className="mailer-read">
    <Msg slug="demo" nid="writer" m={{role:'assistant',event_id:'e7',seq:7,text:'prose phrase',thinking:'thought phrase',thinking_tokens:20,
      tools:[{id:'call',event_id:'e7',result_event_id:'e7',input_seq:7,name:'example',result:'{"a/b":"result phrase"}'}]}} />
    <MailReplyBox slug="demo" target="writer" objectActions onSend={(_text,_files,_notice,_broadcast,_object,selections)=>{sent.push(selections??[])}} />
  </div></TranscriptSelectionContext.Provider></CurrentOrg.Provider>,el=>el)
  t.after(()=>view.unmount())
  await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.thoughtline')!.click();view.el.querySelector<HTMLElement>('.tline')!.click();await flush(15)})
  const pick=async(node:Node,start:number,end:number)=>{const selected=document.getSelection()!;selected.removeAllRanges();selected.addRange(selection(node,start,end))
    await inAct(async()=>{node.parentElement!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:20,clientY:30}));await flush(2)})
    const button=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b=>b.textContent?.trim()==='Reply to selection')
    assert.equal(!!button&&!button.disabled,true)
    await inAct(async()=>{button!.click();await flush(5)});selected.removeAllRanges()
  }
  await pick(textNode(view.el,'prose phrase'),0,5)
  await pick(textNode(view.el,'thought phrase'),0,7)
  await pick(textNode(view.el,'input phrase'),0,5)
  await pick(textNode(view.el,'result phrase'),0,6)
  const key=view.el.querySelector('.toolinput .sj-key')!;await pick(key.firstChild!,0,3)
  const ta=view.el.querySelector('textarea')!,setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!
  await inAct(()=>{setter.call(ta,'Explain these');ta.dispatchEvent(new Event('input',{bubbles:true}))})
  await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click();await flush(5)})
  assert.equal(sent[0]?.length,5)
  assert.deepEqual(sent[0]?.map(r=>[r.selection.part,r.selection.pointer??'',r.selection.role??'value']),[['text','','value'],['thinking','','value'],['tool.input','/a~1b','value'],['tool.result','/a~1b','value'],['tool.input','/a~1b','key']])
})

test('clipped projections verify every displayed scalar against canonical version-bound windows',async t=>{
  const prior=globalThis.fetch;const offsets:number[]=[];let changed=false
  globalThis.fetch=(async(_input,init)=>{
    const request=JSON.parse(String(init?.body)),offset=request.offset??0;offsets.push(offset)
    assert.equal(offset===0?request.expected_sha256===undefined:request.expected_sha256==='a'.repeat(64),true)
    return new Response(JSON.stringify({text:offset===0?'one ':changed?'changed':'two trailing canonical text',sha256:'a'.repeat(64),revision:2,offset,next_offset:offset===0?4:null}),{status:200})
  })as typeof fetch
  t.after(()=>{globalThis.fetch=prior})
  const source={org:'demo',target:{kind:'mail' as const,org:'demo',id:'m'},part:{part:'mail.body'},text:'one two',partial:true}
  assert.equal((await verifySelectionProjection(source)).sha256,'a'.repeat(64));assert.deepEqual(offsets,[0,4])
  changed=true;await assert.rejects(verifySelectionProjection(source),/displayed prefix/)
})
