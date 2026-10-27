import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {fmtFull,fmtShort} from '../../timefmt'
import {SetRow} from '../settingskit'
import {LOG_PAGE,LogList} from './loglist'
import type {LogCursor} from './loglist'
import type {CustomApp,CustomPanel,PanelEvent,PanelEvents} from './types'

interface Connection {id:string;owner:string;event_name:string;panel:string|null;all_panels?:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
interface Connections {items:Connection[];next_cursor:number|null}

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
    <LogList slug={slug} label="History" read={read} follows={change=>!change.panel||change.panel===panel.id} summary={historySummary} details={historyDetails} empty="Nothing has fired, started or stopped in this copy yet."/>
  </div>
}

/** Panel settings' Connections tab (user 2026-10-26: "put connections and fire
 * event on their own tabs"): the agent-owned listeners on this copy or on all
 * copies. Agents own their subscriptions; this tab only lists them. */
export function PanelConnections({slug,app,panel}:{slug:string;app:CustomApp;panel:CustomPanel}){
  const [rows,setRows]=useState<Connection[]>([]),[next,setNext]=useState<number|null>(null),[error,setError]=useState('')
  const load=async(after?:number)=>{try{const page=await customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200,...(after===undefined?{}:{after})});setRows(old=>after===undefined?page.items:[...old,...page.items]);setNext(page.next_cursor)}catch(e){setError(String(e))}}
  useEffect(()=>{let alive=true;void customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200}).then(page=>{if(alive){setRows(page.items);setNext(page.next_cursor)}}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[slug,app.id,panel.id])
  return <>
    <div className="set-group"><p className="dim">Agents subscribe with an app_listener watchdog. Pause, resume and remove use the agent's watchdog controls.</p>
      {rows.length?<ul className="custom-app-connections">{rows.map(row=><li key={row.id}><strong>{row.id}</strong><span>{row.event_name} · {row.all_panels?'All copies':panel.label} · {row.state} · {row.notice?'Notice':'Wake'}{row.once?' · Once':''} · {row.fired} fires</span>{row.reason&&<small>{row.reason}</small>}</li>)}</ul>:<p>No connected listeners for this copy.</p>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>void load()}>Refresh connections</button>{next!==null&&<button type="button" onClick={()=>void load(next)}>More connections</button>}</div>
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
