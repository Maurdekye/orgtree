import {createContext,useContext,useEffect,useId,useMemo,useRef,useState} from 'react'
import {customAppsRequest} from '../../api'
import {fmtFull,fmtShort} from '../../timefmt'
import {SetRow} from '../settingskit'
import {useLoadWhenSeen} from '../loadmore'
import {RefChip,resolveRef} from '../reflinks'
import type {RefRoutes,RefWorld} from '../reflinks'
import {useRefNames} from '../refnames'
import {openAppRef} from '../apprefs'
import {LOG_PAGE,LogList} from './loglist'
import type {LogCursor} from './loglist'
import {onAppsLog} from './store'
import type {CustomApp,CustomPanel,PanelEvent,PanelEvents} from './types'

interface Connection {id:string;owner:string;name?:string;event_name:string;panel:string|null;all_panels?:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
interface Connections {items:Connection[];next_cursor:number|null}
/** One finished delivery of a subscription's event (the engine's listener_fires):
 * metadata only; the app data and the mail stay with the subscribed agent. */
interface Fire {seq:number;id:string;at:string;event:string;panel:string;panel_label?:string|null;by:string;delivered:boolean;notice:boolean}
interface Fires {fires:Fire[];next_cursor:number|null}

/** The engine's metadata row for one fired event; its data went only to the
 * subscribed listeners' mail, never into this log. */
const FIRED='event.fired'
const plural=(n:number,one:string)=>`${n} ${one}${n===1?'':'s'}`

/** The cause of a start or stop: the reason the engine records, else the control. */
const CAUSE:Record<string,string>={opened:'Opened','stop all':'Stop all','code changed':'Code changed'}
const who=(actor:string)=>actor==='user'?'You':actor
const facts=(e:PanelEvent)=>{
  const payload=(e.payload??{}) as {event?:unknown;subscribers?:unknown;reason?:unknown;id?:unknown}
  const reason=typeof payload.reason==='string'?CAUSE[payload.reason]??payload.reason:null
  return {payload,cause:e.name==='panel.started'?reason??'Start running':e.name==='panel.stopped'?reason??'Power off':null}
}
/** A History row on one line (user 2026-10-26 md6edfebc1975; 2026-10-27
 * md2006b10cf40 "more list like"): when, a fire with its event or a start or stop,
 * its listener count or cause, and who. An older engine's row shows by name. */
function historySummary(e:PanelEvent){
  const {payload,cause}=facts(e)
  const what=e.name===FIRED?<>Fired <strong>{String(payload.event??'event')}</strong></>:e.name==='panel.started'?'Started':e.name==='panel.stopped'?'Stopped':e.name
  // Spaces between the cells keep the row's text and accessible name readable; grid ignores them.
  return <><time dateTime={e.at}>{fmtShort(e.at)}</time>{' '}<span>{what}</span>{' '}<span className="dim">{e.name===FIRED?plural(Number(payload.subscribers??0),'listener'):cause}</span>{' '}<span className="dim">{who(e.actor)}</span></>
}
/** An expanded History row: the exact time, who, and the row's own data. */
function historyDetails(e:PanelEvent){
  const {payload,cause}=facts(e)
  return <dl>
    <dt>Time</dt><dd>{fmtFull(e.at)}</dd><dt>By</dt><dd>{who(e.actor)}</dd>
    {e.name===FIRED?<><dt>Event</dt><dd>{String(payload.event??'')}</dd><dt>Listeners</dt><dd>{Number(payload.subscribers??0)}</dd>{typeof payload.id==='string'&&<><dt>Event ID</dt><dd>{payload.id}</dd></>}</>
      :cause&&<><dt>Cause</dt><dd>{cause}</dd></>}
    <pre>{JSON.stringify(e.payload,null,2)}</pre>
  </dl>
}

/** Panel settings' History tab, the last one (user 2026-10-26: "remove activity
 * and put events on its own tab, as history"; "make history the last tab"): the
 * copy's fires, starts and stops as a live list (2026-10-27 md2006b10cf40). It
 * follows Apps changes and this copy's own fires; Connections and Fire event
 * have their own tabs. */
export function PanelHistory({slug,panel}:{slug:string;panel:CustomPanel}){
  const read=(cursor:LogCursor)=>customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,limit:LOG_PAGE,...cursor}).then(page=>({items:page.events,next_cursor:page.next_cursor}))
  return <div className="set-group custom-app-log-group"><p className="dim">Fired events agents can listen to, and this copy starting and stopping, newest first. Click an entry for its details; a fired event's data goes only to the subscribed agents.</p>
    <LogList slug={slug} label="History" read={read} follows={change=>!change.listeners&&(!change.panel||change.panel===panel.id)} summary={historySummary} details={historyDetails} empty="Nothing has fired, started or stopped in this copy yet."/>
  </div>
}

/** The shell's reference routes, handed down by AppsWorkspace (App's tree and
 * its agent focus): a Connections row's agent is a link like every agent link
 * (user 2026-10-27 m6ca9f88d5812). Without them the agent shows as identity
 * only, and the panel link still opens its panel. */
