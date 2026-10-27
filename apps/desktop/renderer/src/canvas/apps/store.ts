import { useSyncExternalStore } from 'react'
import { customAppsRequest } from '../../api'
import type { AppPage, CustomApp, CustomPanel } from './types'

/** loaded: the first full listing has arrived (panels it shows were restored, not started). */
interface Snapshot {apps:CustomApp[];panels:CustomPanel[];appNext:string|null;panelNext:string|null;newCount:number;error:string;loading:boolean;loaded:boolean}
interface Store {snapshot:Snapshot;subs:Set<()=>void>;running:Promise<void>|null;pending:boolean;active:boolean;menu:boolean;appCursors:string[];panelCursors:string[];seenEpoch:number;seenQueue:Promise<void>}
const stores=new Map<string,Store>()
function store(slug:string):Store {
  let s=stores.get(slug);if(!s){s={snapshot:{apps:[],panels:[],appNext:null,panelNext:null,newCount:0,error:'',loading:false,loaded:false},subs:new Set(),running:null,pending:false,active:false,menu:false,appCursors:[],panelCursors:[],seenEpoch:0,seenQueue:Promise.resolve()};stores.set(slug,s)}return s
}
/** Creation time in ms; payloads from before created_at sort as oldest. */
export const createdAt=(x:{created_at?:string}):number=>(x.created_at&&Date.parse(x.created_at))||0
// Apps are listed newest first, whichever path loaded them and whatever their
// panels are doing (USER 2026-10-26: "the ordering of the apps in the list
// shouldnt change as panels are turned onca or off", then "newest first").
const newestFirst=<T extends {id:string;created_at?:string}>(items:T[]):T[]=>[...items].sort((a,b)=>createdAt(b)-createdAt(a)||(a.id<b.id?1:a.id>b.id?-1:0))
function publish(s:Store,next:Partial<Snapshot>){if(next.apps)next={...next,apps:newestFirst(next.apps)};s.snapshot={...s.snapshot,...next};for(const fn of s.subs)fn()}
const merge=<T extends {id:string}>(old:T[],items:T[]):T[]=>[...new Map([...old,...items].map(x=>[x.id,x])).values()]
/** A read begun before a write can answer after it: a panel is never replaced
 *  by an older revision of itself (the same creation), or a dropped window pin
 *  would jump back to where its drag began (user 2026-10-27 m061e2860fd9b). */
const newer=(current:CustomPanel[],items:CustomPanel[]):CustomPanel[]=>{const now=new Map(current.map(p=>[p.id,p]));return items.map(p=>{const c=now.get(p.id);return c&&c.rev>p.rev&&(c.created_at??'')===(p.created_at??'')?c:p})}
/** Execution intent; older payloads without it ran exactly while open. */
export const isRunning=(p:Pick<CustomPanel,'open'|'running'>):boolean=>p.running??p.open
export function useApps(slug:string):Snapshot {const s=store(slug);return useSyncExternalStore(fn=>{s.subs.add(fn);return()=>s.subs.delete(fn)},()=>s.snapshot)}
const invalidated=new Set<(slug:string)=>void>()
/** Told of every app change for an org, active or not: mention chips re-read their names. */
export function onAppsInvalidated(fn:(slug:string)=>void):()=>void {invalidated.add(fn);return()=>invalidated.delete(fn)}
export function invalidateCustomApps(slug:string):void {const s=store(slug);if(s.active||s.menu)void refreshApps(slug);changed(slug,{});for(const fn of invalidated)fn(slug)}
/** What a live change touched: one copy's History (an app's own fire), anything in
 * Apps, or a watchdog (listeners: Connections lists and their subscriptions' fires). */
export interface AppsLogChange {panel?:string;listeners?:boolean}
const logs=new Map<string,Set<(change:AppsLogChange)=>void>>()
const changed=(slug:string,change:AppsLogChange)=>{for(const fn of [...logs.get(slug)??[]])fn(change)}
/** History and Permission history follow the live change feed (user 2026-10-27
 * md2006b10cf40: "make the hidtory tab reload in realtime"). Returns the unsubscribe. */
export function onAppsLog(slug:string,fn:(change:AppsLogChange)=>void):()=>void {
  const set=logs.get(slug)??new Set<(change:AppsLogChange)=>void>();logs.set(slug,set);set.add(fn)
  return()=>{set.delete(fn);if(!set.size&&logs.get(slug)===set)logs.delete(slug)}
}
/** The org feed's Apps frames: custom_apps_changed refreshes the store and every open
 * log; custom_apps_history, an app's own fire, reaches only that copy's History;
 * watchdogs_changed, any watchdog write, reaches the open Connections lists and their
 * subscriptions' fires (user 2026-10-27 md11c3c790acf: they change in realtime). */
