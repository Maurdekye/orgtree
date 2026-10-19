import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mailQueueCard } from '../src/canvas/listeners'
import type { Watchdog } from '../src/types'
const dog={id:'worker/mail',owner:'worker',name:'mail',kind:'fair_queue',target:'project',state:'armed',spent:false} as Watchdog
// A base without the new field fails on the actual missing state contract.
const bright=(...args:Parameters<typeof mailQueueCard>)=>(mailQueueCard(...args) as {bright?:boolean}|null)?.bright
test('armed mail listeners fill the merged card even without queued mail',()=>assert.equal(bright('project',0,0,false,[dog]),true))
test('in-flight ack mail fills the merged card without an armed listener',()=>assert.equal(bright('project',0,1,true,[]),true))
test('only queued mail remains outlined and a paused listener does not fill it',()=>assert.equal(bright('project',3,0,true,[{...dog,state:'paused'}]),false))
test('non-ack held mail cannot fill the card when nobody listens',()=>assert.equal(bright('project',3,7,false,[]),false))
