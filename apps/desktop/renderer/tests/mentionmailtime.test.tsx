import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mailRepresentsMention } from '../src/mailattention'
import { buildAttentionRows } from '../src/attention/feed'
import type { MailEntry, TreeNode } from '../src/types'

const mention = {id:'fresh',event_id:'e42',blurb:'Ready @user.',at:'2026-10-21T22:00:00Z'}
const node = {id:'worker',state:'live',user_mention:mention} as TreeNode
const mail = {id:'copy',from:'worker',body:'Ready @user.',at:'2026-10-21T22:00:03Z',kind:'message',mailbox_attention:true} as MailEntry

test('an old read mail cannot suppress a later independent mention with repeated prose', () => {
  const old = {...mail,at:'2026-10-20T10:00:00Z'}
  assert.equal(mailRepresentsMention(old,node),false)
  const rows=buildAttentionRows({slug:'mention-time',pending:[],representedMail:[old],nodes:[node]})
  assert.deepEqual(rows.map(r=>r.kind),['mention'])
})

test('the current mail copy at the measured fixture gap of three seconds represents its mention once', () => {
  assert.equal(Date.parse(mail.at)-Date.parse(mention.at),3000)
  assert.equal(mailRepresentsMention(mail,node),true)
  assert.deepEqual(buildAttentionRows({slug:'mention-time',pending:[mail],nodes:[node]}).map(r=>r.kind),['mail'])
  assert.equal(buildAttentionRows({slug:'mention-time',pending:[],representedMail:[mail],nodes:[node]}).length,0)
})

test('missing, malformed, earlier and distant timestamps keep the mention visible', () => {
  for(const at of ['', 'unknown', '2026-10-21T21:59:59.999Z', '2026-10-21T22:00:10.001Z', '2026-10-22T22:00:00Z']) {
    assert.equal(mailRepresentsMention({...mail,at},node),false,at)
  }
  assert.equal(mailRepresentsMention(mail,{...node,user_mention:{...mention,at:''}}),false)
})

test('the inclusive ten-second window accepts equivalent timezone timestamps', () => {
  for(const at of [mention.at,'2026-10-22T01:00:10+03:00']) {
    assert.equal(mailRepresentsMention({...mail,at},node),true,at)
  }
  assert.equal(mailRepresentsMention({...mail,from:'another'},node),false)
  assert.equal(mailRepresentsMention({...mail,body:'A different question @user.'},node),false)
})
