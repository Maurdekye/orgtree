// Human browser staging is retired. Verify retained legacy custody separately
// from new agent mail; no substitute human production send route is introduced.
import { Proof } from '../proof.mjs'
import { retainedInboxUpload } from './fixtures/retained-inbox-upload.mjs'
export function setup() { return { fixture: { org: { name: 'Read-only inbox' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }], scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } } }
export default async function(rig) {
  const p = new Proof('retired-human-inbox-compose'), org = rig.org
  await rig.op({ op: 'halt', nodes: ['rhea'] })
  const file = retainedInboxUpload(rig, org, 'accepted.txt', 'RETAINED_BYTES')
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug='${org}'`).id
  rig.exec(`INSERT INTO ot.org_inbox(uid,org_id,dir,peer,by_name,body,attachments,reply_to) VALUES('legacy-human-row',${orgId},'out','@org:legacy','user','LEGACY_HUMAN_BODY','${JSON.stringify([file]).replaceAll("'","''")}'::jsonb,'{"id":"old-reply","from":"@org:legacy","gist":"RETAINED_QUOTE"}'::jsonb)`)
  rig.exec(`INSERT INTO ot.upload_stages(id,org_id,name,path,total,state,received) VALUES('${file.id}',${orgId},'accepted.txt','${file.path.replaceAll("'","''")}',${file.bytes},'complete',${file.bytes})`)
  const before = rig.sql('SELECT uid,body,attachments,reply_to FROM ot.org_inbox ORDER BY id')
  for (const [method, suffix] of [['POST','send'],['POST','upload?name=new.txt'],['GET','upload_limit'],['POST','staging'],['GET','staging'],['GET','staging/'+file.id],['POST','staging/'+file.id],['DELETE','staging/'+file.id],['POST','staging/'+file.id+'/dismiss']]) {
    const result = await rig.api(method,`/api/orgs/${org}/org_inbox/${suffix}`,method==='GET' ? undefined : {to:'@net:fixture',body:'NEVER_SENT',name:'new.txt',bytes:3}).then(()=>({status:200}),e=>({status:e.status}))
    p.check(`retired ${method} ${suffix} returns 404`,result.status===404,result)
  }
  const list = JSON.stringify(await rig.api('GET',`/api/orgs/${org}/org_inbox`))
  p.check('retained human send, attachment metadata and quote remain readable',list.includes('LEGACY_HUMAN_BODY')&&list.includes('accepted.txt')&&list.includes('RETAINED_QUOTE'))
  const bytes = async () => { const r=await fetch(`${rig.url}/api/orgs/${org}/nodes/rhea/file?path=${encodeURIComponent(file.path)}`,{headers:{'X-Orgtree-Desktop-Token':rig.token}});return {status:r.status,text:await r.text()} }
  p.check('accepted staged bytes still download',(await bytes()).text==='RETAINED_BYTES')
  p.check('shared user-to-agent mail still sends',!!await rig.userMail('rhea','INTERNAL_CONTROL'))
  p.check('shared agent-to-user mail still sends',(await rig.tool('rhea','orgtree_message',{to:'user',body:'AGENT_CONTROL'})).ok)
  await rig.api('POST',`/api/orgs/${org}/settings`,{org_inbox_enabled:false})
  const hidden=await rig.api('GET',`/api/orgs/${org}/org_inbox`).then(()=>200,e=>e.status)
  p.check('disabled history and actual file owner remain enforced',hidden===403&&(await bytes()).status===403)
  await rig.api('POST',`/api/orgs/${org}/settings`,{org_inbox_enabled:true})
  p.check('re-enable restores accepted bytes and retained records',(await bytes()).text==='RETAINED_BYTES'&&JSON.stringify(rig.sql('SELECT uid,body,attachments,reply_to FROM ot.org_inbox ORDER BY id'))===JSON.stringify(before))
  p.check('no refused attempt resurrected or completed upload deleted',!rig.one("SELECT uid FROM ot.org_inbox WHERE body='NEVER_SENT'")&&rig.one(`SELECT state FROM ot.upload_stages WHERE id='${file.id}'`).state==='complete')
  p.keep(rig,{grep:/org_inbox|NEVER_SENT/})
  return p.summary()
}
