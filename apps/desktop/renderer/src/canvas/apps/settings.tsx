import {useEffect,useMemo,useState} from 'react'
import {customAppsRequest} from '../../api'
import {useSurfaceDocument} from '../../popout'
import {SetGroup,SetRow} from '../settingskit'
import {changeApps,useApps} from './store'
import {AppDialog} from './dialog'
import {AppPermissions} from './permissions'
import {AppEvents} from './events'
import {AppExport,saveAppJson} from './portable'
import {appPlacement} from './placement'
import type {AppPage,CustomApp,CustomPanel,PanelEvents} from './types'

export function StateEditor({slug,panel,app,close}:{slug:string;panel:CustomPanel;app:CustomApp;close:()=>void}){
  const owner=useSurfaceDocument(),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(true),[rev,setRev]=useState(panel.rev)
  useEffect(()=>{let alive=true;void customAppsRequest<CustomPanel>(slug,{action:'panel_get',panel:panel.id}).then(p=>{if(alive){setText(JSON.stringify(p.state??{},null,2));setRev(p.rev);setBusy(false)}}).catch(e=>{if(alive){setError(String(e));setBusy(false)}});return()=>{alive=false}},[slug,panel.id])
  const value=()=>{if(new TextEncoder().encode(text).length>2*1024*1024)throw Error('State exceeds 2 MiB.');const v:unknown=JSON.parse(text);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('State must be a JSON object.');return v}
  const save=async()=>{try{setBusy(true);await changeApps(slug,{action:'state_set',panel:panel.id,expected_rev:rev,state:value()});close()}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <AppDialog title={`${panel.label}: state`} close={close}>
    <p className="dim">Each panel keeps its own JSON data. Save reports a conflict if another edit arrived.</p>
    <textarea aria-label="Panel JSON state" spellCheck={false} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/>
    {error&&<p role="alert">{error}</p>}
    <div className="custom-app-dialog-actions"><label className="button">Import<input type="file" accept="application/json,.json" hidden onChange={async e=>{try{const f=e.target.files?.[0];if(!f)return;if(f.size>2*1024*1024)throw Error('State exceeds 2 MiB.');const text=await f.text();JSON.parse(text);setText(text);setError('')}catch(error){setError(String(error))}}}/></label>
      <button type="button" onClick={()=>{try{saveAppJson(owner,panel.label+'.json',value())}catch(e){setError(String(e))}}}>Export</button>
      <button type="button" onClick={async()=>{try{await owner.defaultView?.navigator.clipboard.writeText(JSON.stringify(value(),null,2))}catch(e){setError(String(e))}}}>Copy</button>
      <button type="button" onClick={async()=>{try{const a=await customAppsRequest<CustomApp>(slug,{action:'app_get',app:app.id});setText(JSON.stringify(a.definition?.initial_state??{},null,2))}catch(e){setError(String(e))}}}>Reset</button>
      <span/><button type="button" onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void save()}>Save</button></div>
  </AppDialog>
}

