import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { InboxPanel } from '../src/App'
import { EventCard } from '../src/events/card'
import { BASE } from '../src/api'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'
declare const __SRC_DIR__: string
const noop = () => {}
window.HTMLElement.prototype.scrollIntoView = noop // jsdom has no layout; browser probe measures visibility.
const tree = { slug:'mine', roots:[], audiences:[], credit_requests:[], asks:[], tiers:{}, fable_lock:null } as unknown as TreePayload
const row = (id:string, at:string) => ({id, from:'alpha', kind:'message', at, body:'Meaningful '+id})
const oldest = row('original', '2026-09-01T00:00:00Z')
const newer = row('other', '2026-09-02T00:00:00Z')
const response = (data:unknown, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}})
const body = (el:HTMLElement) => el.querySelector('.mailer-body')?.textContent ?? ''
async function type(el:HTMLElement, value:string) {
  const field=el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
  assert.ok(field, 'actual reply composer exists')
  await inAct(()=>{
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(field,value)
    field.dispatchEvent(new Event('input',{bubbles:true}))
  })
  return field
}

export function mailCorrections(profile:'operator'|'public') {
  for (const outcome of ['success','refused','read-failed','command'] as const) test(profile+' reply '+outcome+' preserves send/read ordering and original identity', async t=>{
    assert.equal(BASE, profile==='public'?'/k/visitor':'')
    useFakeClock(); resetConvos()
    const saved=globalThis.fetch
    let pending=[oldest,newer], delivered:typeof pending=[], release:((r:Response)=>void)|undefined, refresh=0
    const reads:unknown[]=[], sends:unknown[]=[], notices:string[][]=[]
    globalThis.fetch=(async(input,init)=>{
      const url=String(input)
      if(url.endsWith('/nodes/alpha/message')) {
        sends.push(JSON.parse(String(init?.body)))
        return new Promise<Response>(resolve=>{release=resolve})
      }
      if(url.endsWith('/inbox/read')) {
        const ids=JSON.parse(String(init?.body)).ids as string[]; reads.push(ids)
        if(outcome==='read-failed') return response({detail:'read refused'},403)
        delivered.push(...pending.filter(m=>ids.includes(m.id)))
        pending=pending.filter(m=>!ids.includes(m.id))
        return response({read:1})
      }
      if(url.endsWith('/inbox')) return response({pending,delivered,sent:[]})
      return response({})
    }) as typeof fetch
    const view=await mountView(<InboxPanel slug="mine" tree={tree} toast={v=>notices.push(v)} refresh={()=>refresh++} close={noop} jumpTo={null}/>,h=>h)
    t.after(async()=>{await view.unmount();globalThis.fetch=saved;resetConvos();realClock()})
    await flush()
    assert.match(body(view.el),/Meaningful original/, 'oldest unread selected without a click')
    const field=await type(view.el,'Reply contents')
    await inAct(()=>{(view.el.querySelector('.mail-reply button') as HTMLButtonElement).click()});await flush()
    assert.ok(release,'actual send request held pending')
    assert.deepEqual(reads,[], 'no read request before send acceptance')
    assert.equal(view.el.querySelectorAll('.mailrow.unread').length,2)
    assert.deepEqual(sends,[{text:'Reply contents',target:{kind:'mail',org:'mine',box:'user',id:'original'}}])
    await inAct(()=>release!(outcome==='refused'?response({detail:'recipient refused'},422)
      : response(outcome==='command'?{accepted:true,command:true}:{id:'new-reply-id',accepted:true,deferred:true})))
    await flush()
    assert.deepEqual(reads, outcome==='success'||outcome==='read-failed'?[['original']]:[], 'never marks the receipt id or another unread mail')
    assert.equal(field.value,outcome==='refused'?'Reply contents':'')
    assert.equal(refresh,outcome==='success'?1:0)
    assert.equal(view.el.querySelectorAll('.mailrow.unread').length,outcome==='success'?1:2)
    assert.match(body(view.el),/Meaningful original/, 'refresh keeps selection')
    if(outcome==='read-failed') assert.match(notices.flat().join(' '),/Reply sent, but could not mark/)
    if(outcome==='refused') assert.match(notices.flat().join(' '),/recipient refused/)
  })

  test(profile+' oldest unread waits for initial load, reveals earlier page, preserves later selection and resets on reopen',async t=>{
    useFakeClock()
    const saved=globalThis.fetch
    let release:((r:Response)=>void)|undefined, initial=true
    let pending=[newer,oldest]
    const delivered=Array.from({length:45},(_,i)=>row('read-'+i,'2026-09-03T00:00:'+String(i).padStart(2,'0')+'Z'))
    globalThis.fetch=(async(input,init)=>{
      if(String(input).endsWith('/inbox/read')) return response({read:0})
      if(String(input).endsWith('/inbox')) {
        if(initial){initial=false;return new Promise<Response>(resolve=>{release=resolve})}
        return response({pending,delivered,sent:[]})
      }
      return response({})
    }) as typeof fetch
    const open=(jump:string|null=null)=><InboxPanel slug="mine" tree={tree} toast={noop} close={noop} jumpTo={jump}/>
    const view=await mountView(open(),h=>h)
    t.after(async()=>{await view.unmount();globalThis.fetch=saved;realClock()})
    await flush();assert.equal(view.el.querySelectorAll('.mailrow').length,0,'loading is genuinely delayed')
    await inAct(()=>release!(response({pending,delivered,sent:[]})));await flush()
    assert.match(body(view.el),/Meaningful original/)
    assert.ok(view.el.querySelector('.mailrow.on')?.textContent?.includes('Meaningful original'),'oldest unread past first 40 rows is revealed')
    const other=[...view.el.querySelectorAll('.mailrow')].find(e=>e.textContent?.includes('Meaningful other')) as HTMLElement
    await inAct(()=>other.click());await flush()
    pending=[row('earlier-arrival','2026-08-01T00:00:00Z'),...pending]
    await advance(5100,16);await flush()
    assert.match(body(view.el),/Meaningful other/,'poll cannot steal deliberate selection')
    await view.render(<span/>);await view.render(open());await flush()
    assert.match(body(view.el),/Meaningful earlier-arrival/,'reopen chooses current oldest')
    await view.render(<span/>);await view.render(open('other'));await flush()
    assert.match(body(view.el),/Meaningful other/,'explicit deep link overrides oldest')
    pending=[]
    await view.render(<span/>);await view.render(open());await flush()
    assert.equal(body(view.el),'','all-read opening remains unselected')
    pending=[oldest]
    await advance(5100,16);await flush()
    assert.equal(body(view.el),'','arrival after an all-read opening does not auto-select')
  })

  test(profile+' automatically viewed unread is marked only when leaving or closing',async t=>{
    useFakeClock();const saved=globalThis.fetch;const reads:string[][]=[]
    let pending=[oldest,newer]
    globalThis.fetch=(async(input,init)=>{
      if(String(input).endsWith('/inbox/read')) {
        const ids=JSON.parse(String(init?.body)).ids as string[];reads.push(ids)
        pending=pending.filter(m=>!ids.includes(m.id));return response({read:ids.length})
      }
      return response(String(input).endsWith('/inbox')?{pending,delivered:[],sent:[]}:{})
    }) as typeof fetch
    const open=()=> <InboxPanel slug="mine" tree={tree} toast={noop} close={noop} jumpTo={null}/>
    const view=await mountView(open(),h=>h)
    t.after(async()=>{await view.unmount();globalThis.fetch=saved;realClock()})
    await flush();assert.match(body(view.el),/Meaningful original/);assert.deepEqual(reads,[])
    await view.render(<span/>);await flush();assert.deepEqual(reads,[['original']],'close marks the automatically displayed original')
    await view.render(open());await flush();assert.match(body(view.el),/Meaningful other/);assert.deepEqual(reads,[['original']],'reopen itself marks nothing')
    await view.render(<span/>);await flush();assert.deepEqual(reads,[['original'],['other']],'second close marks only the next viewed message')
  })

  test(profile+' status header keeps one linked self identity and distinct reported identities',async t=>{
    const f=JSON.parse(readFileSync(path.resolve(__SRC_DIR__,'../tests/fixtures/events/status.report.json'),'utf8'))
    for(const subject of ['alpha','beta']) {
      const event={...f[profile==='public'?'public':'private'],actor:{kind:'agent',id:'alpha'},object:{...f[profile==='public'?'public':'private'].object,id:subject,name:subject,...(profile==='operator'?{org:'mine'}:{})},summary:'Meaningful status'}
      const opened:string[]=[]
      const view=await mountView(<EventCard org="mine" profile={profile} row={profile==='public'?{ev_public:event}:{ev:event}}
        actor={id=><span className="sender-control">{id}</span>}
        world={{org:'mine',agents:new Map([['alpha','alpha'],['beta','beta']]),tierOf:()=> 'fable'}} onOpen={r=>opened.push(r.ref.id)}/>,h=>h)
      const head=view.el.querySelector('.event-head')!
      assert.equal((head.textContent!.match(/alpha/g)??[]).length,1)
      assert.equal(head.querySelectorAll('.sender-control').length,subject==='alpha'?0:1)
      assert.equal(head.querySelectorAll('.tier').length,1,'linked model icon remains')
      assert.match(head.textContent!,/done/)
      const link=head.querySelector('button.ref-chip') as HTMLButtonElement
      assert.ok(link);await inAct(()=>link.click());assert.deepEqual(opened,[subject])
      assert.match(body(view.el)||view.el.textContent!,/Meaningful status/)
      await view.unmount()
    }
  })
}
