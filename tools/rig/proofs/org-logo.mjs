// Autonomous Logo through the real engine; synthetic PostgreSQL/fake CLIs and
// optionally the rig's own hosted hub. Never a live identity or real message.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { Proof } from '../proof.mjs'

export function setup(flags) { return { hub:flags.hub??true,fixture:{org:{name:'Autonomous Logo'},agents:[
  {name:'boss',grant:20}, {name:'alice',parent:'boss',grant:0,tools:{orgtree:{user:false,team:false}}},
]}} }
function chunk(name,bytes) {
  const type=Buffer.from(name),n=Buffer.alloc(4),sum=Buffer.alloc(4)
  let c=0xffffffff
  for(const b of Buffer.concat([type,bytes])) {c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}
  n.writeUInt32BE(bytes.length);sum.writeUInt32BE((c^0xffffffff)>>>0)
  return Buffer.concat([n,type,bytes,sum])
}
function png(color=0) {
  const h=Buffer.alloc(13);h.writeUInt32BE(6);h.writeUInt32BE(2,4);h[8]=8;h[9]=6
  const rows=Buffer.alloc(2*(1+6*4))
  for(let y=0;y<2;y++)for(let x=0;x<6;x++) {
    const at=y*25+1+x*4;rows[at+((Math.floor(x/2)+color)%3)]=255;rows[at+3]=255
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])
}

