import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAttentionRows } from '../src/attention/feed'
import { markReadNow, resetLocalReads, unconfirmedReads } from '../src/mailread'
import type { MailEntry } from '../src/types'
import type { TreeNode } from '../src/types'
import { mountView } from './harness'
import { MailList } from '../src/canvas/mail'

const mail=(extra: Partial<MailEntry>={})=>({id:'mention-1',from:'worker',body:'Ready @user.',at:'2026-10-18T12:00:00Z',kind:'message',mailbox_attention:true,...extra} as MailEntry)

test('mention mail enters the same attention row as urgent without an urgent tag',()=>{
  for(const from of ['worker','project','@org:outside']){
    const m=mail({from})
    const rows=buildAttentionRows({slug:'mention',pending:[m]})
    assert.equal(rows.length,1,'mention must enter urgent mailbox attention')
    assert.equal(rows[0]?.kind,'mail')
    assert.equal(rows[0]?.mail?.urgent,undefined)
  }
})
test('reading mentioned mail clears the same urgent count immediately',async()=>{
  resetLocalReads()
  try {
    await markReadNow('mention',mail(),async()=>{})
    assert.deepEqual(unconfirmedReads('mention'),{all:1,urgent:1})
  } finally {resetLocalReads()}
})
test('ordinary mail stays out and real urgent mail keeps its behavior',()=>{
  const plain=mail({mailbox_attention:undefined,body:'ordinary'})
  assert.equal(buildAttentionRows({slug:'mention',pending:[plain]}).length,0)
  assert.equal(buildAttentionRows({slug:'mention',pending:[{...plain,urgent:true,urgent_reason:'deadline'}]}).length,1)
})

const node=(blurb='Ready @user.')=>({id:'worker',state:'live',user_mention:{id:'um1',event_id:'e1',blurb,at:'2026-10-18T12:00:00Z'}} as TreeNode)
test('one mail replaces only its corresponding mention blurb',()=>{
  const rows=buildAttentionRows({slug:'mention',pending:[mail()],nodes:[node()]})
  assert.deepEqual(rows.map(r=>r.kind),['mail'])
  const unrelated=buildAttentionRows({slug:'mention',pending:[mail()],nodes:[node('Another question @user.')]})
  assert.deepEqual(unrelated.map(r=>r.kind).sort(),['mail','mention'])
})
test('a read or locally-read mail cannot resurrect its duplicate blurb',()=>{
  assert.equal(buildAttentionRows({slug:'mention',pending:[],representedMail:[mail()],nodes:[node()]}).length,0)
})
test('failed read restores mention mailbox attention',async()=>{
  resetLocalReads()
  try{
    await assert.rejects(markReadNow('mention',mail(),async()=>{throw Error('offline')}))
    assert.deepEqual(unconfirmedReads('mention'),{all:0,urgent:0})
  }finally{resetLocalReads()}
})
test('mention mail shares row emphasis without pretending to be urgent',async()=>{
  const view=await mountView(<MailList delivered={[mail()]} />,el=>el)
  try{
    assert.equal(view.el.querySelector('.mailrow')?.classList.contains('urgent'),true)
    assert.equal(view.el.querySelector('.urgentkind')===null,true)
  }finally{await view.unmount()}
})
