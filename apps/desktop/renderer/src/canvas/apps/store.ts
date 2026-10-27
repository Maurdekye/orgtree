import { useSyncExternalStore } from 'react'
import { customAppsRequest } from '../../api'
import type { AppPage, CustomApp, CustomPanel } from './types'

/** loaded: the first full listing has arrived (panels it shows were restored, not started). */
interface Snapshot {apps:CustomApp[];panels:CustomPanel[];appNext:string|null;panelNext:string|null;newCount:number;error:string;loading:boolean;loaded:boolean}
interface Store {snapshot:Snapshot;subs:Set<()=>void>;running:Promise<void>|null;pending:boolean;active:boolean;seenEpoch:number;seenQueue:Promise<void>}
const stores=new Map<string,Store>()
function store(slug:string):Store {
  let s=stores.get(slug);if(!s){s={snapshot:{apps:[],panels:[],appNext:null,panelNext:null,newCount:0,error:'',loading:false,loaded:false},subs:new Set(),running:null,pending:false,active:false,seenEpoch:0,seenQueue:Promise.resolve()};stores.set(slug,s)}return s
}
/** Creation time in ms; payloads from before created_at sort as oldest. */
export const createdAt=(x:{created_at?:string}):number=>(x.created_at&&Date.parse(x.created_at))||0
// Apps are listed newest first, whichever path loaded them and whatever their
// panels are doing (USER 2026-10-26: "the ordering of the apps in the list
// shouldnt change as panels are turned onca or off", then "newest first").
const newestFirst=<T extends {id:string;created_at?:string}>(items:T[]):T[]=>[...items].sort((a,b)=>createdAt(b)-createdAt(a)||(a.id<b.id?1:a.id>b.id?-1:0))
function publish(s:Store,next:Partial<Snapshot>){if(next.apps)next={...next,apps:newestFirst(next.apps)};s.snapshot={...s.snapshot,...next};for(const fn of s.subs)fn()}
const merge=<T extends {id:string}>(old:T[],items:T[]):T[]=>[...new Map([...old,...items].map(x=>[x.id,x])).values()]
/** Execution intent; older payloads without it ran exactly while open. */
export const isRunning=(p:CustomPanel):boolean=>p.running??p.open
export function useApps(slug:string):Snapshot {const s=store(slug);return useSyncExternalStore(fn=>{s.subs.add(fn);return()=>s.subs.delete(fn)},()=>s.snapshot)}
export function invalidateCustomApps(slug:string):void {const s=store(slug);if(s.active)void refreshApps(slug);changed(slug,{})}
/** What a live change touched: one copy's History (an app's own fire), or anything in Apps. */
export interface AppsLogChange {panel?:string}
const logs=new Map<string,Set<(change:AppsLogChange)=>void>>()
const changed=(slug:string,change:AppsLogChange)=>{for(const fn of [...logs.get(slug)??[]])fn(change)}
/** History and Permission history follow the live change feed (user 2026-10-27
 * md2006b10cf40: "make the hidtory tab reload in realtime"). Returns the unsubscribe. */
export function onAppsLog(slug:string,fn:(change:AppsLogChange)=>void):()=>void {
  const set=logs.get(slug)??new Set<(change:AppsLogChange)=>void>();logs.set(slug,set);set.add(fn)
  return()=>{set.delete(fn);if(!set.size&&logs.get(slug)===set)logs.delete(slug)}
}
/** The org feed's Apps frames: custom_apps_changed refreshes the store and every open
 * log; custom_apps_history, an app's own fire, reaches only that copy's History. */