export default async function(rig) {
  const p=new Proof('org-logo'), org=rig.org
  const orgId=rig.one(`SELECT id FROM ot.orgs WHERE slug='${org}'`).id
  const route=`/api/orgs/${org}/profile-picture`
  const scratch=rig.agentRow('alice').scratch_dir||path.join(rig.data,'scratch',org,'alice')
  fs.mkdirSync(scratch,{recursive:true})
  const image=path.join(scratch,'logo.png'),other=path.join(scratch,'other.png')
  const raw=png(),rawOther=png(1);fs.writeFileSync(image,raw);fs.writeFileSync(other,rawOther)
  const logo=(args,agent='alice')=>rig.tool(agent,'orgtree_org_logo',args)
  const get=async()=> (await rig.api('GET',route)).picture
  const history=()=>rig.api('GET',`/api/orgs/${org}/undo-history`)
  const step=(dir,id)=>rig.api('POST',`/api/orgs/${org}/undo-history/${dir}`,{id})
    .then(json=>({ok:true,json}),e=>({ok:false,status:e.status,json:e.body,text:e.message}))
  const n=()=>rig.one(`SELECT count(*)::int n FROM ot.undo_entries WHERE org_id=${orgId} AND kind='logo'`).n
  const unchanged=async(before,count)=>JSON.stringify(await get())===JSON.stringify(before)&&n()===count
  const first=await logo({action:'set',path:'logo.png'})
  p.check('default-on subordinate without user audience can set its org Logo',first.ok,first.ok?first.json:first.text)
  if(!first.ok) {
    p.note('Remaining dependent checks NOT EXECUTED: initial tool unavailable/refused. Exact base d4b0889 should fail this named red control.')
    return p.summary()
  }
  const saved=await get(),firstId=first.json.history_entry.id
  p.check('tool returns metadata and one Logo history entry, never bytes',first.json.history_entry.kind==='logo'&&!('data' in first.json)&&first.json.revision===saved.revision)
  p.check('native input becomes the bounded normalized square',saved.width===2&&saved.height===2&&saved.bytes<=256*1024
    &&saved.sha256===crypto.createHash('sha256').update(Buffer.from(saved.data,'base64')).digest('hex'))
  const entry=rig.one(`SELECT data,created_at,label FROM ot.undo_entries WHERE id=${firstId}`)
  p.check('journal binds numeric caller, timestamp and set label',entry.data.agent===rig.agentRow('alice').id&&!!entry.created_at&&entry.label==='Set Logo: alice')
  let firstStep=await step('undo',firstId)
  p.check('undo of first-ever Logo restores a versioned removal',firstStep.ok&&(await get()).data===null&&(await get()).revision>saved.revision)
  firstStep=await step('redo',firstId)
  p.check('redo of first-ever Logo restores normalized bytes',firstStep.ok&&(await get()).sha256===saved.sha256)
  const ui=await rig.api('POST',route,{owner:orgId,data:raw.toString('base64'),crop:{x:.5,y:.5,size:1}})
  p.check('default tool crop matches the human editor centre square',ui.sha256===saved.sha256)
  const stale=await step('undo',firstId)
  p.check('later human edit refuses stale undo without overwriting newer revision',!stale.ok&&stale.status===409&&stale.json.code==='history_conflict'&&(await get()).revision===ui.revision)

  // A pair of different images, then undo both and redo both. Revision rebinding
  // must preserve consecutive history while every restoration mints a revision.
  const a=await logo({action:'set',path:image,crop:{x:0,y:0,size:1}}),pa=await get()
  const b=await logo({action:'set',path:other}),pb=await get()
  p.check('a second agent edit keeps distinct increasing revisions',a.ok&&b.ok&&pb.revision>pa.revision&&pa.sha256!==pb.sha256)
  let r=await step('undo',b.json.history_entry.id), restored=await get()
  p.check('undo restores previous image with a fresh greater revision',r.ok&&restored.sha256===pa.sha256&&restored.revision>pb.revision)
  r=await step('undo',a.json.history_entry.id)
  p.check('consecutive older Logo undo works after revision rebinding',r.ok&&(await get()).sha256===ui.sha256)
  r=await step('redo',a.json.history_entry.id)
  const redoA=await get()
  p.check('redo restores the first image',r.ok&&redoA.sha256===pa.sha256)
  r=await step('redo',b.json.history_entry.id)
  p.check('consecutive newer Logo redo works and advances revision',r.ok&&(await get()).sha256===pb.sha256&&(await get()).revision>redoA.revision)
  const remove=await logo({action:'remove'}),removed=await get()
  p.check('remove stores canonical tombstone and a logged removal entry',remove.ok&&removed.data===null&&removed.sha256===null&&removed.width===0&&remove.json.history_entry.label==='Remove Logo: alice')
  r=await step('undo',remove.json.history_entry.id)
  p.check('removal undo restores full normalized image',r.ok&&(await get()).sha256===pb.sha256)
  r=await step('redo',remove.json.history_entry.id)
  p.check('removal redo restores tombstone with another newer revision',r.ok&&(await get()).data===null&&(await get()).revision>removed.revision)
  const h=await history()
  p.check('public history never contains image or before/after payloads',!JSON.stringify(h).includes(saved.data)&&!h.entries.some(e=>'data' in e||'before' in e||'after' in e))

  const marker='LOGO_INVALID_PRIVATE_'+crypto.randomBytes(12).toString('hex')
  const bad=path.join(scratch,'bad.png');fs.writeFileSync(bad,marker)
  const big=path.join(scratch,'big.png');fs.writeFileSync(big,Buffer.alloc(5*1024*1024+1))
  const outsideRoot=path.join(rig.dir,'ungranted');fs.mkdirSync(outsideRoot,{recursive:true})
  const outside=path.join(outsideRoot,'ungranted.png');fs.writeFileSync(outside,raw)
  for(const [name,folder] of [
    ['org shared',path.join(rig.data,'scratch',org,'_shared')],
    ['own team',path.join(rig.data,'scratch',org,'_teams',String(rig.agentRow('alice').id))],
    ['ancestor team',path.join(rig.data,'scratch',org,'_teams',String(rig.agentRow('boss').id))],
  ]) {
    fs.mkdirSync(folder,{recursive:true});const shared=path.join(folder,'logo.png');fs.writeFileSync(shared,raw)
    const accepted=await logo({action:'set',path:shared})
    p.check(name+' folder is a permitted source',accepted.ok)
  }
  let before=await get(),count=n()
  for(const [name,args] of [
    ['unsupported bytes',{action:'set',path:bad}],['oversized file',{action:'set',path:big}],
    ['invalid crop',{action:'set',path:image,crop:{x:2,y:0,size:1}}],
    ['directory',{action:'set',path:scratch}],
    ['cross-org selector',{action:'remove',org:'another'}],['ambiguous remove with file',{action:'remove',path:image}],
  ]) {
    const rejected=await logo(args)
    p.check(name+' is refused without picture or journal writes',!rejected.ok&&await unchanged(before,count),rejected.ok?rejected.json:undefined)
  }
  // Use valid image bytes and real files: these must reach the folder guard,
  // rather than pass because an image was missing or undecodable. Keep the
  // relative traversal unnormalized so the engine receives the actual `..`.
  const traversal=path.relative(scratch,outside)
  p.check('boundary fixtures name an existing valid image outside scratch',path.isAbsolute(outside)
    &&traversal.startsWith('..'+path.sep)&&fs.realpathSync(path.resolve(scratch,traversal))===fs.realpathSync(outside)
    &&fs.readFileSync(outside).equals(raw))
  for(const [name,source] of [['ungranted absolute file',outside],['relative parent traversal',traversal]]) {
    const rejected=await logo({action:'set',path:source})
    p.check(name+' is refused without picture or journal writes',!rejected.ok
      &&/outside your working folder and the folders you hold/.test(rejected.text)
      &&await unchanged(before,count),rejected.ok?rejected.json:rejected.text)
  }
  const scopes=(agent,tools)=>rig.api('POST',`/api/orgs/${org}/nodes/${agent}/scope`,{tools})
  await scopes('boss',{orgtree:{logo:false}})
  const denied=await logo({action:'remove'})
  p.check('ancestor denial blocks a remembered tool invocation',!denied.ok&&/disabled/.test(denied.text)&&await unchanged(before,count))
  await scopes('boss',{orgtree:{logo:true}})
  await scopes('alice',{orgtree:{logo:true,user:false,team:false}})
  const grantRoot=path.join(rig.dir,'read-only-grant');fs.mkdirSync(grantRoot,{recursive:true})
  const grantImage=path.join(grantRoot,'granted.png');fs.writeFileSync(grantImage,raw)
  await rig.api('POST',`/api/orgs/${org}/nodes/alice/scope`,{add_dirs:[{path:grantRoot,mode:'ro'}]})
  const granted=await logo({action:'set',path:grantImage})
  p.check('read-only granted folder is a valid source',granted.ok)
  const junction=path.join(scratch,'escape-junction')
  // Node's Windows junction creation uses no symlink privilege. Treat failure
  // as a failed fixture here, not an optional skip hiding an unexecuted case.
  fs.symlinkSync(outsideRoot,junction,'junction')
  try {
    const source=path.join('escape-junction','ungranted.png')
    p.check('junction fixture resolves to the valid ungranted image',fs.lstatSync(junction).isSymbolicLink()
      &&fs.realpathSync(path.join(scratch,source))===fs.realpathSync(outside))
    before=await get();count=n()
    const escape=await logo({action:'set',path:source})
    p.check('junction escape is refused without picture or journal writes',!escape.ok
      &&/outside your working folder and the folders you hold/.test(escape.text)
      &&await unchanged(before,count),escape.ok?escape.json:escape.text)
  } finally { fs.rmdirSync(junction) } // remove only the junction, never its target
  const symlink=path.join(scratch,'escape.png')
  let symlinkCreated=false
  try {fs.symlinkSync(outside,symlink);symlinkCreated=true} catch(e) {
    if(!['EPERM','EACCES','ENOSYS'].includes(e.code))throw e
    p.note('Symlink boundary skipped: '+e.code+'; NOT EXECUTED: fixture OS refused symlink creation')
  }
  if(symlinkCreated)try {
    before=await get();count=n()
    const escape=await logo({action:'set',path:'escape.png'})
    p.check('symlink escape to ungranted image is refused',!escape.ok
      &&/outside your working folder and the folders you hold/.test(escape.text)
      &&await unchanged(before,count))
  } finally { fs.unlinkSync(symlink) }
  // Hold the org lock with a synthetic uncommitted authority change. Admission
  // sees the old scope, commit waits, then must read the winning current scope.
  async function race(update,args) {
    const {port,password}=rig.pgConn(),app='org-logo-authority-race'
    const child=spawn(path.join(rig.run.pgBin,'psql.exe'),['-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','orgtree_admin','-d','orgtree_engine','-c',
      `BEGIN; SELECT id FROM ot.orgs WHERE id=${orgId} FOR NO KEY UPDATE; UPDATE ot.agents SET ${update} WHERE org_id=${orgId} AND name='alice'; SELECT pg_sleep(4); COMMIT;`],
      {windowsHide:true,env:{...process.env,PGPASSWORD:password,PGAPPNAME:app}})
    let errors='';child.stderr.on('data',b=>errors+=b);child.stdout.resume()
    const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code?reject(Error(errors)):resolve())})
    done.catch(()=>{})
    try {
      await rig.waitFor(()=>rig.one(`SELECT 1 ready FROM pg_stat_activity WHERE application_name='${app}' AND wait_event='PgSleep'`),{timeout:5000,what:'authority transaction holds org lock'})
      const started=logo(args)
      const waiting=await rig.waitFor(()=>rig.one(`SELECT 1 waiting FROM pg_stat_activity WHERE application_name<>'${app}' AND wait_event='transactionid' AND query LIKE '%ot.orgs%FOR NO KEY UPDATE%'`),
        {timeout:3000,every:50,what:'Logo mutation waits for winning authority change'}).then(()=>true,()=>false)
      const answer=await started
      return {answer,waiting}
    } finally {await done}
  }
  before=await get();count=n()
  let raced=await race("scope=jsonb_set(scope,'{tools,orgtree,logo}','false')",{action:'remove'})
  p.check('scope revoked after admission is rechecked after lock wait',raced.waiting&&!raced.answer.ok&&await unchanged(before,count))
  await scopes('alice',{orgtree:{logo:true,user:false,team:false}})
  before=await get();count=n()
  raced=await race("scope=jsonb_set(scope,'{add_dirs}','[]')",{action:'set',path:grantImage})
  p.check('folder revoked after read is rechecked before any mutation',raced.waiting&&!raced.answer.ok&&await unchanged(before,count))
  before=await get();count=n()
  raced=await race('generation=generation+1',{action:'remove'})
  p.check('generation changed after admission cannot commit a stale Logo edit',raced.waiting&&!raced.answer.ok&&await unchanged(before,count))
  before=await get();count=n()
  raced=await race("name='alice-renamed'",{action:'remove'})
  p.check('renamed stale caller cannot commit a Logo edit',raced.waiting&&!raced.answer.ok&&await unchanged(before,count))
  rig.exec(`UPDATE ot.agents SET name='alice' WHERE org_id=${orgId} AND name='alice-renamed'`)

  const concurrent=await Promise.all([logo({action:'set',path:image}),logo({action:'remove'})])
  const revisions=concurrent.map(c=>c.json?.revision).filter(Boolean).sort()
  p.check('concurrent tool edits serialize unique revisions and journal entries',concurrent.every(c=>c.ok)&&new Set(revisions).size===2&&(await get()).revision===revisions.at(-1))
  const last=await logo({action:'set',path:image}),oldLast=await get()
  // Journal persistence is a local scratch engine restart, not an app restart.
  await rig.restart()
  p.check('Logo journal and image survive engine restart',(await history()).undo.id===last.json.history_entry.id&&(await get()).revision===oldLast.revision)
  r=await step('undo',last.json.history_entry.id)
  p.check('undo remains usable after restart',r.ok&&(await get()).revision>oldLast.revision)
  await logo({action:'remove'})
  p.check('new Logo change clears redo in existing history',(await history()).redo===null)
  const logged=rig.engineLog()
  p.check('positive audit control includes Logo identity and action',logged.includes('organization Logo changed')&&logged.includes('alice')&&logged.includes('remove'))
  p.check('accepted and refused image bytes never enter engine logs',!logged.includes(marker)&&!logged.includes(raw.toString('base64'))&&!logged.includes(saved.data))

  // Reuse the hosted hub and publication path, respecting outside isolation.
  if(rig.hubUrl) {
    const settings=`/api/orgs/${org}/settings`
    await rig.api('POST',settings,{net_autoconnect:true})
    await rig.waitFor(async()=> (await rig.api('GET',`/api/orgs/${org}`)).net?.hubs?.some(h=>h.connected),{timeout:60000,what:'isolated org connects to rig hub'})
    const identity=rig.one(`SELECT net->'identity' identity FROM ot.orgs WHERE id=${orgId}`).identity
    const hub=async()=>{
      const response=await fetch(rig.hubUrl+'/api/profile-picture?slug='+encodeURIComponent(identity.slug),{headers:{'X-Org-Auth':identity.slug+':'+identity.secret},signal:AbortSignal.timeout(10000)})
      if(!response.ok)throw Error('fixture hub status '+response.status)
      return (await response.json()).picture
    }
    const published=await logo({action:'set',path:image})
    await rig.waitFor(async()=> (await hub())?.revision===published.json.revision,{timeout:50000,what:'agent Logo is published'})
    p.check('agent Logo reaches actual isolated hub',(await hub()).sha256===published.json.sha256)
    await rig.api('POST',settings,{org_inbox_enabled:false})
    const isolated=await logo({action:'remove'})
    await new Promise(resolve=>setTimeout(resolve,11000))
    p.check('outside isolation retains local tool edit without publishing',isolated.ok&&(await get()).data===null&&(await hub()).revision===published.json.revision)
    await rig.api('POST',settings,{org_inbox_enabled:true})
    await rig.waitFor(async()=> (await hub())?.revision===isolated.json.revision,{timeout:50000,what:'isolated removal converges after re-enable'})
    p.check('retained tool removal publishes after re-enable',(await hub()).data===null)
    r=await step('undo',isolated.json.history_entry.id)
    const restoredHub=await get()
    await rig.waitFor(async()=> (await hub())?.revision===restoredHub.revision,{timeout:50000,what:'Logo undo publishes fresh restored image'})
    p.check('undo uses same actual hub publisher and a fresh revision',r.ok&&(await hub()).sha256===published.json.sha256&&restoredHub.revision>isolated.json.revision)
  } else p.note('Hosted hub convergence NOT EXECUTED: run without rig hub')
  p.keep(rig,{grep:/Logo|profile-picture|history_conflict/})
  p.note('Native tool/store/history and isolated hub proof only. No installed app, device, real hub, real message or pixel acceptance claim.')
  return p.summary()
}
