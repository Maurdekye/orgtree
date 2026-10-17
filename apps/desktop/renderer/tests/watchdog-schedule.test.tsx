import test from 'node:test'
import assert from 'node:assert/strict'
import { watchdogCountdownText } from '../src/canvas/watchdogcountdown'
import type { Watchdog } from '../src/types'

const h=(n:number)=>new Date(1_800_000_000_000+n*3600_000).toISOString()
const dog:Watchdog={id:'lead/clock',name:'clock',owner:'lead',kind:'command',target:'echo ok',
  interval_s:21600,state:'armed',at:h(0),fired:1,once:false,spent:false,last_check:h(7),next_check_at:h(12)}

test('after h7 catch-up the persisted next h12 beats last actual check plus six hours',()=>{
  assert.equal(watchdogCountdownText(dog,Date.parse(h(8))),'next check in 4h 0m')
})
test('an overdue stored deadline stays checking until a real engine progress update',()=>{
  assert.equal(watchdogCountdownText({...dog,next_check_at:h(6)},Date.parse(h(7))),'checking\u2026')
})
test('the persisted silence deadline can shorten the next polling check',()=>{
  assert.equal(watchdogCountdownText({...dog,fire_mode:'silence',quiet_period_s:21600,
    silence_since:h(7),next_silence_at:h(10)},Date.parse(h(8))),'next check in 2h 0m')
})
test('event-driven process-down observations do not turn pushed event kinds into timers',()=>{
  assert.equal(watchdogCountdownText({...dog,kind:'activity'},Date.parse(h(8))),undefined)
})
