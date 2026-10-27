// The composer's @ list through the real engine and its isolated PostgreSQL:
// presentations (USER 2026-10-27 mb21c096e5dc4 "and theynshould appear in the
// mention menu", m042c82fb0228 "and i should be able to mention apps, panels,
// and presentations from my @ mention menu").
//
// With MENTION_MENU_UI set to a renderer bundle (a folder holding index.html:
// the installed app's `ui`, or a build of this worktree), the real renderer runs
// in Session 0 (tools/rig/desktop/mention-menu.cjs). In Quick chat and then in
// the new agent's desk composer, typing @ and part of a presentation title
// offers it by title with the document mark, Tab inserts @doc:<org>/<slug>, and
// the sent message shows the chip by title. Muted, permissions and clipboard
// refused, input only through CDP in this window.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'
import {SEED_SETTLE_TIMEOUT} from '../seed-settle.mjs'

const ui=process.env.MENTION_MENU_UI?path.resolve(process.env.MENTION_MENU_UI):''
export function setup(){
  const fixture={org:{name:'Mention menu proof'},agents:[{name:'boss',tier:'sol',grant:40,charter:'Synthetic superior only.'}]}
  if(!ui)return{fixture}
  if(!fs.existsSync(path.join(ui,'index.html')))throw Error('MENTION_MENU_UI must be a renderer bundle folder holding index.html')
  return{ui,fixture}
}
// newest last: the @ list offers presentations newest first
const DECKS=[['Quarterly launch plan','quarterly-launch-plan'],['Weekly status, week 43','weekly-status-week-43'],['Weekly status, week 44','weekly-status-week-44']]

export default async function(rig){
  const p=new Proof('mention-menu'),root='/api/orgs/'+rig.org
  await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'seed turns to settle',timeout:SEED_SETTLE_TIMEOUT})
  const slugs=[]
  for(const [title] of DECKS){
    const r=await rig.tool('boss','orgtree_present',{title,body:`# ${title}\n\nSynthetic presentation for the mention menu proof.`})
    assert(r.ok,r.text)
    slugs.push(r.json?.presentation?.id??(r.text.match(/\(id ([a-z0-9-]+)/)||[])[1])
  }
  p.check('the agent presents three decks, each identified by its slug',JSON.stringify(slugs)===JSON.stringify(DECKS.map(d=>d[1])),slugs)
  const found=await rig.api('GET',`${root}/documents?search=${encodeURIComponent('weekly')}`)
  p.check('the bounded search finds the two weekly decks, newest first',JSON.stringify((found.documents??[]).map(d=>d.id))===JSON.stringify(['weekly-status-week-44','weekly-status-week-43']),found)

  if(ui){
    const quick={type:'Compare @weekly',rows:['Weekly status, week 44','Weekly status, week 43'],token:`@doc:${rig.org}/weekly-status-week-44`,title:'Weekly status, week 44'}
    const desk={type:'See @launch',rows:['Quarterly launch plan'],token:`@doc:${rig.org}/quarterly-launch-plan`,title:'Quarterly launch plan'}
    const result=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','mention-menu.cjs'),{preset:'1100x760',out:path.join(p.dir,'desktop'),timeout:240000,args:{quick,desk}})
    p.file('desktop-result.json',result)
    const R=result.value??{}
    p.check('the window ran in Session 0, muted, permissions and clipboard refused',result.ok&&R.session?.sessionId===0&&R.muted===true&&JSON.stringify(R.clipboard)==='[]',{error:result.error,session:R.session,muted:R.muted,clipboard:R.clipboard,output:result.electronOutput?.slice(-800)})
    for(const [where,want,below] of [['quick',quick,true],['desk',desk,false]]){
      const got=R[where]??{},decks=(got.rows??[]).filter(r=>r.kind==='presentation'),hit=decks.find(r=>r.active)
      p.check(`${where}: the @ list offers the presentations by title with the document icon, the newest highlighted`,JSON.stringify(decks.map(r=>r.name).sort())===JSON.stringify([...want.rows].sort())
        &&decks.every(r=>r.icon&&r.box.width>0&&r.box.height>0)&&hit?.name===want.rows[0],got.rows)
      // on screen, whole, on the side of its composer that has room, the highlighted row next to the composer
      const m=got.menu,c=got.composer?.box,[w,h]=got.view??[0,0],rows=got.rows??[]
      const nearest=below?rows.reduce((a,r)=>!a||r.box.y<a.box.y?r:a,null):rows.reduce((a,r)=>!a||r.box.y>a.box.y?r:a,null)
      p.check(`${where}: the list is whole on screen ${below?'below':'above'} its composer, the highlighted row next to it`,!!m&&!!c&&m.width>0&&m.height>0
        &&m.x>=0&&m.y>=0&&m.x+m.width<=w&&m.y+m.height<=h&&got.below===below&&(below?m.y>=c.y+c.height:m.y+m.height<=c.y+2)&&nearest?.active===true,
        {menu:m,composer:c,view:got.view,below:got.below,nearest:nearest?.name})
      p.check(`${where}: Tab inserts ${want.token}`,got.completed===want.type.replace(/@\S+$/,want.token+' '),got.completed)
      p.check(`${where}: the sent message shows the chip by title with the document mark`,got.chip?.text===want.title&&got.chip?.mark==='ref-mark-doc'&&got.chip?.live===true&&got.chip?.box?.[0]>0,got.chip)
    }
  }else p.note('no MENTION_MENU_UI: the Session 0 window part did not run')
  p.file('runtime.json',{engine:rig.run.engineSource,ui:ui||null,run:rig.run.id,limits:'Isolated PG/tool proof with a synthetic org; the window part needs MENTION_MENU_UI.'})
  return p.summary()
}
