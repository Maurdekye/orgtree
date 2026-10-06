import test from 'node:test'
import assert from 'node:assert/strict'
import { bumpLive, onLiveBump } from '../src/livebus'
import { runOp } from '../src/api'
import { RecordFeed } from '../src/recordfeed'

function rig(t: import('node:test').TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = globalThis.fetch
  let answer!: (r: Response) => void
  globalThis.fetch = (() => new Promise<Response>(r => { answer = r })) as typeof fetch
  const reads: number[] = []
  let clock = 0
  const feed = new RecordFeed({
    snapshot: async () => { throw new Error('unexpected baseline') },
    catchup: async c => { reads.push(clock); return {type: 'record_changes' as const,
      ...c, from:c.rev,to:c.rev+1,upserts:[],tombstones:[]} },
    project: () => null, publish: () => {}, error: e => { throw e },
  })
  feed.receive({type:'record_snapshot',cursor:{org_uuid:'o',incarnation:'i',rev:1},records:[]})
  const off = onLiveBump(() => { void feed.reconnect() })
  t.after(() => { off();feed.dispose();globalThis.fetch=previous;t.mock.timers.reset() })
  return {reads, feed, answer: (r:Response) => answer(r), tick: (ms:number) => {
    clock += ms;t.mock.timers.tick(ms)
  }}
}

test('acknowledged local move starts catch-up without the coalesce delay or duplicate', async t => {
  const r=rig(t)
  const result=runOp('o',{op:'move',node:'a',new_parent:null})
  r.tick(20);assert.deepEqual(r.reads,[])
  r.answer(new Response(JSON.stringify({ok:true}),{status:200}))
  assert.deepEqual(await result,{ok:true})
  r.tick(0)
  assert.deepEqual(r.reads,[20])
  r.tick(120);assert.deepEqual(r.reads,[20])
})

test('move acknowledgment flushes an older pending bump once',async t => {
  const r=rig(t)
  bumpLive();r.tick(30)
  const done=runOp('o',{op:'move',node:'a',new_parent:'b'})
  r.answer(new Response('{}',{status:200}));await done
  r.tick(0)
  assert.deepEqual(r.reads,[30]);r.tick(120);assert.deepEqual(r.reads,[30])
})

test('later event still refreshes after a fast move',async t => {
  const r=rig(t)
  const done=runOp('o',{op:'move',node:'a',new_parent:null})
  r.answer(new Response('{}',{status:200}));await done
  r.tick(0)
  bumpLive();r.tick(119);assert.deepEqual(r.reads,[0])
  r.tick(1);assert.deepEqual(r.reads,[0,120])
})

test('other operations retain normal coalescing',async t => {
  const r=rig(t)
  const done=runOp('o',{op:'retire',node:'a'})
  r.answer(new Response('{}',{status:200}));await done
  r.tick(119);assert.deepEqual(r.reads,[])
  r.tick(1);assert.deepEqual(r.reads,[120])
})

test('failed move does not flush an unrelated pending refresh',async t => {
  const r=rig(t)
  bumpLive();r.tick(20)
  const done=runOp('o',{op:'move',node:'a',new_parent:null})
  r.answer(new Response(JSON.stringify({detail:'rejected'}),{status:409}))
  await assert.rejects(done,/rejected/)
  assert.deepEqual(r.reads,[]);r.tick(100);assert.deepEqual(r.reads,[120])
})

test('event bursts without a move still produce one delayed refresh',async t => {
  const r=rig(t)
  for(let i=0;i<20;i++)bumpLive()
  r.tick(119);assert.deepEqual(r.reads,[])
  r.tick(1);assert.deepEqual(r.reads,[120])
  r.tick(120);assert.deepEqual(r.reads,[120])
})