export function AppSettings({slug,app,panel,close,owner}:{slug:string;app:CustomApp;panel?:CustomPanel;close:()=>void;owner?:Document}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[saved,setSaved]=useState<CustomPanel[]>(panel?[panel]:[]),[selected,setSelected]=useState(panel?.id??''),[view,setView]=useState<'state'|'rename'|'links'|'activity'|'events'|'permissions'|'delete-panel'|'delete-app'|null>(null),[input,setInput]=useState(''),[error,setError]=useState(''),[events,setEvents]=useState<PanelEvents['events']>([])
  const a=data.apps.find(a=>a.id===app.id)??app,document=owner??currentOwner,[next,setNext]=useState<string|null>(null)
  useEffect(()=>{let alive=true;void customAppsRequest<AppPage<CustomPanel>>(slug,{action:'list',kind:'panels',app:app.id,limit:200}).then(page=>{if(alive){setSaved(page.items);setNext(page.next_cursor);setSelected(id=>id||[...page.items].sort((a,b)=>b.used_at.localeCompare(a.used_at))[0]?.id||'')}}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[slug,app.id])
  const copies=useMemo(()=>[...new Map([...saved,...data.panels].filter(p=>p.app===app.id).map(p=>[p.id,p])).values()],[saved,data.panels,app.id]),p=copies.find(p=>p.id===selected)??copies[0]
  const update=async(fields:Record<string,unknown>)=>{if(!p)return;try{await changeApps(slug,{action:'panel_update',panel:p.id,expected_rev:p.rev,...fields});setView(null);setError('')}catch(e){setError(String(e))}}
  const show=(next:typeof view)=>{setView(next);setError('');setInput(next==='rename'?p?.label??'':next==='links'?p?.linked_agents.join('\n')??'':'');if(next==='activity'&&p)void customAppsRequest<PanelEvents>(slug,{action:'events',panel:p.id,limit:200}).then(async page=>{let all=page.events;if(page.next_cursor!==null){const next=await customAppsRequest<PanelEvents>(slug,{action:'events',panel:p.id,after:page.next_cursor,limit:200});all=[...all,...next.events]}setEvents(all.reverse())}).catch(e=>setError(String(e)))}
  const place=(mode:CustomPanel['placement']['mode'])=>{if(p)void update({placement:appPlacement(slug,p,mode,document)})}
  const more=async()=>{try{const page=await customAppsRequest<AppPage<CustomPanel>>(slug,{action:'list',kind:'panels',app:app.id,after:next,limit:200});setSaved(old=>[...old,...page.items]);setNext(page.next_cursor)}catch(e){setError(String(e))}}
  return <><AppDialog title={`${a.name} - App settings`} label="App settings" org={slug} kind={`custom-app-settings:${app.id}:${panel?.id??'app'}`} pinnable close={close} owner={document}>
    {error&&<p role="alert">{error}</p>}
    <SetGroup title="App"><p className="dim">{a.description}</p><SetRow label="Created by">{a.created_by}</SetRow>
      <SetRow label="Permissions" hint="Applies to every copy; links grant no authority."><button type="button" onClick={()=>show('permissions')}>Permissions…</button></SetRow>
      <AppExport slug={slug} app={a} owner={document}/>
      <SetRow label="Delete app" hint="Removes the definition and every saved panel."><button type="button" className="danger" onClick={()=>show('delete-app')}>Delete app…</button></SetRow>
    </SetGroup>
    <SetGroup title="This panel"><SetRow label="Saved panel">{copies.length?<select aria-label="Saved panel" value={p?.id??''} onChange={e=>setSelected(e.target.value)}>{copies.map(p=><option key={p.id} value={p.id}>{p.label}{p.open?'':' (closed)'}</option>)}</select>:<span className="dim">No saved panels</span>}{next&&<button type="button" onClick={()=>void more()}>More saved panels</button>}</SetRow>
      {p?<><SetRow label="State" hint="Independent JSON data for this copy."><button type="button" onClick={()=>show('state')}>State…</button></SetRow>
        <SetRow label="Rename"><button type="button" onClick={()=>show('rename')}>Rename…</button></SetRow>
        <SetRow label="Linked agents"><button type="button" onClick={()=>show('links')}>Linked agents…</button></SetRow>
        <SetRow label="Activity"><button type="button" onClick={()=>show('activity')}>Activity…</button></SetRow>
        <SetRow label="Events" hint="Declared broadcasts and agent-owned connections."><button type="button" onClick={()=>show('events')}>Events…</button></SetRow>
        <SetRow label="Duplicate"><button type="button" onClick={()=>void changeApps(slug,{action:'panel_duplicate',panel:p.id,expected_rev:p.rev}).catch(e=>setError(String(e)))}>Duplicate</button></SetRow>
        <SetRow label="Placement"><button type="button" onClick={()=>place('float')}>Float</button><button type="button" onClick={()=>place('screen')}>Pin to screen</button><button type="button" onClick={()=>place('canvas')}>Pin to canvas</button></SetRow>
        <SetRow label="Delete panel" hint="Removes this copy and its saved data."><button type="button" className="danger" onClick={()=>show('delete-panel')}>Delete panel…</button></SetRow></>:<button type="button" onClick={()=>void changeApps<CustomPanel>(slug,{action:'panel_open',app:a.id,new:true}).then(p=>setSelected(p.id)).catch(e=>setError(String(e)))}>+ New panel</button>}
    </SetGroup>
  </AppDialog>
  {view==='state'&&p&&<StateEditor slug={slug} app={a} panel={p} close={()=>setView(null)}/>}
  {view==='permissions'&&<AppPermissions slug={slug} app={a} close={()=>setView(null)}/>}
  {view==='events'&&p&&<AppEvents key={p.id} slug={slug} app={a} panel={p} close={()=>setView(null)}/>}
  {(view==='rename'||view==='links')&&p&&<AppDialog title={view==='rename'?'Rename panel':'Linked agents'} close={()=>setView(null)}><label>{view==='rename'?'Label':'Agent names, one per line'}<textarea aria-label={view==='rename'?'Panel label':'Linked agent names'} value={input} onChange={e=>setInput(e.target.value)}/></label><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="primary" onClick={()=>void update(view==='rename'?{label:input}:{linked_agents:input.split(/[\n,]/).map(x=>x.trim().replace(/^@/,'')).filter(Boolean)})}>Save</button></div></AppDialog>}
  {view==='activity'&&<AppDialog title="Panel activity" close={()=>setView(null)}><ol className="custom-app-activity">{events.map(e=><li key={e.seq}><time>{new Date(e.at).toLocaleString()}</time> {e.actor}: {e.name}<pre>{JSON.stringify(e.payload,null,2)}</pre></li>)}</ol></AppDialog>}
  {(view==='delete-app'||view==='delete-panel')&&<AppDialog title={view==='delete-app'?'Delete app':'Delete panel'} close={()=>setView(null)}><p>{view==='delete-app'?`Delete ${a.name}, all its panels and their saved state?`:`Delete ${p?.label} and its saved state?`}</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,view==='delete-app'?{action:'app_delete',app:a.id,expected_rev:a.rev,delete_panels:true}:{action:'panel_delete',panel:p?.id,expected_rev:p?.rev}).then(()=>{setView(null);if(view==='delete-app')close();else{setSaved(old=>old.filter(row=>row.id!==p?.id));setSelected('')}}).catch(e=>setError(String(e)))}>{view==='delete-app'?'Delete app and panels':'Delete panel'}</button></div></AppDialog>}
  </>
}
