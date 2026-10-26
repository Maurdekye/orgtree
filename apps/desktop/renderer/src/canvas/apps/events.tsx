import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SetGroup,SetRow} from '../settingskit'
import type {CustomApp,CustomPanel,PanelEvent,PanelEvents} from './types'

interface Connection {id:string;owner:string;event_name:string;panel:string|null;all_panels?:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
interface Connections {items:Connection[];next_cursor:number|null}

/** The engine's metadata row for one fired event; its data went only to the
 * subscribed listeners' mail, never into this log. */
const FIRED='event.fired'
const plural=(n:number,one:string)=>`${n} ${one}${n===1?'':'s'}`

/** The copy's own retained log (the engine keeps its latest 256 entries), read
 * in at most two pages and shown newest first. */
async function loadHistory(slug:string,panel:string){
  const page=await customAppsRequest<PanelEvents>(slug,{action:'events',panel,limit:200});let all=page.events
  if(page.next_cursor!==null)all=[...all,...(await customAppsRequest<PanelEvents>(slug,{action:'events',panel,after:page.next_cursor,limit:200})).events]
  return all.reverse()
}

function HistoryEntry({event}:{event:PanelEvent}){
  const fired=event.name===FIRED?event.payload as {event?:unknown;subscribers?:unknown}|null:null
  const empty=event.payload===null||(typeof event.payload==='object'&&!Array.isArray(event.payload)&&!Object.keys(event.payload as object).length)
  return <li><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> {event.actor}: {fired
    ?<>fired <strong>{String(fired.event??'event')}</strong> · {plural(Number(fired.subscribers??0),'subscribed listener')}</>
    :<>{event.name}{!empty&&<pre>{JSON.stringify(event.payload,null,2)}</pre>}</>}</li>
}

/** Panel settings' History tab (user 2026-10-26: "remove activity and put events
 * on its own tab, as history"): the copy's log, its connections and the native
 * Fire event control. Native controls only: agents own their subscriptions, and
 * this UI never chooses an agent identity or silently grants a wake or action. */
export function PanelHistory({slug,app,panel}:{slug:string;app:CustomApp;panel:CustomPanel}){
  const [history,setHistory]=useState<PanelEvent[]|null>(null),[name,setName]=useState(app.events?.[0]?.name??''),[payload,setPayload]=useState('{}'),[rows,setRows]=useState<Connection[]>([]),[next,setNext]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('')
  const refresh=async()=>{try{setHistory(await loadHistory(slug,panel.id))}catch(e){setError(String(e))}}
  const load=async(after?:number)=>{try{const page=await customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200,...(after===undefined?{}:{after})});setRows(old=>after===undefined?page.items:[...old,...page.items]);setNext(page.next_cursor)}catch(e){setError(String(e))}}
  useEffect(()=>{let alive=true;void loadHistory(slug,panel.id).then(all=>{if(alive)setHistory(all)}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[slug,panel.id,panel.event_seq])
  useEffect(()=>{let alive=true;void customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200}).then(page=>{if(alive){setRows(page.items);setNext(page.next_cursor)}}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[slug,app.id,panel.id])
  const fire=async()=>{
    setBusy(true);setError('');setResult('')
    try{const value=JSON.parse(payload);if(new TextEncoder().encode(JSON.stringify(value)).length>64*1024)throw Error('Event data exceeds 64 KiB.');const out=await customAppsRequest<{accepted:boolean;subscribers:number}>(slug,{action:'fire_event',panel:panel.id,name,payload:value});setResult(`Accepted for ${plural(out.subscribers,'subscribed listener')}.`);void refresh()}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <>
    <SetGroup title="Event history" subtitle="Opens, changes, state saves and events of this copy, newest first. A fired event shows its listener count; its data goes only to the subscribed agents.">
      {history===null?<p className="dim">Loading history…</p>:history.length?<ol className="custom-app-activity custom-app-history">{history.map(e=><HistoryEntry key={e.seq} event={e}/>)}</ol>:<p className="dim">Nothing has happened in this copy yet.</p>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>void refresh()}>Refresh history</button></div>
    </SetGroup>
    <SetGroup title="Connections"><p className="dim">Agents subscribe with an app_listener watchdog. Pause, resume and remove use the agent's watchdog controls.</p>
      {rows.length?<ul className="custom-app-connections">{rows.map(row=><li key={row.id}><strong>{row.id}</strong><span>{row.event_name} · {row.all_panels?'All copies':panel.label} · {row.state} · {row.notice?'Notice':'Wake'}{row.once?' · Once':''} · {row.fired} fires</span>{row.reason&&<small>{row.reason}</small>}</li>)}</ul>:<p>No connected listeners for this copy.</p>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>void load()}>Refresh connections</button>{next!==null&&<button type="button" onClick={()=>void load(next)}>More connections</button>}</div>
    </SetGroup>
    <SetGroup title="Fire event"><p className="dim">From {panel.label}. This sends app data to eligible agents subscribed to this copy or all copies. Opening this panel fires nothing.</p>
      {app.events?.length?<><SetRow label="Declared event"><select aria-label="Declared event" value={name} disabled={busy} onChange={e=>setName(e.target.value)}>{app.events.map(e=><option key={e.name} value={e.name}>{e.name}</option>)}</select></SetRow>
        <p className="dim">{app.events.find(e=>e.name===name)?.description}</p>
        <label>Event data<textarea aria-label="Event JSON data" spellCheck={false} value={payload} disabled={busy} onChange={e=>setPayload(e.target.value)}/></label>
        <div className="custom-app-dialog-actions"><span/><button type="button" className="primary" disabled={busy||!name} onClick={()=>void fire()}>Fire event</button></div></>:<p>This app declares no named events.</p>}
      {result&&<p role="status">{result}</p>}
    </SetGroup>
    {error&&<p role="alert">{error}</p>}
  </>
}
