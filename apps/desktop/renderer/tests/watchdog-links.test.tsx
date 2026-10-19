import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct } from './harness'
import { DeskDogsProvider, DogChip } from '../src/canvas/deskdogs'
import { ToolRefs } from '../src/canvas/toolrefs'
import type { Watchdog } from '../src/types'

const dog: Watchdog = {id:'worker/watch',owner:'worker',name:'watch',kind:'listener_watch',target:'build',count:2,
  once:true,state:'armed',at:'2026-10-19T00:00:00Z',fired:0,interval_s:30}

test('desk cards use the shared watchdog link and retain their detail action',async t=>{
  const opened:string[]=[]
  const v=await mountView(<DeskDogsProvider value={{org:'demo',dogs:[dog],open:id=>opened.push(id)}}>
    <DogChip dog={dog} onOpen={id=>opened.push(id)}/></DeskDogsProvider>,el=>el)
  t.after(()=>v.unmount())
  const chip=v.el.querySelector<HTMLElement>('.watchdog-link')
  assert.ok(!!chip,'desk watchdog is a shared link')
  assert.ok(chip!.classList.contains('listener-watch'))
  assert.ok(chip!.classList.contains('oneshot'))
  assert.equal(chip!.getAttribute('data-object-org'),'demo')
  await inAct(async()=>chip!.click())
  assert.deepEqual(opened,[dog.id])
})

test('tool watchdog links resolve metadata from the current org and update on changes',async t=>{
  const refs=[{kind:'watchdog' as const,id:'watch'}]
  const show=(w:Watchdog,org='demo')=><DeskDogsProvider value={{org,dogs:[w],open:()=>{}}}>
    <ToolRefs refs={refs} owner="worker" org="demo" agent={id=>id}/></DeskDogsProvider>
  const v=await mountView(show(dog),el=>el);t.after(()=>v.unmount())
  assert.ok(!!v.el.querySelector('.watchdog-link.listener-watch.oneshot'))
  await v.rerender(show({...dog,kind:'fair_queue',once:false}))
  assert.ok(!!v.el.querySelector('.watchdog-link.fair-queue:not(.oneshot)'))
  await v.rerender(show(dog,'other'))
  assert.equal(v.el.querySelector('.watchdog-link.listener-watch')===null,true,'foreign registry metadata must not bleed into this org')
})

test('missing watchdog metadata keeps a neutral shared chip without inventing its kind',async t=>{
  const v=await mountView(<DeskDogsProvider value={{org:'demo',dogs:[],open:()=>{throw Error('gone dog opened')}}}>
    <ToolRefs refs={[{kind:'watchdog',id:'gone'}]} owner="worker" org="demo" agent={id=>id}/>
  </DeskDogsProvider>,el=>el);t.after(()=>v.unmount())
  const chip=v.el.querySelector('.watchdog-link')
  assert.ok(!!chip,'gone links use the same component')
  assert.equal(chip!.classList.contains('listener'),false)
  assert.equal(chip!.classList.contains('oneshot'),false)
  assert.match(chip!.textContent??'',/gone/)
  assert.equal(chip!.tagName,'SPAN')
})
