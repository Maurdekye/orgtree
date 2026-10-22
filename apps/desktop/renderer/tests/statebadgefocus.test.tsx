import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeSquare } from '../src/canvas/cards'
import { setAgentShortcutsOn, syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'

const noop=()=>{}
const makeNode=():CanvasNode=>({id:'worker',tier:'sol',state:'live',generation:1,children:[],busy:true,
  seat:2,grant:0,free:0,scope:{tools:{},add_dirs:[],effort:'high',fast_mode:false},
  serving_account:{id:'claude-5',provider:'claude',email:'synthetic@example.test',auth:'authenticated',state:'ready'},
  pending_account:{account:'openai/backup'},pending_switch:{tier:'sol'},
  effort_current:'medium',effort_effective:'high',pending_effort:'high',fast_mode_current:true,
  dnd:true,halt:{phase:'halted'},
  frozen:{kind:'limit',error:'Synthetic limit',account:null,provenance:'measured'},
  session_placement:{session:'session0',reason:'preference',at:'2026-10-22T10:00:00Z'},
} as CanvasNode)
const selectors=['.serving-account','[data-next-turn="account"]','[data-next-turn="model"]',
  '[data-next-turn="effort"]','[data-next-turn="fast"]','.effort-level','.fast-mode','.frozen','.sq-halt-status','.dnd-badge','.session-0']

test.beforeEach(()=>{localStorage.clear();setAgentShortcutsOn(true);installFetch(new FakeServer());
  syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol',fast_mode:true}]}]})})
test('every state badge passes the card body focus gesture without an action or cancellation',async t=>{
  const n=makeNode(),received:string[]=[],clicks:string[]=[],configured:string[]=[]
  const view=await mountView(<div onClick={()=>clicks.push('card click')}><NodeSquare node={n} pos={{x:0,y:0}}
    lod="norm" focused={false} dragging={false} isDrop={false} seats={{sol:2}}
    map={new Map([[n.id,n]])} op={async()=>({})} slug="org" toast={noop} pxc={1} zoom={1}
    compactAt={0.8} maxTop={0} cascadeAlloc onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
    onConfig={()=>configured.push(n.id)} onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
    onJump={noop} onMailLink={noop} onWorkLink={noop}
    onDragStart={(_e,id)=>received.push('down:'+id)} onDragMove={noop}
    onDragEnd={(_e,id)=>received.push('up:'+id)} onDragCancel={noop}/></div>,el=>el)
  t.after(()=>view.unmount());await flush()
  const press=async(el:Element)=>{
    received.length=0;clicks.length=0
    const events=[new window.PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0}),
      new window.PointerEvent('pointerup',{bubbles:true,cancelable:true,button:0}),
      new window.MouseEvent('click',{bubbles:true,cancelable:true,button:0})]
    await inAct(()=>{for(const e of events)el.dispatchEvent(e)})
    return {received:[...received],clicks:[...clicks],cancelled:events.some(e=>e.defaultPrevented)}
  }
  const body=await press(view.el.querySelector('.sq')!)
  assert.deepEqual(body,{received:['down:worker','up:worker'],clicks:['card click'],cancelled:false})
  for(const selector of selectors){
    const badge=view.el.querySelector<HTMLElement>('.sq '+selector)
    assert.ok(!!badge,'missing state badge '+selector)
    assert.equal(!!badge!.closest('button,a,[role="button"]'),false,selector+' must be display-only')
    assert.deepEqual(await press(badge!),body,selector+' must focus through the same card event path')
  }
  assert.deepEqual(configured,[])
  // A real action remains separate: clicking the gear still opens settings.
  await press(view.el.querySelector('.gearbtn')!)
  assert.deepEqual(configured,['worker'])
})
