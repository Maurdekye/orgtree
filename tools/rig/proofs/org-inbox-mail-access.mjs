import { externalFixtureSender } from './fixtures/retained-inbox-upload.mjs'
import { Proof } from '../proof.mjs'
export function setup() {
  return { fixture: { org: { name: 'Retained hidden mail' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}
export default async function(rig) {
  const p = new Proof('org-inbox-mail-access')
  const A=rig.org
  await rig.op({op:'halt',nodes:['rhea']})
  const B=(await rig.api('POST','/api/orgs',{name:'Incoming sender',dirs:[],net_autoconnect:false})).slug
  const marker='HIDDEN_PENDING_OUTSIDE_MAIL_TEST_ONLY'
  await externalFixtureSender(rig,B,'@org:'+A,marker)
  const held=rig.one(`SELECT uid FROM ot.mail WHERE recipient_name='rhea' AND body='${marker}'`)
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:false})
  const history=await rig.api('GET',`/api/orgs/${A}/history/node-mail?node=rhea`)
  p.check('history collection control hides outside mail',!JSON.stringify(history).includes(marker))
  const manual=await rig.tool('rhea','orgtree_inbox',{action:'fetch',message_ids:[held.uid]})
  p.check('manual known-id control hides outside mail',!JSON.stringify(manual).includes(marker))
  // Fill more than one page with hidden pending and delivering copies. The
  // visible internal control comes last, so post-LIMIT filtering cannot pass.
  rig.exec(`INSERT INTO ot.mail(uid,org_id,recipient_kind,recipient_agent_id,recipient_name,sender,body,kind,state,ev,attachments)
    SELECT 'hidden-fixture-'||g,m.org_id,m.recipient_kind,m.recipient_agent_id,m.recipient_name,m.sender,m.body,m.kind,
      CASE WHEN g%2=0 THEN 'pending' ELSE 'delivering' END,
      '{"variant":"fixture.hidden","body":"HIDDEN_EVENT"}'::jsonb,
      '[{"name":"HIDDEN_ATTACHMENT","path":"fixture-only"}]'::jsonb
    FROM ot.mail m CROSS JOIN generate_series(1,205) g WHERE m.uid='${held.uid}'`)
  const internal=await rig.userMail('rhea','VISIBLE_INTERNAL_CONTROL')
  const chat=await rig.api('GET',`/api/orgs/${A}/nodes/rhea/chat`)
  p.check('desk pending_mail hides retained outside mail',!JSON.stringify(chat.pending_mail).includes(marker),
    {mail_pending:chat.mail_pending,pending_mail:chat.pending_mail})
  p.check('desk count and page filter hidden pending/delivering before limit',
    chat.mail_pending===1 && chat.pending_mail.length===1 && JSON.stringify(chat.pending_mail).includes('VISIBLE_INTERNAL_CONTROL') &&
    !JSON.stringify(chat.pending_mail).includes('HIDDEN_'),{count:chat.mail_pending,visible:chat.pending_mail.length})
  let quote
  try { quote=await rig.api('POST',`/api/orgs/${A}/nodes/rhea/message`,
    {text:'New internal mail quoting hidden source',target:{kind:'mail',id:held.uid,box:'node',node:'rhea'}}) }
  catch(e) { quote={status:e.status} }
  const newMail=rig.one("SELECT reply_to FROM ot.mail WHERE body='New internal mail quoting hidden source'")
  p.check('new reply cannot read and copy hidden outside quote',quote.status===404 && newMail===null,{quote,newMail})
  const internalUid=rig.one("SELECT uid FROM ot.mail WHERE body='VISIBLE_INTERNAL_CONTROL'").uid
  await rig.api('POST',`/api/orgs/${A}/nodes/rhea/message`,{text:'Internal quote control',target:{kind:'mail',id:internalUid}})
  p.check('new internal quote remains usable while disabled',JSON.stringify(rig.one("SELECT reply_to FROM ot.mail WHERE body='Internal quote control'")).includes('VISIBLE_INTERNAL_CONTROL'))
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:true})
  await rig.api('POST',`/api/orgs/${A}/nodes/rhea/message`,{text:'Restored external quote',target:{kind:'mail',id:held.uid}})
  p.check('re-enable restores new quote lookup',JSON.stringify(rig.one("SELECT reply_to FROM ot.mail WHERE body='Restored external quote'")).includes(marker))
  p.check('re-enable restores original mailbox source',(await rig.tool('rhea','orgtree_inbox',
    {action:'fetch',message_ids:[held.uid]})).text.includes(marker))
  p.keep(rig,{grep:/HIDDEN_PENDING|New internal|inbox is disabled/})
  return p.summary()
}
