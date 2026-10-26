// Assigned slice2 real-PG proof: synthetic files and fake CLIs only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
const fixture=path.join(process.env.ORGTREE_RIG_HOME,'write-fixture'),folder=path.join(fixture,'chosen'),outside=path.join(fixture,'outside')
export function setup(){
  fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(outside,{recursive:true});fs.writeFileSync(path.join(folder,'existing.txt'),'old');fs.writeFileSync(path.join(outside,'outside.txt'),'outside')
  return{fixture:{org:{name:'App folder and confirmed write proof'},agents:[{name:'writer',tier:'sol',grant:0,add_dirs:[{path:folder,mode:'rw'}],charter:'Synthetic bounded app file writes.'},{name:'reader',tier:'sol',grant:0,add_dirs:[{path:folder,mode:'ro'}],charter:'Synthetic read-only scope control.'},{name:'limited',tier:'sol',grant:0,add_dirs:[],charter:'Synthetic out-of-scope control.'}]}}
}
export default async function(rig){
  const p=new Proof('app-files-write'),root='/api/orgs/'+rig.org
  await rig.api('POST',root+'/settings',{org_dirs:[{path:fixture,mode:'rw'}]})
  for(const [name,mode]of[['writer','rw'],['reader','ro']])await rig.api('POST',root+'/nodes/'+name+'/scope',{add_dirs:[{path:folder,mode}]})
  const apps=input=>rig.api('POST',root+'/apps',input),files=input=>rig.api('POST',root+'/apps/files',input),bridge=input=>rig.api('POST',root+'/apps/bridge',input),tool=(who,input)=>rig.tool(who,'orgtree_apps',input)
  const refused=async(fn,status)=>{try{await fn();return false}catch(e){return e.status===status}}
  const definition={name:'Synthetic file editor',html:'<p>Synthetic files only</p>',capabilities:['files.read','files.write'],initial_state:{},width:660,height:520}
  let app=await apps({action:'app_create',definition}),panel=await apps({action:'panel_open',app:app.id,new:true}),host=await bridge({action:'session_open',panel:panel.id})
  const call=request=>files({action:'call',session:host.session,request})
  const grant=async(scope,mode,choice='always',selected)=>{const ask=await call({action:'grant',scope,mode});assert(ask.permission_required);return files({action:'decide',session:host.session,challenge:ask.permission_required.challenge,choice,...(selected?{path:selected}:{})})}
  p.check('new declarations create no grants; agent cannot self-grant',rig.one('SELECT count(*)::int AS n FROM ot.custom_app_file_grants').n===0&&!(await tool('writer',{action:'file_grant',panel:panel.id,scope:'computer',mode:'write'})).ok)
  const read=await grant('folder','read','always',folder),directory=read.roots[0].id
  const listing=await call({action:'list',directory,limit:1}),existing=listing.items.find(v=>v.name==='existing.txt');assert(existing)
  p.check('native chosen folder lists opaque names without disclosing a path',listing.items.length===1&&!JSON.stringify([read,listing]).includes(fixture))
  p.check('directory traversal, absolute child and forged identity refuse',await refused(()=>call({action:'child',directory,path:'../outside/outside.txt'}),403)&&await refused(()=>call({action:'child',directory,path:'C:/outside.txt'}),403)&&await refused(()=>call({action:'grant',scope:'computer',mode:'read',permission:'allow'}),400))
  p.check('read grant cannot write or delete',await refused(()=>call({action:'write',directory,name:'new.txt',base64:'bmV3'}),403)&&await refused(()=>call({action:'delete',file:existing.id}),403))
  const once=await grant('folder','write','once',folder)
  const cancelled=await call({action:'write',directory:once.roots[0].id,name:'cancelled.txt',base64:'bmV3'})
  assert(cancelled.confirmation_required);await files({action:'confirm',app:app.id,session:host.session,challenge:cancelled.confirmation_required.challenge,allow:false})
  p.check('Allow once does not persist and rejected create writes nothing',rig.one("SELECT count(*)::int AS n FROM ot.custom_app_file_grants WHERE mode='write'").n===0&&!fs.existsSync(path.join(folder,'cancelled.txt')))
  await bridge({action:'session_close',session:host.session});host=await bridge({action:'session_open',panel:panel.id})
  p.check('Once write scope ends with its host',await refused(()=>call({action:'write',directory,name:'closed.txt',base64:'bmV3'}),403))
  const write=await grant('folder','write','always',folder)
  p.check('write-only reference cannot read content',await refused(()=>call({action:'read',file:write.roots[0].id}),403))
  p.check('replacement must be explicitly requested',await refused(()=>call({action:'write',directory,name:'existing.txt',base64:'bmV3'}),409))
  const pending=await call({action:'write',directory,name:'existing.txt',base64:'bmV3',replace:true}),confirmation=pending.confirmation_required
  p.check('native exact replacement confirmation retains original until approved',confirmation.detail.operation==='replace'&&confirmation.detail.bytes===3&&confirmation.detail.sha256.length===64)
  let targetLocked=false;try{fs.writeFileSync(path.join(folder,'existing.txt'),'raced')}catch{targetLocked=true}
  p.check('pending target pin excludes ordinary data mutation',targetLocked)
  const other=await apps({action:'panel_open',app:app.id,new:true}),otherHost=await bridge({action:'session_open',panel:other.id})
  p.check('another host cannot confirm or use copied file refs',await refused(()=>files({action:'confirm',app:app.id,session:otherHost.session,challenge:confirmation.challenge,allow:true}),403)&&await refused(()=>files({action:'call',session:otherHost.session,request:{action:'read',file:existing.id}}),403))
  const changed=await files({action:'confirm',app:app.id,session:host.session,challenge:confirmation.challenge,allow:true})
  p.check('confirmed staged replacement commits exact bytes once',changed.changed&&fs.readFileSync(path.join(folder,'existing.txt'),'utf8')==='new'&&await refused(()=>files({action:'confirm',app:app.id,session:host.session,challenge:confirmation.challenge,allow:true}),403))
  const scopes=await tool('writer',{action:'file_roots',panel:panel.id});assert(scopes.ok);const writerDir=scopes.json.items.find(v=>v.name==='chosen');assert(writerDir)
  const readerWrite=await tool('reader',{action:'file_write',panel:panel.id,directory:writerDir.id,name:'reader.txt',base64:'bmV3'}),outsideWrite=await tool('limited',{action:'file_write',panel:panel.id,directory:writerDir.id,name:'limited.txt',base64:'bmV3'})
  p.check('agent writes require their own RW folders despite app write grant',!readerWrite.ok&&!outsideWrite.ok)
  const agentPending=await tool('writer',{action:'file_write',panel:panel.id,directory:writerDir.id,name:'agent.txt',base64:'YWdlbnQ='});assert(agentPending.ok);const id=agentPending.json.pending_confirmation
  p.check('agent write waits for native confirmation with no file created',typeof id==='string'&&!fs.existsSync(path.join(folder,'agent.txt')))
  p.check('agents cannot confirm native changes or steal another caller result',!(await tool('writer',{action:'file_confirm',confirmation:id,allow:true})).ok&&!(await tool('reader',{action:'file_result',confirmation:id})).ok)
  const nativePending=await files({action:'confirmations',app:app.id});p.check('native settings can inspect the exact agent change',nativePending.items.some(v=>v.challenge===id&&v.agent==='writer'&&v.detail.path.endsWith('agent.txt')))
  await files({action:'confirm',app:app.id,challenge:id,allow:true});const result=await tool('writer',{action:'file_result',confirmation:id})
  p.check('native approval commits agent bytes and gives a one-shot scoped result',result.ok&&result.json.changed&&fs.readFileSync(path.join(folder,'agent.txt'),'utf8')==='agent'&&!(await tool('writer',{action:'file_result',confirmation:id})).ok)
  const deletion=await call({action:'delete',file:existing.id});assert(deletion.confirmation_required);await files({action:'confirm',app:app.id,session:host.session,challenge:deletion.confirmation_required.challenge,allow:true})
  p.check('confirmed deletion removes only the selected regular file',!fs.existsSync(path.join(folder,'existing.txt'))&&fs.existsSync(path.join(folder,'agent.txt'))&&await refused(()=>call({action:'delete',file:directory}),403))
  panel=await apps({action:'state_set',panel:panel.id,expected_rev:panel.rev,state:{directory}});await rig.restart();host=await bridge({action:'session_open',panel:panel.id})
  p.check('read and write grants and directory reference survive PG/engine restart',rig.one("SELECT count(*)::int AS n FROM ot.custom_app_file_grants WHERE scope='folder'").n===2&&(await call({action:'list',directory})).items.some(v=>v.name==='agent.txt'))
  const computer=await grant('computer','read');p.check('whole-computer grant exposes opaque disk roots without paths',computer.roots.length>0&&computer.roots.every(v=>v.id&&v.directory&&!('path'in v)))
  await grant('computer','write')
  // The org instruction workspace is readable context, never an implicit RW
  // folder. A broad app grant must not extend the tool caller's own scope.
  fs.mkdirSync(path.join(rig.data,'workspaces',rig.org),{recursive:true})
  const limitedRoots=await tool('limited',{action:'file_roots',panel:panel.id});assert(limitedRoots.ok)
  const workspace=limitedRoots.json.items.find(v=>v.name===rig.org);assert(workspace)
  const workspaceWrite=await tool('limited',{action:'file_write',panel:panel.id,directory:workspace.id,name:'must-not-change-org-policy.txt',base64:'bmV3'})
  p.check('readable org instruction workspace is not implicit agent write authority',!workspaceWrite.ok,{ok:workspaceWrite.ok})
  if(workspaceWrite.ok&&workspaceWrite.json.pending_confirmation)await files({action:'confirm',app:app.id,challenge:workspaceWrite.json.pending_confirmation,allow:false})
  const exported=await apps({action:'app_export',app:app.id,expected_rev:app.rev,include_panels:true}),imported=await apps({action:'app_import',bundle:exported.bundle})
  p.check('portable export/import carries no paths, grants or write permission',!JSON.stringify(exported.bundle).includes(fixture)&&Object.keys(imported.app.permissions).length===0)
  const blocked=await tool('writer',{action:'file_write',panel:panel.id,directory:writerDir.id,name:'retooled.txt',base64:'bmV3'});assert(blocked.ok)
  await rig.api('POST',root+'/nodes/writer/scope',{add_dirs:[{path:folder,mode:'ro'}]})
  p.check('native confirmation rechecks agent RW scope after retool',await refused(()=>files({action:'confirm',app:app.id,challenge:blocked.json.pending_confirmation,allow:true}),403)&&!fs.existsSync(path.join(folder,'retooled.txt')))
  const outstanding=await call({action:'write',directory,name:'revoked.txt',base64:'bmV3'});assert(outstanding.confirmation_required)
  const permissions=await files({action:'permissions',app:app.id}),writeGrant=permissions.grants.find(v=>v.mode==='write'&&v.scope==='folder')
  await files({action:'revoke',app:app.id,expected_rev:permissions.rev,expected_permission_rev:permissions.permission_rev,grant:writeGrant.id})
  p.check('write revoke discards pending change and keeps persisted read grant',await refused(()=>files({action:'confirm',app:app.id,session:host.session,challenge:outstanding.confirmation_required.challenge,allow:true}),403)&&!fs.existsSync(path.join(folder,'revoked.txt'))&&(await call({action:'list',directory})).items.length>0)
  app=await apps({action:'app_get',app:app.id});await apps({action:'app_update',app:app.id,expected_rev:app.rev,definition:{...definition,description:'Replaced code'}})
  p.check('code replacement clears read and write grants and refs',rig.one('SELECT count(*)::int AS n FROM ot.custom_app_file_grants').n===0&&rig.one('SELECT count(*)::int AS n FROM ot.custom_app_file_refs').n===0)
  p.file('source.json',{engine:rig.run.engineSource,fixture,scopes:rig.sql("SELECT name,scope FROM ot.agents WHERE name IN ('writer','reader','limited') ORDER BY name")})
  return p.summary()
}
