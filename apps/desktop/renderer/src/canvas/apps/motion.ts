import {useEffect,useState} from 'react'
import {isRunning} from './store'
import type {CustomApp,CustomPanel} from './types'

/** USER 2026-10-27 m056a5c0bde3c: "add an accompanying quick animation associated
 * with starting / stopping a panel, to differrntiate from just flosing or opening
 * the visible panel. a rapid zoom in / out". The zoom's length; apps.css plays
 * the same 180 ms. */
export const PANEL_MOTION_MS=180
// The animation starts at the first frame after the commit, not at the render
// that marked it, so the marker outlives it a little.
const SLACK_MS=80
export type PanelMotion='start'|'stop'
export interface ShownPanel {panel:CustomPanel;app:CustomApp;motion?:PanelMotion}
interface Motion {kind:PanelMotion;until:number;shown?:ShownPanel}
interface Seen {panels:CustomPanel[];apps:CustomApp[];loaded:boolean;order:string[]}

/** Running ids in listing order; each leaving id goes back after the id it
 * followed last time, so the copies around it keep their DOM places. */
function placeLeaving(previous:string[],running:string[],leaving:Set<string>):string[]{
  const out=[...running]
  previous.forEach((id,i)=>{
    if(!leaving.has(id)||out.includes(id))return
    let at=0
    for(let j=i-1;j>=0;j--){const k=out.indexOf(previous[j]!);if(k>=0){at=k+1;break}}
    out.splice(at,0,id)
  })
  for(const id of leaving)if(!out.includes(id))out.push(id)
  return out
}

/** The panels this window shows, each with the motion it plays. A start is a
 * copy that runs and shows and did not run in the previous listing, once the
 * first listing has loaded: a launch restores panels, it does not start them.
 * A stop is a copy that ran and showed and runs no longer (Power off, Stop all,
 * an agent, deletion). Its last running form stays for the zoom-out at its old
 * place in the list: moving a centred panel's DOM would reload its frame. Hide,
 * show and hidden starts and stops play nothing. */
export function usePanelMotion(panels:CustomPanel[],apps:CustomApp[],loaded:boolean):ShownPanel[]{
  const [seen,setSeen]=useState<Seen>(()=>({panels,apps,loaded,order:panels.filter(isRunning).map(p=>p.id)}))
  const [motion,setMotion]=useState<ReadonlyMap<string,Motion>>(()=>new Map())
  let current=motion,order=seen.order
  // Derived while rendering, so a stopping copy never unmounts in between.
  if(seen.panels!==panels||seen.apps!==apps||seen.loaded!==loaded){
    const before=new Map(seen.panels.filter(isRunning).map(p=>[p.id,p])),now=panels.filter(isRunning),ids=new Set(now.map(p=>p.id))
    const until=Date.now()+PANEL_MOTION_MS+SLACK_MS,next=new Map(motion)
    for(const p of now){
      // Started again during its zoom-out: it runs on, and zooms back in if it shows.
      if(next.get(p.id)?.kind==='stop')next.delete(p.id)
      if(seen.loaded&&p.open&&!before.has(p.id))next.set(p.id,{kind:'start',until})
    }
    for(const [id,p] of before)if(p.open&&!ids.has(id)){
      const app=seen.apps.find(a=>a.id===p.app)??apps.find(a=>a.id===p.app) // the app it rendered with: a newer rev would reload the frame
      if(app)next.set(id,{kind:'stop',until,shown:{panel:p,app}});else next.delete(id)
    }
    const leaving=new Set([...next].filter(([,m])=>m.kind==='stop').map(([id])=>id))
    order=placeLeaving(seen.order,now.map(p=>p.id),leaving)
    setSeen({panels,apps,loaded,order})
    if(next.size!==motion.size||[...next].some(([id,m])=>motion.get(id)!==m)){current=next;setMotion(next)}
  }
  useEffect(()=>{
    if(!motion.size)return
    const soonest=Math.min(...[...motion.values()].map(m=>m.until))
    // Ends what was due by this timer's own deadline, so a timer firing a
    // moment early by the wall clock still makes progress.
    const timer=setTimeout(()=>setMotion(old=>{const next=new Map([...old].filter(([,m])=>m.until>soonest));return next.size===old.size?old:next}),Math.max(0,soonest-Date.now()))
    return()=>clearTimeout(timer)
  },[motion])
  const byId=new Map(panels.map(p=>[p.id,p]))
  return order.flatMap((id):ShownPanel[]=>{
    const m=current.get(id)
    if(m?.kind==='stop')return m.shown?[{...m.shown,motion:'stop' as const}]:[]
    const p=byId.get(id),app=p&&isRunning(p)?apps.find(a=>a.id===p.app):undefined
    return p&&app?[{panel:p,app,...(m?{motion:m.kind}:{})}]:[]
  })
}
