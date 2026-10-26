import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SetGroup,SetRow} from '../settingskit'
import {AppDialog} from './dialog'
import type {CustomApp,CustomPanel} from './types'

interface Connection {id:string;owner:string;event_name:string;panel:string|null;all_panels?:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
interface Connections {items:Connection[];next_cursor:number|null}

/** Native controls only. Agents own their subscriptions; this UI never chooses
 * an agent identity or silently creates a wake/action grant for that agent. */
export function AppEvents({slug,app,panel,close}:{slug:string;app:CustomApp;panel:CustomPanel;close:()=>void}){
  const [name,setName]=useState(app.events?.[0]?.name??''),[payload,setPayload]=useState('{}'),[rows,setRows]=useState<Connection[]>([]),[next,setNext]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('')
  const load=async(after?:number)=>{try{const page=await customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200,...(after===undefined?{}:{after})});setRows(old=>after===undefined?page.items:[...old,...page.items]);setNext(page.next_cursor)}catch(e){setError(String(e))}}
  useEffect(()=>{let alive=true;void customAppsRequest<Connections>(slug,{action:'listeners',app:app.id,panel:panel.id,limit:200}).then(page=>{if(alive){setRows(page.items);setNext(page.next_cursor)}}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[slug,app.id,panel.id])
  const fire=async()=>{
    setBusy(true);setError('');setResult('')
    try{const value=JSON.parse(payload);if(new TextEncoder().encode(JSON.stringify(value)).length>64*1024)throw Error('Event data exceeds 64 KiB.');const out=await customAppsRequest<{accepted:boolean;subscribers:number}>(slug,{action:'fire_event',panel:panel.id,name,payload:value});setResult(`Accepted for ${out.subscribers} subscribed listener${out.subscribers===1?'':'s'}.`)}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  return <AppDialog title="App events" label="App events" close={close}>
    <SetGroup title="Fire event"><p className="dim">From {panel.label}. This sends app data to eligible agents subscribed to this copy or all copies. Opening this panel fires nothing.</p>
      {app.events?.length?<><SetRow label="Declared event"><select aria-label="Declared event" value={name} disabled={busy} onChange={e=>setName(e.target.value)}>{app.events.map(e=><option key={e.name} value={e.name}>{e.name}</option>)}</select></SetRow>
        <p className="dim">{app.events.find(e=>e.name===name)?.description}</p>
        <label>Event data<textarea aria-label="Event JSON data" spellCheck={false} value={payload} disabled={busy} onChange={e=>setPayload(e.target.value)}/></label>
        <div className="custom-app-dialog-actions"><span/><button type="button" className="primary" disabled={busy||!name} onClick={()=>void fire()}>Fire event</button></div></>:<p>This app declares no named events.</p>}
      {result&&<p role="status">{result}</p>}{error&&<p role="alert">{error}</p>}
    </SetGroup>
    <SetGroup title="Connections"><p className="dim">Agents subscribe with an app_listener watchdog. Links grant no subscription. Pause, resume and remove use the agent's watchdog controls.</p>
      {rows.length?<ul className="custom-app-connections">{rows.map(row=><li key={row.id}><strong>{row.id}</strong><span>{row.event_name} · {row.all_panels?'All copies':panel.label} · {row.state} · {row.notice?'Notice':'Wake'}{row.once?' · Once':''} · {row.fired} fires</span>{row.reason&&<small>{row.reason}</small>}</li>)}</ul>:<p>No connected listeners for this copy.</p>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>void load()}>Refresh connections</button>{next!==null&&<button type="button" onClick={()=>void load(next)}>More connections</button>}</div>
    </SetGroup>
  </AppDialog>
}
