import {useSyncExternalStore} from 'react'
import {customAppsRuntime} from '../../api'
import {desktop} from '../../desktop'

/** USER 2026-10-26: a running panel keeps running while hidden. Each window
 * tells the engine which copies it actually runs (a lease, never authority),
 * stops hosts the engine no longer wants, and samples CPU only on demand. */
export interface PanelCpu {cpu:number|null;method:string|null;at:number}
interface Host {panel:string;generation:number;stop:()=>void;error:string|null}
interface OrgRuntime {hosts:Map<string,Host>;timer:ReturnType<typeof setInterval>|null;samples:Map<string,PanelCpu>;subs:Set<()=>void>;epoch:number;sampling:Promise<void>|null;soon:boolean}
const HEARTBEAT_MS=5000
const orgs=new Map<string,OrgRuntime>()
const empty=new Map<string,PanelCpu>()

/** Stable for this window across reloads, never shared with another window. */
let ownerId=''
export function runtimeOwner():string{
  if(ownerId)return ownerId
  try{ownerId=sessionStorage.getItem('orgtree-panel-runtime-owner')??''}catch{/* storage unavailable */}
  if(!/^[A-Za-z0-9-]{8,80}$/.test(ownerId)){ownerId='window-'+crypto.randomUUID();try{sessionStorage.setItem('orgtree-panel-runtime-owner',ownerId)}catch{/* per-load owner */}}
  return ownerId
}
function org(slug:string):OrgRuntime{
  let o=orgs.get(slug);if(!o){o={hosts:new Map(),timer:null,samples:new Map(),subs:new Set(),epoch:0,sampling:null,soon:false};orgs.set(slug,o)}return o
}
function publish(o:OrgRuntime){for(const fn of o.subs)fn()}
/** Running hosts in this whole window: native keeps its timers unthrottled. */
function nativeCount(){let n=0;for(const o of orgs.values())n+=o.hosts.size;void desktop()?.setPanelRuntime?.(n).catch(()=>{})}

async function heartbeat(slug:string){
  const o=org(slug);if(!o.hosts.size)return
  const hosts=[...o.hosts.values()].map(h=>({panel:h.panel,generation:h.generation,...(h.error?{error:h.error}:{})}))
  try{
    const out=await customAppsRuntime<{stop:string[];sample_epoch:number}>(slug,{action:'heartbeat',owner:runtimeOwner(),hosts})
    for(const panel of out.stop)o.hosts.get(panel)?.stop()
    if(out.sample_epoch>o.epoch)void samplePanels(slug,out.sample_epoch)
  }catch{/* engine away: hosts keep running; the next beat reports again */}
}
function schedule(slug:string){
  const o=org(slug)
  if(o.hosts.size&&!o.timer)o.timer=setInterval(()=>void heartbeat(slug),HEARTBEAT_MS)
  if(!o.hosts.size&&o.timer){clearInterval(o.timer);o.timer=null}
  if(o.hosts.size&&!o.soon){o.soon=true;queueMicrotask(()=>{o.soon=false;void heartbeat(slug)})}
}

/** Registers one running iframe host; the returned function releases it. */
export function hostPanel(slug:string,panel:string,generation:number,stop:()=>void):()=>void{
  const o=org(slug),host:Host={panel,generation,stop,error:null}
  o.hosts.set(panel,host);schedule(slug);nativeCount()
  return()=>{
    if(o.hosts.get(panel)!==host)return
    o.hosts.delete(panel);if(o.samples.has(panel)){o.samples=new Map(o.samples);o.samples.delete(panel)}schedule(slug);nativeCount();publish(o)
    void customAppsRuntime(slug,{action:'release',owner:runtimeOwner(),panels:[panel]}).catch(()=>{})
  }
}
export function reportHostError(slug:string,panel:string,error:string|null){const h=org(slug).hosts.get(panel);if(h&&h.error!==error){h.error=error;void heartbeat(slug)}}

/** On demand only: the Apps menu while open, or an engine sampling request. */
export function samplePanels(slug:string,epoch=0):Promise<void>{
  const o=org(slug)
  if(o.sampling)return o.sampling
  o.sampling=(async()=>{try{
    const hosts=[...o.hosts.values()],bridge=desktop()
    if(!hosts.length)return
    const samples=bridge?.samplePanels?await bridge.samplePanels(hosts.map(h=>({panel:h.panel,generation:h.generation}))):[]
    const at=Date.now(),next=new Map(o.samples)
    for(const s of samples)if(o.hosts.get(s.panel)?.generation===s.generation)next.set(s.panel,{cpu:s.cpu_percent,method:s.method,at})
    o.samples=next;o.epoch=Math.max(o.epoch,epoch);publish(o)
    const reported=samples.filter(s=>s.method&&o.hosts.get(s.panel)?.generation===s.generation)
    if(reported.length)await customAppsRuntime(slug,{action:'report',owner:runtimeOwner(),epoch,samples:reported.map(s=>({panel:s.panel,generation:s.generation,cpu_percent:s.cpu_percent,method:s.method}))})
  }catch{/* sampling is advisory */}finally{o.sampling=null}})()
  return o.sampling
}
export function requestPanelSample(slug:string,epoch:number){if(epoch>org(slug).epoch)void samplePanels(slug,epoch)}
export function usePanelCpu(slug:string):Map<string,PanelCpu>{
  return useSyncExternalStore(fn=>{const o=org(slug);o.subs.add(fn);return()=>o.subs.delete(fn)},()=>orgs.get(slug)?.samples??empty)
}
export function hostsHere(slug:string,panel:string):boolean{return !!orgs.get(slug)?.hosts.has(panel)}
