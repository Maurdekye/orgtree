import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SetRow} from '../settingskit'
import type {CustomApp,CustomPanel,PanelEvent,PanelEvents} from './types'

interface Connection {id:string;owner:string;event_name:string;panel:string|null;all_panels?:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
interface Connections {items:Connection[];next_cursor:number|null}

/** The engine's metadata row for one fired event; its data went only to the
 * subscribed listeners' mail, never into this log. */
const FIRED='event.fired'
const plural=(n:number,one:string)=>`${n} ${one}${n===1?'':'s'}`

/** The copy's History (the engine keeps its latest 256 rows apart from messages), read
 * in at most two pages and shown newest first. */
async function loadHistory(slug:string,panel:string){
  const page=await customAppsRequest<PanelEvents>(slug,{action:'events',panel,limit:200});let all=page.events
  if(page.next_cursor!==null)all=[...all,...(await customAppsRequest<PanelEvents>(slug,{action:'events',panel,after:page.next_cursor,limit:200})).events]
  return all.reverse()
}

/** The control or cause behind a start or stop; a reason the engine records wins. */
const CAUSE:Record<string,string>={'panel.started':'Start running','panel.stopped':'Power off','stop all':'Stop all'}
/** History's rows (user 2026-10-26 md6edfebc1975): a fire as its metadata, and
 * the copy starting or stopping with its cause. Anything else (an older engine's
 * row) shows by name. */
function HistoryEntry({event}:{event:PanelEvent}){
  const payload=event.payload as {event?:unknown;subscribers?:unknown;reason?:unknown}|null
  const power=event.name==='panel.started'?'started':event.name==='panel.stopped'?'stopped':null
  const reason=typeof payload?.reason==='string'?payload.reason:null,cause=reason?CAUSE[reason]??reason:CAUSE[event.name]
  const empty=event.payload===null||(typeof event.payload==='object'&&!Array.isArray(event.payload)&&!Object.keys(event.payload as object).length)
  return <li><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> {event.actor}: {event.name===FIRED
    ?<>fired <strong>{String(payload?.event??'event')}</strong> · {plural(Number(payload?.subscribers??0),'subscribed listener')}</>
    :power?<>{power} ({cause})</>
    :<>{event.name}{!empty&&<pre>{JSON.stringify(event.payload,null,2)}</pre>}</>}</li>
}

/** Panel settings' History tab, the last one (user 2026-10-26: "remove activity
 * and put events on its own tab, as history"; "make history the last tab"): the
 * copy's log, newest first. Connections and Fire event have their own tabs. */
export function PanelHistory({slug,panel}:{slug:string;panel:CustomPanel}){
  const [history,setHistory]=useState<PanelEvent[]|null>(null),[error,setError]=useState('')
  const refresh=async()=>{try{setHistory(await loadHistory(slug,panel.id))}catch(e){setError(String(e))}}
  useEffect(()=>{let alive=true;void loadHistory(slug,panel.id).then(all=>{if(alive)setHistory(all)}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[slug,panel.id,panel.event_seq])
  return <>
    <div className="set-group"><p className="dim">Fired events agents can listen to, and this copy starting and stopping, newest first. A fired event shows its listener count; its data goes only to the subscribed agents.</p>
      {history===null?<p className="dim">Loading history…</p>:history.length?<ol className="custom-app-activity custom-app-history">{history.map(e=><HistoryEntry key={e.seq} event={e}/>)}</ol>:<p className="dim">Nothing has fired, started or stopped in this copy yet.</p>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>void refresh()}>Refresh history</button></div>
    </div>
    {error&&<p role="alert">{error}</p>}
  </>
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
 * grants a wake or action; `fired` lets the History tab reload its log. */
export function PanelFireEvent({slug,app,panel,fired}:{slug:string;app:CustomApp;panel:CustomPanel;fired:()=>void}){
  const [name,setName]=useState(app.events?.[0]?.name??''),[payload,setPayload]=useState('{}'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('')
  const fire=async()=>{
    setBusy(true);setError('');setResult('')
    try{const value=JSON.parse(payload);if(new TextEncoder().encode(JSON.stringify(value)).length>64*1024)throw Error('Event data exceeds 64 KiB.');const out=await customAppsRequest<{accepted:boolean;subscribers:number}>(slug,{action:'fire_event',panel:panel.id,name,payload:value});setResult(`Accepted for ${plural(out.subscribers,'subscribed listener')}.`);fired()}catch(e){setError(String(e))}finally{setBusy(false)}
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
