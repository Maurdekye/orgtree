import { inAct, flush, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { flushOpenedMail, useReadOnLeave } from '../src/mailleave'

const row={id:'retry-read',_wait:true}
function Reader({read}:{read:()=>void|Promise<unknown>}) {
  useReadOnLeave('retry-read',[{...row}],read,window)
  return <span>Visible mail</span>
}
const tick=()=>inAct(async()=>{await flush(3)})
for(const sync of [false,true]) {
  test(`a ${sync?'synchronous throw':'rejected save'} retries on a later leave, including a same-id refresh`,async t=>{
    let attempts=0
    const read=()=>{if(++attempts===1){if(sync)throw Error('offline');return Promise.reject(Error('offline'))}return Promise.resolve()}
    const v=await mountView(<Reader read={read}/>,el=>el)
    t.after(()=>v.unmount())
    await inAct(async()=>{await flushOpenedMail(window)})
    assert.equal(attempts,1)
    await v.render(<Reader read={read}/>)
    await v.render(<span>Closed</span>);await tick()
    assert.equal(attempts,2)
    await flushOpenedMail(window)
    assert.equal(attempts,2)
  })
}

test('a rejection after a same-id rerender releases the current entry for retry',async t=>{
  let attempts=0,reject!:(e:Error)=>void
  const pending=new Promise<void>((_,fail)=>{reject=fail})
  const read=()=>++attempts===1?pending:Promise.resolve()
  const v=await mountView(<Reader read={read}/>,el=>el)
  t.after(()=>v.unmount())
  const drain=flushOpenedMail(window)
  await v.render(<Reader read={read}/>)
  reject(Error('offline'));await drain;await tick()
  await v.render(<span>Closed</span>);await tick()
  assert.equal(attempts,2)
})

test('pending flushes coalesce and a successful save remains once-only through refresh and leave',async t=>{
  let attempts=0,finish!:()=>void
  const pending=new Promise<void>(resolve=>{finish=resolve})
  const read=()=>{attempts++;return pending}
  const v=await mountView(<Reader read={read}/>,el=>el)
  t.after(()=>v.unmount())
  const first=flushOpenedMail(window),second=flushOpenedMail(window)
  await v.render(<Reader read={read}/>)
  assert.equal(attempts,1)
  finish();await Promise.all([first,second]);await tick()
  await flushOpenedMail(window)
  await v.render(<span>Closed</span>);await tick()
  assert.equal(attempts,1)
})
