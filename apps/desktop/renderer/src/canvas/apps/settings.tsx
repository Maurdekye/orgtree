import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SurfaceDocumentOwner,useSurfaceDocument} from '../../popout'
import {SetGroup,SetRow} from '../settingskit'
import {changeApps,useApps} from './store'
import {AppDialog} from './dialog'
import {AppPermissions} from './permissions'
import {AppEvents} from './events'
import {AppExport,saveAppJson} from './portable'
import {appPlacement} from './placement'
import type {CustomApp,CustomPanel,PanelEvents} from './types'

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

/** App-wide settings never choose a saved copy or start its HTML. */
export function AppSettings({slug,app,close,owner}:{slug:string;app:CustomApp;close:()=>void;owner?:Document}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[view,setView]=useState<'permissions'|'delete-app'|null>(null),[error,setError]=useState('')
  const a=data.apps.find(a=>a.id===app.id)??app,document=owner??currentOwner
  return <SurfaceDocumentOwner owner={document}><AppDialog title={a.name+' - App settings'} label="App settings" org={slug} kind={'custom-app-settings:'+app.id} pinnable close={close} owner={document}>
    {error&&<p role="alert">{error}</p>}
    <SetGroup title="App"><p className="dim">{a.description}</p><SetRow label="Created by">{a.created_by}</SetRow>
      <SetRow label="Permissions" hint="Applies to every copy; links grant no authority."><button type="button" onClick={()=>setView('permissions')}>Permissions…</button></SetRow>
      <AppExport slug={slug} app={a} owner={document}/>
      <SetRow label="Delete app" hint="Removes the definition and every saved panel."><button type="button" className="danger" onClick={()=>setView('delete-app')}>Delete app…</button></SetRow>
    </SetGroup>
  </AppDialog>
  {view==='permissions'&&<AppPermissions slug={slug} app={a} close={()=>setView(null)}/>}
  {view==='delete-app'&&<AppDialog title="Delete app" close={()=>setView(null)}><p>Delete {a.name}, all its panels and their saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'app_delete',app:a.id,expected_rev:a.rev,delete_panels:true}).then(close).catch(e=>setError(String(e)))}>Delete app and panels</button></div></AppDialog>}
  </SurfaceDocumentOwner>
}

/** A panel gear is bound to that exact copy, including a closed copy.
 * Event publication/connections belong here; remembered grants stay app-wide.
 * Allow once still belongs to the live host's native prompt, not settings. */
export function PanelSettings({slug,app,panel,close,owner}:{slug:string;app:CustomApp;panel:CustomPanel;close:()=>void;owner?:Document}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[view,setView]=useState<'state'|'rename'|'links'|'activity'|'events'|'delete-panel'|null>(null),[input,setInput]=useState(''),[error,setError]=useState(''),[events,setEvents]=useState<PanelEvents['events']>([])
  const a=data.apps.find(a=>a.id===app.id)??app,p=data.panels.find(p=>p.id===panel.id&&p.app===app.id)??panel,document=owner??currentOwner
  const update=async(fields:Record<string,unknown>)=>{try{await changeApps(slug,{action:'panel_update',panel:p.id,expected_rev:p.rev,...fields});setView(null);setError('')}catch(e){setError(String(e))}}
  const show=(next:typeof view)=>{setView(next);setError('');setInput(next==='rename'?p.label:next==='links'?p.linked_agents.join('\n'):'');if(next==='activity')void customAppsRequest<PanelEvents>(slug,{action:'events',panel:p.id,limit:200}).then(async page=>{let all=page.events;if(page.next_cursor!==null){const next=await customAppsRequest<PanelEvents>(slug,{action:'events',panel:p.id,after:page.next_cursor,limit:200});all=[...all,...next.events]}setEvents(all.reverse())}).catch(e=>setError(String(e)))}
  const place=(mode:CustomPanel['placement']['mode'])=>void update({placement:appPlacement(slug,p,mode,document)})
  return <SurfaceDocumentOwner owner={document}><AppDialog title={p.label+' - Panel settings'} label="Panel settings" org={slug} kind={'custom-panel-settings:'+p.id} pinnable close={close} owner={document}>
    {error&&<p role="alert">{error}</p>}
    <SetGroup title="This panel">
      <SetRow label="State" hint="Independent JSON data for this copy."><button type="button" onClick={()=>show('state')}>State…</button></SetRow>
      <SetRow label="Rename"><button type="button" onClick={()=>show('rename')}>Rename…</button></SetRow>
      <SetRow label="Linked agents"><button type="button" onClick={()=>show('links')}>Linked agents…</button></SetRow>
      <SetRow label="Activity"><button type="button" onClick={()=>show('activity')}>Activity…</button></SetRow>
      <SetRow label="Events" hint="Declared broadcasts and agent-owned connections for this copy."><button type="button" onClick={()=>show('events')}>Events…</button></SetRow>
      <SetRow label="Duplicate"><button type="button" onClick={()=>void changeApps(slug,{action:'panel_duplicate',panel:p.id,expected_rev:p.rev}).catch(e=>setError(String(e)))}>Duplicate</button></SetRow>
      <SetRow label="Placement"><button type="button" onClick={()=>place('float')}>Float</button><button type="button" onClick={()=>place('screen')}>Pin to screen</button><button type="button" onClick={()=>place('canvas')}>Pin to canvas</button></SetRow>
      <SetRow label="Delete panel" hint="Removes this copy and its saved data."><button type="button" className="danger" onClick={()=>show('delete-panel')}>Delete panel…</button></SetRow>
    </SetGroup>
  </AppDialog>
  {view==='state'&&<StateEditor slug={slug} app={a} panel={p} close={()=>setView(null)}/>}
  {view==='events'&&<AppEvents key={p.id} slug={slug} app={a} panel={p} close={()=>setView(null)}/>}
  {(view==='rename'||view==='links')&&<AppDialog title={view==='rename'?'Rename panel':'Linked agents'} close={()=>setView(null)}><label>{view==='rename'?'Label':'Agent names, one per line'}<textarea aria-label={view==='rename'?'Panel label':'Linked agent names'} value={input} onChange={e=>setInput(e.target.value)}/></label><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="primary" onClick={()=>void update(view==='rename'?{label:input}:{linked_agents:input.split(/[\n,]/).map(x=>x.trim().replace(/^@/,'')).filter(Boolean)})}>Save</button></div></AppDialog>}
  {view==='activity'&&<AppDialog title="Panel activity" close={()=>setView(null)}><ol className="custom-app-activity">{events.map(e=><li key={e.seq}><time>{new Date(e.at).toLocaleString()}</time> {e.actor}: {e.name}<pre>{JSON.stringify(e.payload,null,2)}</pre></li>)}</ol></AppDialog>}
  {view==='delete-panel'&&<AppDialog title="Delete panel" close={()=>setView(null)}><p>Delete {p.label} and its saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'panel_delete',panel:p.id,expected_rev:p.rev}).then(close).catch(e=>setError(String(e)))}>Delete panel</button></div></AppDialog>}
  </SurfaceDocumentOwner>
}
