// App and panel mentions (USER 2026-10-27 m449dc0a35cbe "also allow apps or
// spedific panels to be mentioned to the user") through the real engine, its
// isolated PostgreSQL and the real Apps and tool routes: app and panel results
// carry their @app:/@panel: token, and the bounded refs read names exactly the
// IDs asked for, in this org only, with nothing private.
//
// With APP_BACKGROUND_BUILD set (the output of tools/rig/app-background-ui.mjs),
// the real renderer then shows an agent's mail to the user with an app mention
// and a panel mention in Session 0 (tools/rig/desktop/app-mentions.cjs), and each
// is clicked: the app's most recently used copy opens, then the named panel.
// Muted, every permission and the clipboard refused, input only through CDP.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  const fixture={org:{name:'App mentions proof'},agents:[{name:'boss',tier:'sol',grant:40,charter:'Synthetic superior only.'},{name:'writer',tier:'sol',parent:'boss',grant:0,charter:'Synthetic app author only.'}]}
  if(!built)return{fixture}
  if(!fs.existsSync(path.join(built,'ui','index.html')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture}
}

export default async function(rig){
  const p=new Proof('app-mentions'),root='/api/orgs/'+rig.org
  const apps=v=>rig.api('POST',root+'/apps',v)
  const read=v=>rig.api('GET',root+'/apps?request='+encodeURIComponent(JSON.stringify(v)))
  const tool=async(who,v)=>{const r=await rig.tool(who,'orgtree_apps',v);assert(r.ok,r.text);return r.json}
  const outcome=async fn=>{try{return{ok:true,value:await fn()}}catch(e){return{ok:false,status:e.status,message:String(e.message??e)}}}
  const token=(kind,id)=>`@${kind}:${rig.org}/${id}`
  // jsonb orders an object's keys its own way: compare by content
  const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v
  const same=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b))

  // An agent makes the app and a closed copy; the user opens a second copy.
  const app=await tool('writer',{action:'app_create',definition:{name:'Caption board',description:'Synthetic app for the mention proof',html:'<p id="out">board</p>',capabilities:['events.fire'],width:480,height:320}})
  const first=await tool('writer',{action:'panel_open',app:app.id})
  const second=await apps({action:'panel_open',app:app.id,new:true,label:'Panel 2'})
  p.check('app and panel results carry their mention token, for agents and the user alike',app.ref===token('app',app.id)&&first.ref===token('panel',first.id)&&second.ref===token('panel',second.id),{app:app.ref,first:first.ref,second:second.ref})
  const listed=await tool('writer',{action:'list',kind:'panels',app:app.id}),apps_=await tool('writer',{action:'list'}),got=await tool('writer',{action:'panel_get',panel:first.id})
  p.check('list pages and reads carry the same tokens',listed.items.length===2&&listed.items.every(x=>x.ref===token('panel',x.id))&&apps_.items.some(x=>x.id===app.id&&x.ref===app.ref)&&got.ref===first.ref,{panels:listed.items.map(x=>x.ref),got:got.ref})

  // The names a chip shows: exact IDs, only what exists here, nothing private.
  const other=await rig.api('POST','/api/orgs',{name:'Other mention org',dirs:[],net_autoconnect:false})
  const elsewhere=await rig.api('POST','/api/orgs/'+other.slug+'/apps',{action:'app_create',definition:{name:'Elsewhere',html:'<p>other org</p>',width:320,height:200}})
  const refs=await read({action:'refs',apps:[app.id,'app000000000000',elsewhere.id],panels:[first.id,second.id,'panel000000000000']})
  const byId=Object.fromEntries(refs.panels.map(x=>[x.id,x]))
  p.check('refs names the app by its current name with the copy its row opens, and leaves out unknown and other-org IDs',
    same(refs.apps,[{id:app.id,name:'Caption board',recent:'Panel 2'}]),refs.apps)
  p.check('refs names each panel with its app and run state, as its Apps row shows them',refs.panels.length===2
    &&same(byId[first.id],{id:first.id,app:app.id,app_name:'Caption board',label:'Panel 1',open:false,running:false})
    &&same(byId[second.id],{id:second.id,app:app.id,app_name:'Caption board',label:'Panel 2',open:true,running:true}),refs.panels)
  p.check('refs carries no HTML, state, permissions, grants or tokens',!/board<\/p>|"state"|permissions|"ref"/.test(JSON.stringify(refs)),refs)
  // the GET read refuses any invalid request in general words; the POST route says why
  const tooMany={action:'refs',apps:Array.from({length:33},(_,i)=>'app'+i),panels:Array.from({length:32},(_,i)=>'panel'+i)}
  const many=await outcome(()=>read(tooMany)),said=await outcome(()=>apps(tooMany))
  const empty=await outcome(()=>read({action:'refs'}))
  p.check('refs is bounded: 1-64 IDs together',!many.ok&&many.status===400&&!said.ok&&said.status===400&&/1-64/.test(said.message)&&!empty.ok&&empty.status===400,{many:many.status,said:said.message,empty:empty.status})

  // A rename and a deletion are what the next read says.
  let renamed=await apps({action:'panel_update',panel:first.id,expected_rev:first.rev,label:'Drafts'})
  const third=await apps({action:'panel_open',app:app.id,new:true,label:'Scratch'})
  await apps({action:'panel_delete',panel:third.id,expected_rev:third.rev})
  const after=await read({action:'refs',panels:[first.id,third.id]})
  p.check('a renamed panel reads by its new label; a deleted one is left out',JSON.stringify(after.panels.map(x=>[x.id,x.label]))===JSON.stringify([[first.id,'Drafts']]),after)
  renamed=await apps({action:'panel_update',panel:first.id,expected_rev:renamed.rev,label:'Panel 1'})

  if(built){
    // Before the clicks: the most recent copy runs hidden, the other is off.
    const hidden=await apps({action:'panel_update',panel:second.id,expected_rev:second.rev,open:false})
    p.check('Panel 2 runs hidden and Panel 1 is off before the clicks',hidden.open===false&&hidden.running===true&&renamed.running===false,{hidden:[hidden.open,hidden.running],first:[renamed.open,renamed.running]})
    // The user's mail: an app mention and a panel mention, as an agent writes them.
    const body=`Your caption tools are ready. The board: ${app.ref}. Your draft copy: ${first.ref}.`
    const sent=await rig.tool('boss','orgtree_message',{metadata:{to:'user'},body})
    p.check('the agent mails the user both mentions',sent.ok,sent.text)
    const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-mentions.cjs'),{preset:'1000x700',out:path.join(p.dir,'desktop'),timeout:240000,args:{app:app.id,first:first.id,second:second.id,appRef:app.ref,panelRef:first.ref}})
    p.file('desktop-result.json',run)
    const R=run.value??{}
    p.check('the capture ran in Session 0, muted, permissions and clipboard refused',run.ok&&R.session?.sessionId===0&&R.muted===true&&JSON.stringify(R.clipboard)==='[]',{error:run.error,session:R.session,muted:R.muted,clipboard:R.clipboard,output:run.electronOutput?.slice(-800)})
    p.check('the mail shows the app by name and the panel with its app, each with its own mark and its row\'s hover text',
      R.chips?.app?.text==='Caption board'&&R.chips?.app?.mark==='ref-mark-app'&&R.chips?.app?.title==='Open Panel 2'&&R.chips?.app?.live
      &&R.chips?.panel?.text==='Caption board · Panel 1'&&R.chips?.panel?.mark==='ref-mark-panel'&&R.chips?.panel?.title==='Off'&&R.chips?.panel?.live,R.chips)
    p.check('clicking the app mention shows its most recently used copy, as its Apps row does',R.appClick?.before===null&&R.appClick?.shown===second.id&&R.appClick?.window?.w>0&&R.appClick?.window?.h>0,R.appClick)
    p.check('clicking the panel mention starts and opens that panel',R.panelClick?.before===null&&R.panelClick?.shown===first.id&&R.panelClick?.window?.w>0&&R.panelClick?.window?.h>0,R.panelClick)
    const state=await read({action:'refs',panels:[first.id,second.id]})
    p.check('the engine agrees: both copies run and are visible',state.panels.every(x=>x.open&&x.running),state.panels)
  }else p.note('no APP_BACKGROUND_BUILD: the Session 0 capture of the mail and its clicked mentions did not run')
  p.file('runtime.json',{engine:rig.run.engineSource,run:rig.run.id,limits:'Isolated PG/Apps/tool proof with a synthetic org; the window part needs APP_BACKGROUND_BUILD.'})
  return p.summary()
}