export function customAppsFeed(slug:string,data:{type?:unknown;panel?:unknown}|null):boolean {
  if(data?.type==='custom_apps_changed'){invalidateCustomApps(slug);return true}
  if(data?.type==='custom_apps_history'){changed(slug,{panel:typeof data.panel==='string'?data.panel:undefined});return true}
  if(data?.type==='watchdogs_changed'){changed(slug,{listeners:true});return true}
  return false
}
export function activateApps(slug:string):()=>void {const s=store(slug);s.active=true;void refreshApps(slug);return()=>{s.active=false;s.pending=false;stores.delete(slug)}}
export async function refreshApps(slug:string):Promise<void>{
  const s=store(slug);if(s.running){s.pending=true;return s.running}
  publish(s,{loading:true})
  s.running=(async()=>{try{
    do{
      s.pending=false;const epoch=s.seenEpoch,menu=s.menu
      const running:CustomPanel[]=[];let after:string|null=null
      // Running copies include the hidden ones: their HTML stays loaded.
      do{const page:AppPage<CustomPanel>=await customAppsRequest(slug,{action:'list',kind:'panels',running:true,...(after?{after}:{})});running.push(...page.items);after=page.next_cursor}while(after)
      const apps=await customAppsRequest<AppPage<CustomApp>>(slug,{action:'list',kind:'apps'})
      for(const cursor of menu?s.appCursors:[]){if(!apps.next_cursor)break;const page=await customAppsRequest<AppPage<CustomApp>>(slug,{action:'list',kind:'apps',after:cursor});apps.items=merge(apps.items,page.items);apps.next_cursor=page.next_cursor;if(page.new_count!==undefined)apps.new_count=page.new_count}
      let panelItems=running,panelNext=s.snapshot.panelNext
      // Once the Apps menu has been opened, refresh its saved-panel page too so
      // stopped creates, renames, power-offs and deletes appear in realtime (USER
      // 2026-10-27 m4dcfc15be8e3).
      if(menu){
        const page=await customAppsRequest<AppPage<CustomPanel>>(slug,{action:'list',kind:'panels'})
        for(const cursor of s.panelCursors){if(!page.next_cursor)break;const more=await customAppsRequest<AppPage<CustomPanel>>(slug,{action:'list',kind:'panels',after:cursor});page.items=merge(page.items,more.items);page.next_cursor=more.next_cursor}
        panelItems=merge(running,page.items);panelNext=page.next_cursor
      }
      const known=new Set(apps.items.map(a=>a.id));for(const panel of running)if(!known.has(panel.app)){const app=await customAppsRequest<CustomApp>(slug,{action:'app_get',app:panel.app});apps.items.push(app);known.add(app.id)}
      // A read begun before an acknowledgement or menu open must not overwrite it.
      if(epoch!==s.seenEpoch||menu!==s.menu){s.pending=true;continue}
      publish(s,{apps:apps.items,panels:menu?newer(s.snapshot.panels,panelItems):merge(s.snapshot.panels.filter(p=>!isRunning(p)),newer(s.snapshot.panels,running)),appNext:apps.next_cursor,panelNext,newCount:apps.new_count??0,error:'',loaded:true})
    }while(s.pending&&(s.active||s.menu))
  }catch(error){publish(s,{error:String(error)})}finally{publish(s,{loading:false});s.running=null}})()
  return s.running
}
export async function loadAppsMenu(slug:string,more:'apps'|'panels'|null=null):Promise<void>{
  const s=store(slug)
  if(!more){s.menu=true;s.appCursors=[];s.panelCursors=[];return refreshApps(slug)}
  try{
    if(more==='apps'&&s.snapshot.appNext){const cursor=s.snapshot.appNext;if(!s.appCursors.includes(cursor))s.appCursors.push(cursor);const epoch=s.seenEpoch,page=await customAppsRequest<AppPage<CustomApp>>(slug,{action:'list',kind:'apps',after:cursor});if(epoch!==s.seenEpoch){void refreshApps(slug);return}publish(s,{apps:merge(s.snapshot.apps,page.items),appNext:page.next_cursor,newCount:page.new_count??0})}
    if(more==='panels'&&s.snapshot.panelNext){const cursor=s.snapshot.panelNext;if(!s.panelCursors.includes(cursor))s.panelCursors.push(cursor);const page=await customAppsRequest<AppPage<CustomPanel>>(slug,{action:'list',kind:'panels',after:cursor});publish(s,{panels:merge(s.snapshot.panels,newer(s.snapshot.panels,page.items)),panelNext:page.next_cursor})}
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
  else if(result&&typeof result==='object'&&'id' in result&&'app' in result){publish(s,{panels:merge(s.snapshot.panels,newer(s.snapshot.panels,[{...result as unknown as CustomPanel,state:undefined}]))})}
  else if(result&&typeof result==='object'&&'id' in result&&'capabilities' in result){publish(s,{apps:merge(s.snapshot.apps,[result as unknown as CustomApp])})}
  if(['event','app_create','app_import','app_delete','stop_all'].includes(String(input.action)))void refreshApps(slug)
  return result
}
