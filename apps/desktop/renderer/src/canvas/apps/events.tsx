import {createContext,useContext,useEffect,useId,useMemo,useRef,useState} from 'react'
import {customAppsRequest} from '../../api'
import {fmtFull,fmtShort} from '../../timefmt'
import {useLoadWhenSeen} from '../loadmore'
import {RefChip,resolveRef} from '../reflinks'
import type {RefRoutes,RefWorld} from '../reflinks'
import {useRefNames} from '../refnames'
import {WatchdogLink} from '../watchdoglink'
import {useDogRoute} from '../watchdogroute'
import {LOG_PAGE,LogList} from './loglist'
import type {LogCursor} from './loglist'
import {onAppsLog} from './store'
import type {CustomApp,CustomPanel,PanelEvent,PanelEvents} from './types'

interface Connection {id:string;owner:string;name?:string;event_name:string;panel:string|null;all_panels?:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
interface Connections {items:Connection[];next_cursor:number|null}
/** One finished delivery of a subscription's event (the engine's listener_fires),
 * with the fire's body as its History entry keeps it. */
interface Fire {seq:number;id:string;at:string;event:string;panel:string;panel_label?:string|null;by:string;delivered:boolean;notice:boolean;body?:string|null}
interface Fires {fires:Fire[];next_cursor:number|null}
/** A Connections row's event handed to Fire event; a new seq repeats a choice. */
export interface FireChoice {name:string;seq:number}

/** The engine's History row for one fired event: its metadata, and its body as
 * it was sent (user 2026-10-27 mc308cabf3c5f, replacing 2026-10-26's metadata only). */
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
/** A JSON text laid out two spaces a level without changing one token: strings,
 * numbers and key order stay exactly as sent; only the space between tokens changes. */
export function layoutJson(text:string){
  let out='',depth=0
  const line=()=>'\n'+'  '.repeat(depth)
  for(let i=0;i<text.length;i++){
    const c=text[i]!
    if(c==='"'){let j=i+1;while(j<text.length&&text[j]!=='"')j+=text[j]==='\\'?2:1;out+=text.slice(i,j+1);i=j;continue}
    if(c===' '||c==='\n'||c==='\r'||c==='\t')continue
    if(c==='{'||c==='['){
      // an empty object or array stays on its line
      let j=i+1;while(/\s/.test(text[j]??''))j++
      if(text[j]===(c==='{'?'}':']')){out+=c+text[j];i=j;continue}
      depth++;out+=c+line();continue
    }
    if(c==='}'||c===']'){depth=Math.max(0,depth-1);out+=line()+c;continue}
    out+=c===','?','+line():c===':'?': ':c
  }
  return out
}
const bytes=(text:string)=>new TextEncoder().encode(text).length
/** A fire's body (user 2026-10-27 mda08162683ef "this should show the event's body as
 * it was transmitted"): its size and its text, laid out, scrolling when long; a fire
 * from before bodies were kept, or whose entry outlived it, says so. */
const bodyDetails=(body:string|null|undefined)=><>
  <dt>Body</dt><dd>{body==null?'Not kept':`${plural(bytes(body),'byte')} as sent`}</dd>
  {body!=null&&<pre className="custom-app-event-body" aria-label="Event body" tabIndex={0}>{layoutJson(body)}</pre>}
</>
/** An expanded History row: the exact time, who, and the row's own data; a fire's
 * body as it was sent. */
function historyDetails(e:PanelEvent){
  const {payload,cause}=facts(e)
  return <dl>
    <dt>Time</dt><dd>{fmtFull(e.at)}</dd><dt>By</dt><dd>{who(e.actor)}</dd>
    {e.name===FIRED?<><dt>Event</dt><dd>{String(payload.event??'')}</dd><dt>Listeners</dt><dd>{Number(payload.subscribers??0)}</dd>{typeof payload.id==='string'&&<><dt>Event ID</dt><dd>{payload.id}</dd></>}{bodyDetails(e.body)}</>
      :<>{cause&&<><dt>Cause</dt><dd>{cause}</dd></>}<pre>{JSON.stringify(e.payload,null,2)}</pre></>}
  </dl>
}

/** Panel settings' History tab, the last one (user 2026-10-26: "remove activity
 * and put events on its own tab, as history"; "make history the last tab"): the
 * panel's fires, starts and stops as a live list (2026-10-27 md2006b10cf40). It
 * follows Apps changes and this panel's own fires; Connections and Fire event
 * have their own tabs. It opens on the list, with no intro line (user 2026-10-28
 * m1ebf5e3194c8: "and this one"); an empty History keeps its one line. */
export function PanelHistory({slug,panel}:{slug:string;panel:CustomPanel}){
  const read=(cursor:LogCursor)=>customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,limit:LOG_PAGE,...cursor}).then(page=>({items:page.events,next_cursor:page.next_cursor}))
  return <div className="set-group custom-app-log-group">
    <LogList slug={slug} label="History" read={read} follows={change=>!change.listeners&&(!change.panel||change.panel===panel.id)} summary={historySummary} details={historyDetails} empty="Nothing has fired, started or stopped in this panel yet."/>
  </div>
}

