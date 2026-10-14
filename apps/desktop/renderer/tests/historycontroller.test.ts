import test from 'node:test'
import assert from 'node:assert/strict'
import { HistoryController } from '../src/historycontroller'
import type { HistoryAnswer, UserHistory } from '../src/historyapi'

const target = (id: number) => ({id,kind:'move' as const,label:`Move ${id}`,at:'2026-10-14T00:00:00Z'})
const history = (undo: number | null, redo: number | null = null): UserHistory => ({bound:100,undo:undo==null?null:target(undo),redo:redo==null?null:target(redo),entries:[]})
const deferred = <T,>() => {let resolve!: (v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}

test('a late history read cannot overwrite an undo, and concurrent commands consume once', async () => {
  const stale=deferred<UserHistory>(),answer=deferred<HistoryAnswer>();let reads=0,calls=0
  const c=new HistoryController({read:()=>++reads===1?Promise.resolve(history(3)):stale.promise,
    apply:()=>{calls++;return answer.promise},report:()=>{},changed:()=>{}})
  await c.refresh();const read=c.refresh();const undo=c.run('undo');await c.run('undo')
  assert.equal(calls,1);assert.equal(c.getSnapshot().pending,true)
  answer.resolve({status:'undone',id:3,label:'Move 3',history:history(2,3)});await undo
  stale.resolve(history(3));await read
  assert.equal(c.getSnapshot().history?.undo?.id,2);assert.equal(c.getSnapshot().history?.redo?.id,3)
})

test('worked-hire cancellation consumes nothing, stale confirmation re-prompts, and redo never reuses its token', async () => {
  const calls: [string,number,string|undefined][]=[];let attempt=0
  const c=new HistoryController({read:async()=>history(4),report:()=>{},changed:()=>{},apply:async(dir,id,confirm)=>{
    calls.push([dir,id,confirm]);attempt++
    if(attempt<3)return {status:'confirm',id,label:'Hire alice',agent:'alice',turns:attempt,confirm:`token-${attempt}`,history:history(4)}
    return {status:dir==='undo'?'undone':'redone',id,label:'Hire alice',history:dir==='undo'?history(null,4):history(4)}
  }})
  await c.refresh();await c.run('undo');c.cancelConfirmation()
  assert.equal(calls.length,1);assert.equal(c.getSnapshot().history?.undo?.id,4)
  await c.run('undo');assert.equal(c.getSnapshot().confirmation?.turns,2)
  await c.confirm();assert.equal(calls[2]?.[2],'token-2');assert.equal(c.getSnapshot().confirmation,null)
  await c.run('redo');assert.deepEqual(calls[3],['redo',4,undefined])
})

test('a refused entry reports its reason and the next deliberate command reaches the older entry', async () => {
  const calls:number[]=[],messages:string[][]=[]
  const c=new HistoryController({read:async()=>history(7),report:lines=>messages.push(lines),changed:()=>{},apply:async(_,id)=>{
    calls.push(id)
    return id===7?{code:'history_conflict',id,label:'Move alice',reason:'alice was moved again',history:history(6)}
      :{status:'undone',id,label:'Move bob',history:history(null,6)}
  }})
  await c.refresh();await c.run('undo');assert.deepEqual(calls,[7]);assert.match(messages[0]![0]!,/alice was moved again/)
  await c.run('undo');assert.deepEqual(calls,[7,6])
})

test('disposing an org ignores late completions and leaves another org independent', async () => {
  const answer=deferred<HistoryAnswer>();let oldReports=0
  const old=new HistoryController({read:async()=>history(1),apply:()=>answer.promise,report:()=>{oldReports++},changed:()=>{}})
  const next=new HistoryController({read:async()=>history(9),apply:async()=>({status:'undone',id:9,label:'Other org',history:history(null,9)}),report:()=>{},changed:()=>{}})
  await old.refresh();const request=old.run('undo');old.dispose();await next.refresh()
  answer.resolve({status:'undone',id:1,label:'Old org',history:history(null,1)});await request
  assert.equal(oldReports,0);assert.equal(next.getSnapshot().history?.undo?.id,9);assert.equal(old.can('undo'),false)
})
