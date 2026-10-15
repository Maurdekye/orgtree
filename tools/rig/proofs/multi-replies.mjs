// Scratch engine/fake CLI only. Existing rig hub seam uses the production
// payload builder and inbound publication, without a real hub or paid CLI.
import { Proof } from '../proof.mjs';
export async function setup() {
  return {recover:true,fixture:{org:{name:'Multi reply proof'},agents:[{name:'writer',tier:'luna',grant:4}],scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}}}};
}
export default async function(rig) {
  const p=new Proof('multi-replies');
  const sqlQuote=s=>String(s).replaceAll("'","''");
  const hub=(op,args={})=>rig.api('POST','/api/rig/hub-mail',{org:rig.org,op,...args});
  await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'seed settle',timeout:60000});
  await rig.userMail('writer','FIRST source',{notice:true});await rig.userMail('writer','SECOND source',{notice:true});
  const ids=rig.sql("SELECT uid FROM ot.mail WHERE body IN ('FIRST source','SECOND source') ORDER BY id").map(r=>r.uid);
  const reply=await rig.tool('writer','orgtree_message',{metadata:{to:'user',reply_to:ids[0],replies:ids},body:'Both answered'});
  const stored=rig.one("SELECT uid,reply_to,replies FROM ot.mail WHERE body='Both answered'");
  p.check('tool sends one reply with both authoritative snapshots',reply.ok && stored?.replies?.map(q=>q.id).join()===ids.join() && stored.reply_to.id===ids[0],stored);
  const mismatch=await rig.tool('writer','orgtree_message',{metadata:{to:'user',reply_to:ids[1],replies:ids},body:'REFUSED mismatch'});
  const invalid=await rig.tool('writer','orgtree_message',{metadata:{to:'user',replies:[ids[0],'missing-id']},body:'REFUSED unavailable'});
  p.check('first mismatch and inaccessible target refuse before any admission',!mismatch.ok&&!invalid.ok&&rig.sql("SELECT id FROM ot.mail WHERE body LIKE 'REFUSED%'").length===0);
  const own=stored?.uid;
  const mixedRefs=[ids[0],own];
  const mixed=own ? await rig.tool('writer','orgtree_message',{metadata:{to:'user',replies:mixedRefs},body:'Mixed direction answer'}) : {ok:false};
  const mixedRows=rig.sql("SELECT recipient_name,replies FROM ot.mail WHERE body='Mixed direction answer'");
  // Tool input accepts "user"; persisted user-recipient names are "@user".
  p.check('mixed authors in one conversation keep all references and one recipient',mixed.ok&&mixedRows.length===1&&mixedRows[0].recipient_name==='@user'&&mixedRows[0].replies.map(q=>q.id).join()===mixedRefs.join(),{mixed:mixed.text,mixedRows});
  const fanout=await rig.tool('writer','orgtree_message',{metadata:{to:['user','writer'],replies:ids},body:'REFUSED fanout'});
  p.check('multi-reply never fans out to several recipients',!fanout.ok&&/one recipient/.test(fanout.text||'')&&rig.sql("SELECT id FROM ot.mail WHERE body='REFUSED fanout'").length===0,fanout.text);
  const fetched=own ? await rig.tool('writer','orgtree_inbox',{action:'fetch',message_ids:[own]}) : {};
  p.check('fetch preserves every reply reference',fetched.json?.messages?.[0]?.replies?.length===2,fetched.json);
  const conversation=await rig.tool('writer','orgtree_inbox',{action:'conversation',peer:'user'});
  p.check('conversation preserves plural context',conversation.json?.messages?.find(m=>m.id===own)?.replies?.length===2);
  // A second scratch organization exercises the real local @org publication.
  const other=(await rig.api('POST','/api/orgs',{name:'Multi other',dirs:[],net_autoconnect:false})).slug;
  await rig.op({op:'hire',name:'receiver',tier:'luna',grant:4},{org:other});
  for(const body of ['Local source one','Local source two']) await rig.tool('writer','orgtree_message',{metadata:{to:'@org:'+other},body});
  const localRefs=rig.sql(`SELECT uid FROM ot.mail WHERE sender='@org:${sqlQuote(rig.org)}' AND body IN ('Local source one','Local source two') ORDER BY id`).map(r=>r.uid);
  const local=await rig.tool('receiver','orgtree_message',{metadata:{to:'@org:'+rig.org,replies:localRefs},body:'Local plural reply'},{org:other});
  const localInbox=rig.one("SELECT replies FROM ot.org_inbox WHERE dir='in' AND body='Local plural reply'");
  const localCopy=rig.one("SELECT replies FROM ot.mail WHERE body='Local plural reply'");
  p.check('local @org send/receive and holder copy preserve both quotes',local.ok && localInbox?.replies?.length===2 && localCopy?.replies?.length===2,{local:local.text,localInbox,localCopy});
  const id=rig.agentRow('writer').id;
  await rig.userMail('writer','WAKE snapshot control');
  await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'wake settles',timeout:60000});
  const wire=await hub('outgoing',{body:'Hub reply text',replies:[{net_id:'remote-q1',from:'peer',gist:'Question one'},{net_id:'remote-q2',from:'peer',gist:'Question two'}]});
  p.check('hub payload keeps first and all references plus old-client text',wire.reply_to==='remote-q1'&&wire.meta?.replies?.join()==='remote-q1,remote-q2'&&wire.body==='> Question one\n> Question two\nHub reply text',wire);
  const originals=rig.sql("SELECT net_id FROM ot.org_inbox WHERE body='Hub reply text' ORDER BY id DESC LIMIT 1");
  const first=originals[0]?.net_id;
  const secondWire=await hub('outgoing',{body:'Second hub source'});
  const refs=[first,secondWire.id];
  await rig.op({op:'halt',nodes:['writer']});
  await hub('inbound',{id:'multi-in',body:'Inbound reply to both',reply_to:first,meta:{replies:refs}});
  const incoming=rig.one("SELECT replies,reply_to FROM ot.org_inbox WHERE dir='in' AND net_id='multi-in'");
  const copy=rig.one(`SELECT uid,replies,reply_to FROM ot.mail WHERE recipient_agent_id=${id} AND net_id='multi-in'`);
  p.check('incoming persists both inbox and holder references',incoming?.replies?.length===2&&copy?.replies?.length===2,{incoming,copy});
  const repeat=await hub('inbound',{id:'multi-in',body:'Duplicate must not replace',reply_to:first,meta:{replies:refs}});
  p.check('duplicates create no new holder copies or reverse links',repeat.fresh===false&&rig.sql("SELECT uid FROM ot.mail WHERE net_id='multi-in'").length===1&&rig.sql("SELECT target FROM ot.reply_links WHERE box='org' AND message_uid IN (SELECT uid FROM ot.org_inbox WHERE net_id='multi-in')").length===2);
  await hub('inbound',{id:'bad-in',body:'Malformed extra refs',reply_to:first,meta:{replies:[secondWire.id,first]}});
  p.check('bad incoming first-reference match falls back to legacy first only',rig.one("SELECT replies FROM ot.org_inbox WHERE dir='in' AND net_id='bad-in'")?.replies?.length===1);
  await rig.op({op:'unhalt',nodes:['writer']});
  await rig.waitFor(()=>rig.one("SELECT state FROM ot.mail WHERE net_id='multi-in'")?.state==='delivered',{what:'holder consumes multi mail',timeout:60000});
  const prompt=rig.fakeLog('writer').map(l=>l.prompt||l.text||'').find(t=>t.includes('Inbound reply to both'))||'';
  p.check('harness displays every IN REPLY TO block',prompt.split('IN REPLY TO').length>=3&&prompt.includes('Hub reply text')&&prompt.includes('Second hub source'),prompt.slice(-1800));
  const record=await rig.api('GET',`/api/orgs/${rig.org}/nodes/writer/chat`);
  p.check('transcript projects both references',JSON.stringify(record).includes('Second hub source')&&JSON.stringify(record).includes('replies'));
  const count=rig.sql(`SELECT target FROM ot.reply_links WHERE box='mail' AND message_uid='${sqlQuote(copy?.uid||'')}'`).length;
  p.check('reverse lookup indexed membership holds each target',count===2,count);
  // Operator plural refs resolve sender and visible quote from immutable data.
  await rig.op({op:'halt',nodes:['writer']});
  rig.exec(`INSERT INTO ot.convo(agent_id,seq,ver,body) VALUES (${id},90001,90001,'{"role":"assistant","text":"Desk first"}'),(${id},90002,90002,'{"role":"user","text":"Desk second"}')`);
  const generation=rig.one(`SELECT generation FROM ot.agents WHERE id=${id}`).generation;
  const event=id=>({source_event_ref:{org:rig.org,agent:'writer',generation,eventId:id},quoted_context:'Spoofed text'});
  await rig.op({op:'halt',nodes:['writer']});
  const desk=await rig.api('POST',`/api/orgs/${rig.org}/nodes/writer/message`,{text:'Desk both',replies:[event('e90001'),event('e90002')]});
  const deskRows=rig.sql("SELECT recipient_name,replies FROM ot.mail WHERE body='Desk both'");
  const deskRow=deskRows[0];
  p.check('operator mixed authors resolve all quotes and deliver only to the transcript agent',desk.accepted && deskRows.length===1&&deskRow.recipient_name==='writer'&&deskRow.replies.map(q=>q.quoted_context).join()==='Desk first,Desk second',deskRow);
  let refused=false;try {await rig.api('POST',`/api/orgs/${rig.org}/nodes/writer/message`,{text:'REFUSED foreign event',replies:[event('e90001'),{...event('e90002'),source_event_ref:{...event('e90002').source_event_ref,org:other}}]})}catch(e){refused=true}
  p.check('operator rejects cross-org event before admission',refused && rig.sql("SELECT id FROM ot.mail WHERE body='REFUSED foreign event'").length===0);
  await rig.op({op:'hire',name:'neighbour',tier:'luna',grant:4});
  const neighbour=rig.agentRow('neighbour');
  const neighbourGeneration=rig.one(`SELECT generation FROM ot.agents WHERE id=${neighbour.id}`).generation;
  rig.exec(`INSERT INTO ot.convo(agent_id,seq,ver,body) VALUES (${neighbour.id},90003,90003,'{"role":"assistant","text":"Other transcript"}')`);
  let crossTranscript=false;try {await rig.api('POST',`/api/orgs/${rig.org}/nodes/writer/message`,{text:'REFUSED other transcript',replies:[event('e90001'),{...event('e90003'),source_event_ref:{...event('e90003').source_event_ref,agent:'neighbour',generation:neighbourGeneration}}]})}catch(e){crossTranscript=true}
  p.check('operator refuses a valid event from a different transcript',crossTranscript&&rig.sql("SELECT id FROM ot.mail WHERE body='REFUSED other transcript'").length===0);
  await rig.tool('neighbour','orgtree_message',{metadata:{to:'user'},body:'OTHER transcript inbox mail'});
  const foreignMail=rig.one("SELECT uid FROM ot.mail WHERE body='OTHER transcript inbox mail'").uid;
  let crossMailbox=false;try {await rig.api('POST',`/api/orgs/${rig.org}/nodes/writer/message`,{text:'REFUSED other mailbox',targets:[own,foreignMail].map(id=>({kind:'mail',org:rig.org,box:'user',id}))})}catch(e){crossMailbox=true}
  p.check('mailbox targets cannot import another transcript through the user inbox',crossMailbox&&rig.sql("SELECT id FROM ot.mail WHERE body='REFUSED other mailbox'").length===0);
  const aggregate={role:'user',text:'HIDDEN envelope',segments:[{kind:'state',text:'HIDDEN state'},{kind:'mail',rows:[{id:'aggregate-a',from:'first',body:'First author'},{id:'aggregate-b',from:'second',body:'Second author'}]}]};
  rig.exec(`INSERT INTO ot.convo(agent_id,seq,ver,body) VALUES (${id},90004,90004,'${sqlQuote(JSON.stringify(aggregate))}')`);
  await rig.api('POST',`/api/orgs/${rig.org}/nodes/writer/message`,{text:'Aggregate reply',replies:[event('e90001'),event('e90004')]});
  const aggregateReply=rig.one("SELECT recipient_name,replies FROM ot.mail WHERE body='Aggregate reply'");
  // event_context preserves paragraph breaks; HTTP snapshots use gist(text,4000),
  // which intentionally collapses whitespace without changing the source event.
  p.check('a multi-author delivered turn can be quoted with other transcript events',aggregateReply?.recipient_name==='writer'&&aggregateReply.replies[1].quoted_context==='First author Second author'&&!JSON.stringify(aggregateReply.replies).includes('HIDDEN'),aggregateReply);
  await rig.tool('neighbour','orgtree_message',{metadata:{to:'writer',notice:true},body:'NEIGHBOUR source'});
  const neighbourMail=rig.one("SELECT uid FROM ot.mail WHERE body='NEIGHBOUR source'").uid;
  const mailTarget=id=>({source_event_ref:{org:rig.org,agent:'writer',generation,eventId:'mail:'+id},mail_id:id,quoted_context:'Spoofed envelope'});
  await rig.api('POST',`/api/orgs/${rig.org}/nodes/writer/message`,{text:'Desk mail cards',replies:[ids[0],neighbourMail].map(mailTarget)});
  const mailCards=rig.one("SELECT replies FROM ot.mail WHERE body='Desk mail cards'");
  p.check('desk mail cards from different authors preserve every sender and quote',mailCards?.replies?.map(q=>q.quoted_context).join()==='FIRST source,NEIGHBOUR source' && mailCards.replies.map(q=>q.sender).join()==='@user,neighbour',mailCards);
  p.keep(rig,{agents:['writer'],grep:/multi|reply/});return p.summary();
}