/** The shell's reference routes, handed down by AppsWorkspace (App's tree and
 * its agent focus): a Connections row's agent is a link like every agent link
 * (user 2026-10-27 m6ca9f88d5812). Without them the agent shows as identity
 * only. */
export const AppsRefRoutes=createContext<RefRoutes|null>(null)

const delivery=(f:Fire)=>f.delivered?f.notice?'Delivered as a notice':'Delivered':'Not delivered'
/** A subscription's fire on one line, like a History row: when, the event (and the
 * panel, for a subscription to all panels), how it was delivered, and who fired it. */
const fireSummary=(all:boolean)=>(f:Fire)=><><time dateTime={f.at}>{fmtShort(f.at)}</time>{' '}<span>Fired <strong>{f.event}</strong>{all&&<> in {f.panel_label??f.panel}</>}</span>{' '}<span className="dim">{delivery(f)}</span>{' '}<span className="dim">{who(f.by)}</span></>
/** An expanded fire, like an expanded History row: the exact time, who, the panel,
 * how it was delivered, and the fire's body as it was sent. */
function fireDetails(f:Fire){
  return <dl>
    <dt>Time</dt><dd>{fmtFull(f.at)}</dd><dt>By</dt><dd>{who(f.by)}</dd><dt>Event</dt><dd>{f.event}</dd><dt>Panel</dt><dd>{f.panel_label??f.panel}</dd>
    <dt>Delivery</dt><dd>{f.delivered?f.notice?"A notice, read at the agent's next turn":'Woke the agent with the event in its mail':'Not delivered: when it came due, the subscription was not armed, its agent could not receive app events, or the app no longer declared the event'}</dd>
    <dt>Event ID</dt><dd>{f.id}</dd>
    {bodyDetails(f.body)}
  </dl>
}

/** One subscription (user 2026-10-27 m8ced6e920f63: "each row of the connections
 * list shows an agent link, a panel link, an event name, and can be expanded to see
 * a list of recent fires"). The agent is its mention link, and the watchdog its
 * watchdog link (mbf41fed391e2: "include a link tomthe watchdog in the
 * conneftioncrow"), which opens the watchdog's window through the shell's
 * watchdog route and offers the watchdog menu. The list is one panel's
 * own, holding its subscriptions and those to every panel, so a row names no panel
 * (alpha.7 mbb46eeca4b5d: "dont acyually need the panel link here, the panel is
 * implicit"); a subscription to every panel says all panels, which is not implicit
 * (m55abf5a34460: "use panel nomenclature everywhere; say "all panels"").
 * The event is a link to Fire event (m930f15583b2c), which chooses it there unless
 * the app no longer declares it. Paused, Notice and Once show only when they
 * apply, beside the fire count. Expanded, the row lists its fires like History:
 * newest first, older ones as the list scrolls, new ones as they arrive. */