export const AppsRefRoutes=createContext<RefRoutes|null>(null)

const delivery=(f:Fire)=>f.delivered?f.notice?'Delivered as a notice':'Delivered':'Not delivered'
/** A subscription's fire on one line, like a History row: when, the event (and the
 * copy, for a subscription to all copies), how it was delivered, and who fired it. */
const fireSummary=(all:boolean)=>(f:Fire)=><><time dateTime={f.at}>{fmtShort(f.at)}</time>{' '}<span>Fired <strong>{f.event}</strong>{all&&<> in {f.panel_label??f.panel}</>}</span>{' '}<span className="dim">{delivery(f)}</span>{' '}<span className="dim">{who(f.by)}</span></>
/** An expanded fire, like an expanded History row: the exact time, who, the copy,
 * how it was delivered and the fire's own metadata. */
function fireDetails(f:Fire){
  return <dl>
    <dt>Time</dt><dd>{fmtFull(f.at)}</dd><dt>By</dt><dd>{who(f.by)}</dd><dt>Event</dt><dd>{f.event}</dd><dt>Panel</dt><dd>{f.panel_label??f.panel}</dd>
    <dt>Delivery</dt><dd>{f.delivered?f.notice?"A notice, read at the agent's next turn":'Woke the agent with the event in its mail':'Not delivered: when it came due, the subscription was not armed, its agent could not receive app events, or the app no longer declared the event'}</dd>
    <dt>Event ID</dt><dd>{f.id}</dd>
    <pre>{JSON.stringify({event:f.event,id:f.id,panel:f.panel,by:f.by,delivered:f.delivered,notice:f.notice},null,2)}</pre>
  </dl>
}

/** One subscription (user 2026-10-27 m8ced6e920f63: "each row of the connections
 * list shows an agent link, a panel link, an event name, and can be expanded to see
 * a list of recent fires"). The agent and the panel are their mention links; a
 * subscription to every copy names no panel. Paused, Notice and Once show only
 * when they apply, beside the fire count. Expanded, the row lists its fires like
 * History: newest first, older ones as the list scrolls, new ones as they arrive. */
function ConnectionRow({slug,app,panel,row,world,focus,leave}:{slug:string;app:CustomApp;panel:CustomPanel;row:Connection;world:RefWorld;focus?:RefRoutes['onOpen'];leave:()=>void}){
  const [open,setOpen]=useState(false),region=useId()
  const agent=resolveRef({kind:'agent',org:slug,id:row.owner},world)
  const target=row.all_panels?null:resolveRef({kind:'panel',org:slug,id:row.panel??panel.id},world)
  const flags=[row.state==='paused'&&'Paused',row.notice&&'Notice',row.once&&'Once',plural(row.fired,'fire')].filter(Boolean).join(' · ')
  const read=(cursor:LogCursor)=>customAppsRequest<Fires>(slug,{action:'listener_fires',app:app.id,listener:row.id,limit:LOG_PAGE,...cursor}).then(page=>({items:page.fires,next_cursor:page.next_cursor}))
  return <li className={open?'open':undefined}>
    {/* The row toggles from anywhere but its links; the chevron is its keyboard control. */}
    <div className="custom-app-connection" onClick={e=>{if(!(e.target as Element).closest('button,a,input'))setOpen(o=>!o)}}>
      <button type="button" className="custom-app-connection-toggle" aria-expanded={open} aria-controls={open?region:undefined} aria-label={(open?'Hide':'Show')+' the fires of '+row.id} title={(open?'Hide':'Show')+' recent fires'} onClick={()=>setOpen(o=>!o)}/>
      <RefChip r={agent} onOpen={focus&&(r=>{leave();focus(r)})}/>
      {target?<RefChip r={target} onOpen={r=>{leave();openAppRef(slug,r.ref)}}/>:<span className="custom-app-connection-all">All copies</span>}
      <span className="custom-app-connection-event" title="Event">{row.event_name}</span>
      <span className="custom-app-connection-meta" title={row.reason??undefined}>{flags}</span>
    </div>
    {open&&<div id={region} className="custom-app-connection-fires">
      <p>Watchdog {row.id}: {row.state}, {row.notice?'delivers each fire as a notice':'wakes its agent on each fire'}{row.once?', once':''}.{row.reason?' '+row.reason:''}</p>
      <LogList slug={slug} label={'Fires of '+row.id} read={read} follows={change=>!!change.listeners||!change.panel} summary={fireSummary(!!row.all_panels)} details={fireDetails} empty="No fires delivered yet."/>
    </div>}
  </li>
}

/** Panel settings' Connections tab (user 2026-10-26: "put connections and fire
 * event on their own tabs"): the agent-owned listeners on this copy or on all
 * copies. Agents own their subscriptions; this tab only lists them. It is live
 * and has no buttons (user 2026-10-27 md11c3c790acf: "actually remove the refresh
 * button, make new or disappearing links change in realtime as they're
 * modified"): every watchdog write and every Apps change reads the loaded pages
 * again, one read at a time, and further pages load as the list's end comes into
 * view. A link leaves this window first when it sits in the middle of the screen,
 * as other windows do, so the agent or panel it opens is not hidden behind it. */
