import { FakeServer, advance, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'
import type { OpResult } from '../src/types'

for (const [viewport, rowHeight, expected] of [[600,40,30],[300,200,8],[800,100,16]]) {
  test(`mounted desk fills twice ${viewport}px with ${rowHeight}px rows`, async t => {
    useFakeClock()
    const proto = window.HTMLElement.prototype
    const properties = ['clientHeight','offsetHeight','offsetTop','scrollHeight'] as const
    const saved = properties.map(key => Object.getOwnPropertyDescriptor(proto,key))
    const rows = (el: HTMLElement) => [...el.querySelectorAll('[data-transcript-row]')]
    for (const key of properties) Object.defineProperty(proto,key,{ configurable:true,get() {
      const el=this as HTMLElement
      if (key==='clientHeight') return el.classList.contains('msgs') ? viewport : 0
      if (key==='scrollHeight') return el.classList.contains('msgs') ? rows(el).length*rowHeight : 0
      if (!el.hasAttribute('data-transcript-row')) return 0
      if (key==='offsetHeight') return rowHeight
      return rows(el.parentElement!).indexOf(el)*rowHeight
    }})
    const server=new FakeServer()
    for(let i=0;i<1000;i++)server.assistantMsg(`message ${i}`)
    installFetch(server)
    const node={id:'a',state:'live',tier:'haiku',model_id:'haiku',children:[],seat:1,grant:0,free:0,
      scope:{tools:{},add_dirs:[]}} as CanvasNode
    const view=await mountView(<DeskChat node={node} map={new Map([['a',node]])} slug="viewport"
      op={()=>Promise.resolve({} as OpResult)} toast={()=>{}} pub={false} bare onJump={()=>{}}/>, el=>el)
    t.after(async()=>{await view.unmount();resetConvos();realClock();properties.forEach((key,i)=>{
      const d=saved[i];if(d)Object.defineProperty(proto,key,d);else delete (proto as any)[key]
    })})
    await advance(500)
    assert.equal(server.requests[0]?.last,8,'first fetch is a small seed, not 120 rows')
    assert.equal(rows(view.el).length,expected,'measured viewport determines row demand')
    const count=server.requests.length
    await advance(1000)
    assert.equal(server.requests.length,count,'filling stops at the buffer')
    const el=view.el.querySelector<HTMLElement>('.msgs')!
    await inAct(()=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll',{bubbles:true}))})
    await advance(500)
    assert.ok(rows(view.el).length>expected,'scrolling back explicitly loads more')
    assert.ok(rows(view.el).length<1000,'never loads the entire fixture')
  })
}
