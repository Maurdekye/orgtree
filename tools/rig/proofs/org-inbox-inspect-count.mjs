import { Proof } from '../proof.mjs';
export function setup() { return { fixture: { org: {name:'Inspection isolation'}, agents:[{name:'rhea',tier:'luna',grant:4}], scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}} } }; }
export default async function(rig) {
  const p=new Proof('org-inbox-inspect-count');
  const A=rig.org;
  await rig.op({op:'halt',nodes:['rhea']});
  const B=(await rig.api('POST','/api/orgs',{name:'Synthetic sender',dirs:[],net_autoconnect:false})).slug;
  const inspect=async()=>{const r=await rig.tool('rhea','orgtree_state_inspect',{node:'rhea'}); if(!r.ok) throw new Error(r.text); return r.json.nodes[0].mail_waiting;};
  p.check('empty initial count',await inspect()===0);
  await rig.api('POST',`/api/orgs/${B}/org_inbox/send`,{to:'@org:'+A,body:'SYNTHETIC_OUTSIDE_COUNT'});
  p.check('enabled external count control',await inspect()===1);
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:false});
  const chat=await rig.api('GET',`/api/orgs/${A}/nodes/rhea/chat`);
  const hidden=await inspect();
  p.check('disabled desk control filters count',chat.mail_pending===0 && chat.pending_mail.length===0,{desk:chat.mail_pending});
  p.check('inspection must not expose hidden outside count',hidden===0,{inspection:hidden,desk:chat.mail_pending});
  await rig.userMail('rhea','SYNTHETIC_INTERNAL_COUNT');
  const mixed=await inspect();
  p.check('inspection counts visible internal only while disabled',mixed===1,{inspection:mixed});
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:true});
  p.check('re-enable restores retained count',await inspect()===2);
  // State inspection deliberately counts pending only (unlike desk unread).
  rig.exec("UPDATE ot.mail SET state='delivering' WHERE body='SYNTHETIC_OUTSIDE_COUNT'");
  p.check('delivering external remains excluded from pending count while enabled',await inspect()===1);
  rig.exec("UPDATE ot.mail SET state='delivering' WHERE body='SYNTHETIC_INTERNAL_COUNT'");
  p.check('delivering internal remains excluded from pending count',await inspect()===0);
  // Failure notices have system senders but belong to the outside boundary too.
  rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,ev,extra)
    SELECT 'fixture-failure-'||g,m.org_id,'@system',m.recipient_kind,m.recipient_agent_id,m.recipient_name,
      'SYNTHETIC_FAILURE_COUNT','pending',
      CASE WHEN g=1 THEN '{"variant":"runtime.external_unroutable"}'::jsonb ELSE '{}'::jsonb END,
      CASE WHEN g=2 THEN '{"transfer_failure":"fixture"}'::jsonb ELSE '{}'::jsonb END
    FROM ot.mail m CROSS JOIN generate_series(1,2) g WHERE m.body='SYNTHETIC_INTERNAL_COUNT'`);
  p.check('enabled failure notices count control',await inspect()===2);
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:false});
  p.check('both outside failure notice forms hidden while disabled',await inspect()===0);
  await rig.userMail('rhea','SECOND_INTERNAL_PENDING');
  p.check('new user mail still counts amid hidden failure notices',await inspect()===1);
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:true});
  p.check('re-enable restores pending failure counts without delivering rows',await inspect()===3);
  return p.summary();
}