function ConnectionRow({slug,app,row,world,focus,leave,fireEvent}:{slug:string;app:CustomApp;row:Connection;world:RefWorld;focus?:RefRoutes['onOpen'];leave:()=>void;fireEvent:(name:string)=>void}){
  const [open,setOpen]=useState(false),region=useId()
  const agent=resolveRef({kind:'agent',org:slug,id:row.owner},world),dogs=useDogRoute()
  const declared=(app.events??[]).some(e=>e.name===row.event_name)
  const flags=[row.state==='paused'&&'Paused',row.notice&&'Notice',row.once&&'Once',plural(row.fired,'fire')].filter(Boolean).join(' · ')
  const read=(cursor:LogCursor)=>customAppsRequest<Fires>(slug,{action:'listener_fires',app:app.id,listener:row.id,limit:LOG_PAGE,...cursor}).then(page=>({items:page.fires,next_cursor:page.next_cursor}))
  return <li className={open?'open':undefined}>
    {/* The row toggles from anywhere but its links; the chevron is its keyboard control. */}
    <div className="custom-app-connection" onClick={e=>{if(!(e.target as Element).closest('button,a,input'))setOpen(o=>!o)}}>
      <button type="button" className="custom-app-connection-toggle" aria-expanded={open} aria-controls={open?region:undefined} aria-label={(open?'Hide':'Show')+' the fires of '+row.id} title={(open?'Hide':'Show')+' recent fires'} onClick={()=>setOpen(o=>!o)}/>
      <RefChip r={agent} onOpen={focus&&(r=>{leave();focus(r)})}/>
      <WatchdogLink id={row.id} name={row.name} org={slug} onOpen={dogs?(id=>{leave();dogs.open(id)}):undefined}/>
      {row.all_panels&&<span className="custom-app-connection-all">all panels</span>}
      <button type="button" className="custom-app-connection-event" title={declared?`Open Fire event with ${row.event_name} chosen`:`Open Fire event: this app no longer declares ${row.event_name}`} onClick={()=>fireEvent(row.event_name)}>{row.event_name}</button>
      <span className="custom-app-connection-meta" title={row.reason??undefined}>{flags}</span>
    </div>
    {open&&<div id={region} className="custom-app-connection-fires">
      <p>Watchdog {row.id}: {row.state}, {row.notice?'delivers each fire as a notice':'wakes its agent on each fire'}{row.once?', once':''}.{row.reason?' '+row.reason:''}</p>
      <LogList slug={slug} label={'Fires of '+row.id} read={read} follows={change=>!!change.listeners||!change.panel} summary={fireSummary(!!row.all_panels)} details={fireDetails} empty="No fires delivered yet."/>
    </div>}
  </li>
}

/** Panel settings' Connections tab (user 2026-10-26: "put connections and fire
 * event on their own tabs"): the agent-owned listeners on this panel or on all
 * panels. Agents own their subscriptions; this tab only lists them. It is live
 * and has no buttons (user 2026-10-27 md11c3c790acf: "actually remove the refresh
 * button, make new or disappearing links change in realtime as they're
 * modified"): every watchdog write and every Apps change reads the loaded pages
 * again, one read at a time, and further pages load as the list's end comes into
 * view. The agent and watchdog links leave this window first when it sits in the
 * middle of the screen, as other windows do, so what they open is not hidden
 * behind it; an event link stays, handing its event to fireEvent (Panel settings' Fire event tab).
 * The tab opens on the list, with no intro text (user 2026-10-28 m967c09464607: "remove
 * this blurb"); an empty list keeps its one line. */
export function PanelConnections({slug,app,panel,fireEvent,leave=()=>{}}:{slug:string;app:CustomApp;panel:CustomPanel;fireEvent:(name:string)=>void;leave?:()=>void}){
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
    <div className="set-group">
      {rows===null?(!error&&<p className="dim">Loading…</p>):rows.length?<ul className="custom-app-connections" aria-label="Connections">
        {rows.map(row=><ConnectionRow key={row.id} slug={slug} app={app} row={row} world={world} focus={routes?.onOpen} leave={leave} fireEvent={fireEvent}/>)}
        {next!==null&&<li ref={end} className="custom-app-log-more" role="status">Loading more connections as you scroll</li>}
      </ul>:<p>No connected listeners for this panel.</p>}
    </div>
    {error&&<p role="alert">{error}</p>}
  </>
}

/** A fire of the chosen event on one line, as History shows it less the event:
 * when, how many listeners it reached, and who fired it. */
function eventFireSummary(e:PanelEvent){
  const {payload}=facts(e)
  return <><time dateTime={e.at}>{fmtShort(e.at)}</time>{' '}<span>{plural(Number(payload.subscribers??0),'listener')}</span>{' '}<span className="dim">{who(e.actor)}</span></>
}

/** Panel settings' Fire event tab (user 2026-10-27 m58d8efef52d9: "clean up this
 * tab, remove redundant or irrelevant information, streamline the interface"): the
 * event and Fire on one line, the event's declared description as the only hint,
 * then its data, where an empty box sends {}. Below are that event's fires from
 * this panel (m46d1f8a8e39e: "selecting an event shows that per-event fire history
 * as a lazily-loading, scrollable list, similar to the history tabs"): History's
 * list and details, read for that event only and followed live, a fire from here
 * included. It never chooses an agent identity or grants a wake or action. A
 * Connections row's event arrives as a new choice (user 2026-10-27 m930f15583b2c:
 * "opens the fire event tab and preselects the chosen event"): a declared event is
 * chosen as the picker chooses it, its data template included; an undeclared one
 * leaves the choice alone. Either way the picker takes the focus. */