export function customAppsFeed(slug:string,data:{type?:unknown;panel?:unknown}|null):boolean {
  if(data?.type==='custom_apps_changed'){invalidateCustomApps(slug);return true}
  if(data?.type==='custom_apps_history'){changed(slug,{panel:typeof data.panel==='string'?data.panel:undefined});return true}
  return false
}
export function activateApps(slug:string):()=>void {const s=store(slug);s.active=true;void refreshApps(slug);return()=>{s.active=false;s.pending=false;stores.delete(slug)}}
export async function refreshApps(slug:string):Promise<void>{
  const s=store(slug);if(s.running){s.pending=true;return s.running}
  publish(s,{loading:true})
  s.running=(async()=>{const epoch=s.seenEpoch;try{
    const panels:CustomPanel[]=[];let after:string|null=null
    // Running copies include the hidden ones: their HTML stays loaded.
    do{const page:AppPage<CustomPanel>=await customAppsRequest(slug,{action:'list',kind:'panels',running:true,...(after?{after}:{})});panels.push(...page.items);after=page.next_cursor}while(after)
    const apps=await customAppsRequest<AppPage<CustomApp>>(slug,{action:'list',kind:'apps'})
    const known=new Set(apps.items.map(a=>a.id));for(const panel of panels)if(!known.has(panel.app)){const app=await customAppsRequest<CustomApp>(slug,{action:'app_get',app:panel.app});apps.items.push(app);known.add(app.id)}
    // Keep explicitly loaded stopped panels for the menu, drop stale running rows.
    // A read begun before an acknowledgement must not resurrect its badge.
    if(epoch!==s.seenEpoch){s.pending=true;return}
    publish(s,{apps:apps.items,panels:merge(s.snapshot.panels.filter(p=>!isRunning(p)),panels),appNext:apps.next_cursor,newCount:apps.new_count??0,error:'',loaded:true})
  }catch(error){publish(s,{error:String(error)})}finally{publish(s,{loading:false});s.running=null;if(s.pending&&s.active){s.pending=false;void refreshApps(slug)}}})()
  return s.running
}
export async function loadAppsMenu(slug:string,more:'apps'|'panels'|null=null):Promise<void>{
  const s=store(slug)
  try{
    // The apps of running panels stay listed even beyond the first page; publish orders the list.
    if(more!=='panels'){const epoch=s.seenEpoch,page=await customAppsRequest<AppPage<CustomApp>>(slug,{action:'list',kind:'apps',...(more==='apps'&&s.snapshot.appNext?{after:s.snapshot.appNext}:{})});if(epoch!==s.seenEpoch){void refreshApps(slug);return}publish(s,{apps:merge(more==='apps'?s.snapshot.apps:s.snapshot.apps.filter(a=>s.snapshot.panels.some(p=>isRunning(p)&&p.app===a.id)),page.items),appNext:page.next_cursor,newCount:page.new_count??0})}
    if(more!=='apps'){const page=await customAppsRequest<AppPage<CustomPanel>>(slug,{action:'list',kind:'panels',...(more==='panels'&&s.snapshot.panelNext?{after:s.snapshot.panelNext}:{})});publish(s,{panels:merge(more==='panels'?s.snapshot.panels:s.snapshot.panels.filter(p=>isRunning(p)),page.items),panelNext:page.next_cursor})}
  }catch(error){publish(s,{error:String(error)})}
}
export async function markAppsSeen(slug:string,apps:string[]):Promise<void>{
  const s=store(slug)
  const write=s.seenQueue.then(async()=>{try{
    const result=await customAppsRequest<{seen:string[];new_count:number}>(slug,{action:'mark_seen',apps});s.seenEpoch++
    publish(s,{apps:s.snapshot.apps.map(a=>result.seen.includes(a.id)?{...a,is_new:false}:a),newCount:result.new_count,error:''})
  }catch(error){publish(s,{error:String(error)});throw error}})
  s.seenQueue=write.catch(()=>{});return write
}
export async function changeApps<T=CustomPanel>(slug:string,input:Record<string,unknown>):Promise<T>{
  const result=await customAppsRequest<T>(slug,input);const s=store(slug)
  if(input.action==='panel_delete'){publish(s,{panels:s.snapshot.panels.filter(p=>p.id!==input.panel)})}
  else if(input.action==='app_delete'){publish(s,{apps:s.snapshot.apps.filter(a=>a.id!==input.app),panels:s.snapshot.panels.filter(p=>p.app!==input.app)})}
  else if(result&&typeof result==='object'&&'id' in result&&'app' in result){publish(s,{panels:merge(s.snapshot.panels,[{...result as unknown as CustomPanel,state:undefined}])})}
  else if(result&&typeof result==='object'&&'id' in result&&'capabilities' in result){publish(s,{apps:merge(s.snapshot.apps,[result as unknown as CustomApp])})}
  if(['event','app_create','app_import','app_delete'].includes(String(input.action)))void refreshApps(slug)
  return result
}
