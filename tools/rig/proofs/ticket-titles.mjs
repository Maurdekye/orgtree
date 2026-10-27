// Ticket mentions show the item's current full title (USER 2026-10-27
// m7bb9eb904138 "ticket ajd presentation links should renerr ss their full nsme,
// notmtheir slug") through the real engine and its isolated PostgreSQL.
//
// With APP_BACKGROUND_BUILD set (the output of tools/rig/app-background-ui.mjs),
// the real renderer shows an agent's mail to the user naming a docket item in
// Session 0 (tools/rig/desktop/ticket-titles.cjs): the chip reads the title in a
// dark and a light theme; then, while the window stays open, the agent renames
// the item and the chip follows. That proves the engine's docket_changed frame
// and the re-read together. Muted, permissions and clipboard refused.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  const fixture={org:{name:'Ticket titles proof'},agents:[{name:'boss',tier:'sol',grant:40,charter:'Synthetic superior only.'}]}
  if(!built)return{fixture}
  if(!fs.existsSync(path.join(built,'ui','index.html')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture}
}
const TITLE='Build the docs site from main',RENAMED='Publish the docs site'

export default async function(rig){
  const p=new Proof('ticket-titles'),root='/api/orgs/'+rig.org
  const tool=async(who,name,v)=>{const r=await rig.tool(who,name,v);assert(r.ok,r.text);return r.json??r.text}
  const made=await tool('boss','orgtree_work',{action:'create',kind:'code',title:TITLE,objective:'Synthetic ticket for the title proof.\n\nNothing to do.'})
  const slug=made.slug??made.item?.slug
  p.check('the agent creates the ticket',typeof slug==='string'&&slug.length>0,made)
  const refs=await rig.api('GET',`${root}/work-item-references?names=${encodeURIComponent(slug)}`)
  p.check('the bounded reference read names the ticket by its title',refs.references?.length===1&&refs.references[0].slug===slug&&refs.references[0].title===TITLE,refs)

  if(built){
    const token=`@item:${rig.org}/${slug}`
    const sent=await rig.tool('boss','orgtree_message',{metadata:{to:'user'},body:`The docs work is tracked in ${token}. I will report there.`})
    p.check('the agent mails the user the ticket mention',sent.ok,sent.text)
    const ready=path.join(p.dir,'window-ready.flag')
    const run=runDesktop(rig,path.join(REPO,'tools','rig','desktop','ticket-titles.cjs'),{preset:'1000x700',out:path.join(p.dir,'desktop'),timeout:240000,args:{token,title:TITLE,renamed:RENAMED,ready}})
    // the agent renames the ticket only once the window shows it
    const t0=Date.now();while(!fs.existsSync(ready)&&Date.now()-t0<120000)await new Promise(r=>setTimeout(r,200))
    const shown=fs.existsSync(ready)
    if(shown)await tool('boss','orgtree_work',{action:'update',slug,title:RENAMED})
    const result=await run
    p.file('desktop-result.json',result)
    const R=result.value??{}
    p.check('the capture ran in Session 0, muted, permissions and clipboard refused',result.ok&&R.session?.sessionId===0&&R.muted===true&&JSON.stringify(R.clipboard)==='[]',{error:result.error,session:R.session,muted:R.muted,clipboard:R.clipboard,output:result.electronOutput?.slice(-800)})
    p.check('the chip reads the full title with the docket mark, the slug only in its token',shown&&R.chip?.text===TITLE&&R.chip?.mark==='ref-mark-item'&&R.chip?.copy===TITLE&&R.chip?.live&&R.chip?.token===token,R.chip)
    p.check('dark and light themes both captured',R.themes?.length===2&&R.themes.every(x=>x.text===TITLE&&x.markBox?.[0]>0),R.themes)
    p.check('renaming the ticket updates the chip already on screen',R.renamed?.text===RENAMED&&R.renamed?.ms<15000,R.renamed)
  }else p.note('no APP_BACKGROUND_BUILD: the Session 0 capture of the ticket title did not run')
  p.file('runtime.json',{engine:rig.run.engineSource,run:rig.run.id,limits:'Isolated PG/tool proof with a synthetic org; the window part needs APP_BACKGROUND_BUILD.'})
  return p.summary()
}