export function PanelFireEvent({slug,app,panel,choice}:{slug:string;app:CustomApp;panel:CustomPanel;choice?:FireChoice|null}){
  const events=app.events??[],declares=(name?:string)=>events.some(e=>e.name===name)
  const [name,setName]=useState(choice&&declares(choice.name)?choice.name:events[0]?.name??''),[draft,setDraft]=useState({key:'',value:'',edited:false}),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [taken,setTaken]=useState(choice?.seq),picker=useRef<HTMLSelectElement>(null)
  if(choice&&choice.seq!==taken){setTaken(choice.seq);if(declares(choice.name)){setName(choice.name);setError('')}}
  useEffect(()=>{if(choice)picker.current?.focus()},[choice?.seq])
  // The choice holds while its event is still declared; the declarations are live.
  const event=events.find(e=>e.name===name)??events[0]
  const key=JSON.stringify([slug,app.id,panel.id,event?.name]),latest=useRef({key,seq:-1})
  if(latest.current.key!==key)latest.current={key,seq:-1}
  const selection=latest.current,payload=draft.edited||draft.key===key?draft.value:''
  if(!event)return <div className="set-group"><p>This app declares no events.</p></div>
  const fire=async()=>{
    setBusy(true);setError('')
    try{const value:unknown=payload.trim()?JSON.parse(payload):{};if(new TextEncoder().encode(JSON.stringify(value)).length>64*1024)throw Error('Event data exceeds 64 KiB.');await customAppsRequest(slug,{action:'fire_event',panel:panel.id,name:event.name,payload:value})}catch(e){setError(String(e))}finally{setBusy(false)}
  }
  const read=(cursor:LogCursor)=>customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,name:event.name,limit:LOG_PAGE,...cursor}).then(page=>{
    // Reuse this list's newest body, never an older page or an obsolete choice.
    // A typed draft (even one the user cleared) is never replaced by history.
    const newest=page.events.reduce<PanelEvent|undefined>((a,b)=>!a||b.seq>a.seq?b:a,undefined)
    if(!('before' in cursor)&&latest.current===selection&&newest&&newest.seq>selection.seq){
      selection.seq=newest.seq
      let value=''
      if(newest.body!=null){try{JSON.parse(newest.body);value=layoutJson(newest.body)}catch{/* old invalid data offers no template */}}
      setDraft(old=>old.edited?old:{key,value,edited:false})
    }
    return {items:page.events,next_cursor:page.next_cursor}
  })
  return <div className="set-group custom-app-log-group custom-app-fire">
    <div className="custom-app-fire-bar">
      <select ref={picker} aria-label="Declared event" value={event.name} disabled={busy} onChange={e=>{setName(e.target.value);setError('')}}>{events.map(e=><option key={e.name} value={e.name}>{e.name}</option>)}</select>
      <button type="button" className="primary" disabled={busy} title="Send this event and its data to the agents listening for it" onClick={()=>void fire()}>Fire</button>
    </div>
    {event.description&&<p className="dim">{event.description}</p>}
    <textarea aria-label="Event JSON data" placeholder="Event data as JSON; empty sends {}" spellCheck={false} value={payload} disabled={busy} onChange={e=>{setDraft({key,value:e.target.value,edited:true});setError('')}}/>
    {error&&<p role="alert">{error}</p>}
    <p className="dim custom-app-fire-caption">Fires from this panel</p>
    <LogList key={event.name} slug={slug} label={'Fires of '+event.name} read={read} follows={change=>!change.listeners&&(!change.panel||change.panel===panel.id)} summary={eventFireSummary} details={historyDetails} empty="None yet."/>
  </div>
}

/** App settings' Events tab (user 2026-10-27 me1e204ce94e4: "add an "events" tab
 * to the custom app settings panel that lists all of an app's declared events"):
 * each declared event's name and description, in declaration order, read-only.
 * The app comes from the live store, so the list follows its definition. */
export function AppEvents({app}:{app:CustomApp}){
  const events=app.events??[]
  return <div className="set-group">{events.length?<ul className="custom-app-events" aria-label="Declared events">
    {events.map(e=><li key={e.name}><span className="custom-app-event-name">{e.name}</span>{e.description&&<span className="custom-app-event-description">{e.description}</span>}</li>)}
  </ul>:<p>This app declares no events.</p>}</div>
}
