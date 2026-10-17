// Synthetic engine/storage proof only: isolated DB and fake providers.
import { Proof } from '../proof.mjs'

export default async function(rig){
  const p=new Proof('mail-tags')
  const lit=s=>`'${String(s).replaceAll("'","''")}'`
  const org=rig.sql(`SELECT id FROM ot.orgs WHERE slug=${lit(rig.org)}`)[0].id
  const send=(body,tags,to='user',extra={})=>rig.tool('boss','orgtree_message',{metadata:{to,tags,...extra},body})
  const first=await send('tag-first',[' Alpha Build ','alpha build'])
  const second=await send('tag-second',['ALPHA BUILD'])
  p.check('two user deliveries accept normalized and duplicate tags',first.ok&&second.ok,{first,second})
  const firstId=rig.sql(`SELECT uid FROM ot.mail WHERE org_id=${org} AND body='tag-first'`)[0]?.uid
  const initial=await rig.api('GET',`/api/orgs/${rig.org}/inbox`)
  p.check('org dictionary preserves first committed spelling on both mails',
    ['tag-first','tag-second'].every(body=>initial.pending.find(m=>m.body===body)?.tags?.join() === 'Alpha Build'))
  const wrong=await send('tag-invalid-recipient',['Alpha Build'],'boss',{attachments:['missing-file']})
  p.check('non-user tags refuse before attachments or self-route checks',!wrong.ok&&wrong.text.includes('tags are only for mail to the user'),wrong)
  const mixed=await send('tag-mixed',['Alpha Build'],['user','boss'])
  p.check('mixed recipient send preserves tagged user success and non-user refusal',mixed.ok&&mixed.text.includes('1 of 2')&&mixed.text.includes('tags are only for mail to the user'),mixed)
  const eight=await send('tag-eight',Array.from({length:8},(_,i)=>`eight-${i}`))
  const nine=await send('tag-nine',Array.from({length:9},(_,i)=>`nine-${i}`))
  p.check('eight tags persist and nine refuse without creating a mail',eight.ok&&!nine.ok
    &&rig.sql(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id=${org} AND body='tag-nine'`)[0].n===0)
  const passive=await send('tag-notice',['Alpha Build'],'user',{notice:true})
  p.check('tagged passive mail uses the ordinary message notice path',passive.ok)
  rig.exec(`UPDATE ot.mail SET state='read' WHERE org_id=${org} AND body='tag-first';
    INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state)
    SELECT 'tag-filler-'||g,${org},'boss','user','@user','message','unrelated '||g,'read' FROM generate_series(1,250) g`)
  const ordinary=await rig.api('GET',`/api/orgs/${rig.org}/inbox`)
  const filtered=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tag=ALPHA%20BUILD`)
  p.check('tag query finds retained mail outside the ordinary archive window',
    !ordinary.delivered.some(m=>m.id===firstId)&&filtered.delivered.some(m=>m.id===firstId))
  const exact=await rig.api('GET',`/api/orgs/${rig.org}/mail/user/${firstId}`)
  p.check('exact-id reads carry the same durable tag labels',exact.mail?.tags?.join()==='Alpha Build',exact)
  const stored=rig.sql(`SELECT (SELECT count(*) FROM ot.mail_tags WHERE org_id=${org} AND key='alpha build')::int AS catalog,
    (SELECT count(*) FROM ot.mail m WHERE m.org_id=${org} AND (m.extra ? 'tags'))::int AS embedded`)[0]
  p.check('one normalized catalog key, no embedded tag lists',stored.catalog===1&&stored.embedded===0,stored)
  rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state)
    SELECT 'tag-page-'||g,${org},'boss','user','@user','message','page '||g,'read' FROM generate_series(1,205) g;
    INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal)
    SELECT id,org_id,'alpha build',0 FROM ot.mail WHERE org_id=${org} AND uid LIKE 'tag-page-%'`)
  const page1=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tag=alpha%20build`)
  const page2=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tag=alpha%20build&before=${page1.next_cursor}`)
  const ids=box=>[...box.pending,...box.delivered].map(m=>m.id)
  p.check('filtered cursor pages are bounded and disjoint across read/unread mail',ids(page1).length===200&&!!page1.next_cursor
    &&ids(page2).length>0&&ids(page2).every(id=>!ids(page1).includes(id)),{first:ids(page1).length,next:ids(page2).length})
  const concurrent=await Promise.all([send('tag-concurrent-a',['Concurrent A','Concurrent B']),send('tag-concurrent-b',['concurrent b','concurrent a'])])
  p.check('opposite tag order concurrently commits without duplicate dictionary keys',concurrent.every(r=>r.ok)
    &&rig.sql(`SELECT count(*)::int AS n FROM ot.mail_tags WHERE org_id=${org} AND key IN ('concurrent a','concurrent b')`)[0].n===2,concurrent)
  p.keep(rig)
  return p.summary()
}