export function PanelConnections({slug,app,panel,leave=()=>{}}:{slug:string;app:CustomApp;panel:CustomPanel;leave?:()=>void}){
  const routes=useContext(AppsRefRoutes),refName=useRefNames(slug)
  const world=useMemo<RefWorld>(()=>routes?.world??{org:slug,refName},[routes,slug,refName])
  const [rows,setRows]=useState<Connection[]|null>(null),[next,setNext]=useState<number|null>(null),[error,setError]=useState('')
  const live=useRef({rows:[] as Connection[],next:null as number|null,busy:false,again:false,alive:true}),end=useRef<HTMLLIElement>(null)
  const page=(after?:number)=>customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200,...(after===undefined?{}:{after})})
  const show=(items:Connection[],more:number|null)=>{const s=live.current;s.rows=items;s.next=more;setRows(items);setNext(more);setError('')}
  // Every loaded page again from the start, so an added, removed or changed
  // subscription shows wherever it sits; a change meanwhile reads once more.
  const reload=async()=>{
    const s=live.current;if(s.busy){s.again=true;return}
    s.busy=true
    try{const want=Math.max(s.rows.length,1),items:Connection[]=[];let more:number|null=null
      do{const got:Connections=await page(more??undefined);items.push(...got.items);more=got.next_cursor}while(more!==null&&items.length<want)
      if(s.alive)show(items,more)}
    catch(e){if(s.alive)setError(String(e))}
    finally{s.busy=false;if(s.again&&s.alive){s.again=false;void reload()}}
  }
  const loadMore=async()=>{
    const s=live.current;if(s.next===null||s.busy)return
    s.busy=true
    try{const got=await page(s.next);if(s.alive)show([...s.rows,...got.items],got.next_cursor)}
    catch(e){if(s.alive)setError(String(e))}
    finally{s.busy=false;if(s.again&&s.alive){s.again=false;void reload()}}
  }
  useEffect(()=>{const s=live.current;s.alive=true;s.rows=[];s.next=null;void reload()
    const stop=onAppsLog(slug,change=>{if(change.listeners||!change.panel)void reload()})
    return()=>{s.alive=false;stop()}
  },[slug,app.id,panel.id])
  useLoadWhenSeen(end,next===null?null:String(next),()=>void loadMore())
  return <>
    <div className="set-group"><p className="dim">Agents subscribe with an app_listener watchdog. Pause, resume and remove use the agent's watchdog controls. The list follows them as they change; expand one to see its recent fires.</p>
      {rows===null?(!error&&<p className="dim">Loading…</p>):rows.length?<ul className="custom-app-connections" aria-label="Connections">
        {rows.map(row=><ConnectionRow key={row.id} slug={slug} app={app} panel={panel} row={row} world={world} focus={routes?.onOpen} leave={leave}/>)}
        {next!==null&&<li ref={end} className="custom-app-log-more" role="status">Loading more connections as you scroll</li>}
      </ul>:<p>No connected listeners for this copy.</p>}
    </div>
    {error&&<p role="alert">{error}</p>}
  </>
}

/** Panel settings' Fire event tab: the native control that broadcasts one
 * declared event from this copy. It never chooses an agent identity or silently
 * grants a wake or action; History shows the fire through the live change feed. */
export function PanelFireEvent({slug,app,panel}:{slug:string;app:CustomApp;panel:CustomPanel}){
  const [name,setName]=useState(app.events?.[0]?.name??''),[payload,setPayload]=useState('{}'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('')
  const fire=async()=>{
    setBusy(true);setError('');setResult('')
    try{const value=JSON.parse(payload);if(new TextEncoder().encode(JSON.stringify(value)).length>64*1024)throw Error('Event data exceeds 64 KiB.');const out=await customAppsRequest<{accepted:boolean;subscribers:number}>(slug,{action:'fire_event',panel:panel.id,name,payload:value});setResult(`Accepted for ${plural(out.subscribers,'subscribed listener')}.`)}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <>
    <div className="set-group"><p className="dim">From {panel.label}. This sends app data to eligible agents subscribed to this copy or all copies. Opening this tab fires nothing.</p>
      {app.events?.length?<><SetRow label="Declared event"><select aria-label="Declared event" value={name} disabled={busy} onChange={e=>setName(e.target.value)}>{app.events.map(e=><option key={e.name} value={e.name}>{e.name}</option>)}</select></SetRow>
        <p className="dim">{app.events.find(e=>e.name===name)?.description}</p>
        <label>Event data<textarea aria-label="Event JSON data" spellCheck={false} value={payload} disabled={busy} onChange={e=>setPayload(e.target.value)}/></label>
        <div className="custom-app-dialog-actions"><span/><button type="button" className="primary" disabled={busy||!name} onClick={()=>void fire()}>Fire event</button></div></>:<p>This app declares no named events.</p>}
      {result&&<p role="status">{result}</p>}
    </div>
    {error&&<p role="alert">{error}</p>}
  </>
}
