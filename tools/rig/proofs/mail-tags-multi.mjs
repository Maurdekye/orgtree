// Isolated engine/SQL proof. No live profiles, mailboxes or accounts.
import { Proof } from '../proof.mjs'
export default async function(rig){
  const p=new Proof('mail-tags-multi'),lit=s=>`'${String(s).replaceAll("'","''")}'`
  const org=rig.one(`SELECT id FROM ot.orgs WHERE slug=${lit(rig.org)}`).id
  const send=(body,tags)=>rig.tool('boss','orgtree_message',{metadata:{to:'user',tags},body})
  const both=await send('old-both',['Alpha Build','Progress'])
  const only=await send('old-only',['Alpha Build'])
  const gone=await send('old-delete',['DeleteOnly'])
  p.check('tagged setup is admitted',both.ok&&only.ok&&gone.ok)
  const deleted=rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND body='old-delete'`).uid
  rig.exec(`UPDATE ot.mail SET state='read' WHERE org_id=${org} AND recipient_kind='user';
    INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state)
      SELECT 'multi-both-'||g,${org},'boss','user','@user','message','both '||g,'read' FROM generate_series(1,205) g;
    INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal)
      SELECT id,org_id,'alpha build',0 FROM ot.mail WHERE org_id=${org} AND uid LIKE 'multi-both-%';
    INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal)
      SELECT id,org_id,'progress',1 FROM ot.mail WHERE org_id=${org} AND uid LIKE 'multi-both-%';
    INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state)
      SELECT 'multi-only-'||g,${org},'boss','user','@user','message','only '||g,'read' FROM generate_series(1,300) g;
    INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal)
      SELECT id,org_id,'alpha build',0 FROM ot.mail WHERE org_id=${org} AND uid LIKE 'multi-only-%';
    INSERT INTO ot.mail_tags(org_id,key,label) SELECT ${org},'catalog-'||lpad(g::text,3,'0'),'Catalog-'||lpad(g::text,3,'0') FROM generate_series(1,225) g;
    INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_name,kind,body,state)
      SELECT 'catalog-mail-'||g,${org},'boss','user','@user','message','catalog '||g,'read' FROM generate_series(1,225) g;
    INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal)
      SELECT m.id,m.org_id,'catalog-'||lpad(substring(m.uid from 14)::int::text,3,'0'),0 FROM ot.mail m WHERE m.org_id=${org} AND m.uid LIKE 'catalog-mail-%';
    INSERT INTO ot.mail_tags(org_id,key,label) VALUES(${org},'orphan-unused','Orphan unused')`)
  const filter=(tags,before)=>rig.api('POST',`/api/orgs/${rig.org}/inbox/filter`,{tags,before})
  const ids=box=>[...box.pending,...box.delivered].map(m=>m.id)
  const one=await filter(['ALPHA BUILD','progress','Alpha Build'])
  const two=await filter(['progress','alpha build'],one.next_cursor)
  p.check('AND is applied before the bounded window and duplicate selection cannot duplicate mail',ids(one).length===200&&!!one.next_cursor
    &&[...one.pending,...one.delivered].every(m=>m.tags.includes('Alpha Build')&&m.tags.includes('Progress')))
  p.check('AND cursor pages are disjoint and reach the older retained match',ids(two).length===6&&ids(two).every(id=>!ids(one).includes(id))
    &&two.delivered.some(m=>m.body==='old-both'),{first:ids(one).length,next:ids(two).length})
  const many=await filter(Array.from({length:20},(_,i)=>`valid-${i}`))
  p.check('more than eight checked tags is valid and correctly has no matching mail',ids(many).length===0)
  let bad=null
  try{await filter(['Alpha Build',''])}catch(e){bad=e.status}
  p.check('invalid later selections are rejected',bad===400,{status:bad})
  const all=[],cursors=[];let after
  do{
    const page=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tags_only=true${after?`&after=${encodeURIComponent(after)}`:''}`)
    p.check(`used-tag page ${cursors.length+1} is bounded`,page.tag_choices.length<=200)
    all.push(...page.tag_choices);after=page.next_tag_cursor
    if(after){if(cursors.includes(after))throw new Error('catalog cursor repeated');cursors.push(after)}
  }while(after)
  p.check('catalog reaches all used tags beyond 200 and excludes unused dictionary rows',all.length===228&&new Set(all).size===228&&!all.includes('Orphan unused')&&all.includes('Catalog-225'),{count:all.length,pages:cursors.length+1})
  const search=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tags_only=true&prefix=log-225`)
  p.check('zero-match search page still returns a cursor for later matching keys',search.tag_choices.length===0&&!!search.next_tag_cursor)
  const searched=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tags_only=true&prefix=log-225&after=${encodeURIComponent(search.next_tag_cursor)}`)
  p.check('manual search is substring/case-insensitive on later pages',searched.tag_choices.join()==='Catalog-225')
  await send('publish seeded mail',[])
  const snapshot=async()=>rig.api('GET',`/api/orgs/${rig.org}/records`)
  const marker=s=>s.records?.find(r=>r.entity==='org'&&r.id==='user_mail_revision')?.body?.revision
  const visible=s=>s.records.filter(r=>r.entity==='user_inbox'||r.entity==='user_mail_log:shared').map(r=>r.id).sort().join()
  const before=await rig.waitFor(async()=>{const s=await snapshot();return marker(s)?s:null},{timeout:10000,what:'initial mail-change revision'})
  p.check('delete target is outside the bounded feed window',!before.records.some(r=>r.body?.id===deleted))
  const removed=await rig.api('DELETE',`/api/orgs/${rig.org}/inbox/${encodeURIComponent(deleted)}`)
  const afterDelete=await rig.waitFor(async()=>{const s=await snapshot();return marker(s)&&marker(s)!==marker(before)?s:null},{timeout:10000,what:'Delete to UserMail to revision'})
  p.check('Delete bumps mail revision even when bounded visible mail is unchanged',removed.deleted&&marker(afterDelete)!==marker(before)&&visible(afterDelete)===visible(before),{before:marker(before),after:marker(afterDelete)})
  const choices=await rig.api('GET',`/api/orgs/${rig.org}/inbox?tags_only=true`)
  p.check('last-use deletion removes its tag from used choices',!choices.tag_choices.includes('DeleteOnly'))
  p.keep(rig);return p.summary()
}
