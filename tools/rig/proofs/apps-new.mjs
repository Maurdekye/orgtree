// Focused real-PG badge/initial-state controls; synthetic org and fake CLIs only.
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
export function setup(){return{fixture:{org:{name:'New Apps proof'},agents:[{name:'maker',tier:'sol',grant:0,charter:'Synthetic Apps proof.'}]}}}
export default async function(rig){
  const p=new Proof('apps-new'),root='/api/orgs/'+rig.org+'/apps',api=input=>rig.api('POST',root,input)
  const tool=async input=>{const r=await rig.tool('maker','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  const definition={name:'Initial app',html:'<p>Initial state</p>',initial_state:{count:2}}
  let app=await tool({action:'app_create',definition}),one=await tool({action:'panel_open',app:app.id})
  const firstState=one.state.count
  one=await tool({action:'state_set',panel:one.id,expected_rev:one.rev,state:{count:4}})
  app=await tool({action:'app_update',app:app.id,expected_rev:app.rev,definition:{...definition,initial_state:{count:9}}})
  const two=await tool({action:'panel_open',app:app.id,new:true}),old=await api({action:'panel_get',panel:one.id})
  p.check('definition initial_state changes apply to new panels only',firstState===2&&one.state.count===4&&old.state.count===4&&two.state.count===9&&old.rev===one.rev)
  const imported=await api({action:'app_import',bundle:{format:'orgtree-app',version:1,definition,panels:[]}})
  let list=await api({action:'list',limit:1})
  p.check('create and self-import count as new across pages',app.is_new===true&&imported.app.is_new===true&&list.new_count===2&&list.items.length===1&&!!list.next_cursor)
  const seen=await tool({action:'mark_seen',apps:[app.id]})
  p.check('agent tool can acknowledge explicit app IDs without changing app revision or state',seen.new_count===1&&(await api({action:'app_get',app:app.id})).rev===app.rev&&(await api({action:'panel_get',panel:one.id})).state.count===4)
  await rig.restart();list=await api({action:'list'})
  p.check('seen flags and remaining count survive restart',list.new_count===1&&list.items.find(a=>a.id===app.id).is_new===false&&list.items.find(a=>a.id===imported.app.id).is_new===true)
  const target=await rig.api('POST','/api/orgs',{name:'Other badge org',dirs:[],net_autoconnect:false})
  const other='/api/orgs/'+target.slug+'/apps';await rig.api('POST',other,{action:'mark_seen',apps:[imported.app.id]})
  p.check('cross-org IDs cannot acknowledge apps and repeated seen is idempotent',(await api({action:'list'})).new_count===1&&(await api({action:'mark_seen',apps:[app.id]})).new_count===1)
  await api({action:'app_delete',app:imported.app.id,expected_rev:imported.app.rev,delete_panels:true})
  p.check('deleting an unseen app drops its count',(await api({action:'list'})).new_count===0)
  return p.summary()
}
