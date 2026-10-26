import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SurfaceDocumentOwner,useSurfaceDocument} from '../../popout'
import {SetRow,SettingsTabPanel,SettingsTabs,useVisitedTabs} from '../settingskit'
import type {SettingsTab} from '../settingskit'
import {changeApps,useApps} from './store'
import {AppDialog} from './dialog'
import {AppPermissions} from './permissions'
import {PanelConnections,PanelFireEvent,PanelHistory} from './events'
import {AppExport,saveAppJson} from './portable'
import type {CustomApp,CustomPanel} from './types'

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

const APP_TABS:SettingsTab<'general'|'permissions'>[]=[{id:'general',label:'General'},{id:'permissions',label:'Permissions'}]
// Each section of a copy has its own tab, History last (user 2026-10-26: "put
// connections and fire event on their own tabs"; "make history the last tab").
type PanelTab='general'|'connections'|'fire'|'history'
const PANEL_TABS:SettingsTab<PanelTab>[]=[{id:'general',label:'General'},{id:'connections',label:'Connections'},{id:'fire',label:'Fire event'},{id:'history',label:'History'}]

/** App-wide settings never choose a saved copy or start its HTML. Permissions is
 * their second tab (user 2026-10-26: "for now, make permissions a second tab in
 * app settings"). The description heads the window above the tabs, and General
 * has no section header or creator row (user 2026-10-26: "put the description
 * above the tabs and remove the app header"; "remove created-by"). The delete
 * confirmation fits its content. */
export function AppSettings({slug,app,close,owner}:{slug:string;app:CustomApp;close:()=>void;owner?:Document}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[tab,setTab,visited]=useVisitedTabs<'general'|'permissions'>('general'),[view,setView]=useState<'delete-app'|null>(null),[error,setError]=useState('')
  const a=data.apps.find(a=>a.id===app.id)??app,document=owner??currentOwner,idBase='custom-app-settings-'+app.id
  return <SurfaceDocumentOwner owner={document}><AppDialog title={a.name+' - App settings'} label="App settings" org={slug} kind={'custom-app-settings:'+app.id} pinnable close={close} owner={document}>
    {a.description?.trim()&&<p className="dim">{a.description}</p>}
    {error&&<p role="alert">{error}</p>}
    <SettingsTabs tabs={APP_TABS} tab={tab} setTab={setTab} idBase={idBase} label="App settings sections"/>
    <SettingsTabPanel id="general" idBase={idBase} active={tab==='general'}>
      <div className="set-group"><AppExport slug={slug} app={a} owner={document}/>
        <SetRow label="Delete app" hint="Removes the definition and every saved panel."><button type="button" className="danger" onClick={()=>setView('delete-app')}>Delete app…</button></SetRow>
      </div>
    </SettingsTabPanel>
    <SettingsTabPanel id="permissions" idBase={idBase} active={tab==='permissions'}>{visited('permissions')&&<AppPermissions slug={slug} app={a} close={close} embedded/>}</SettingsTabPanel>
  </AppDialog>
  {view==='delete-app'&&<AppDialog title="Delete app" className="custom-app-confirm" close={()=>setView(null)}><p>Delete {a.name}, all its panels and their saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'app_delete',app:a.id,expected_rev:a.rev,delete_panels:true}).then(close).catch(e=>setError(String(e)))}>Delete app and panels</button></div></AppDialog>}
  </SurfaceDocumentOwner>
}

/** A panel gear is bound to that exact copy, including a closed copy. General
 * holds the copy's own actions under no section header (user 2026-10-26: remove
 * the "This panel" title); Connections, Fire event and History (last) each have
 * a tab, and a fire remounts History so it reloads the log. Placement lives on
 * the window itself and in orgtree_apps, not here; remembered grants stay
 * app-wide, and Allow once still belongs to the live host's native prompt. The
 * delete confirmation fits its content (user 2026-10-26). */
export function PanelSettings({slug,app,panel,close,owner}:{slug:string;app:CustomApp;panel:CustomPanel;close:()=>void;owner?:Document}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[tab,setTab,visited]=useVisitedTabs<PanelTab>('general'),[view,setView]=useState<'state'|'rename'|'delete-panel'|null>(null),[input,setInput]=useState(''),[error,setError]=useState(''),[fired,setFired]=useState(0)
  const a=data.apps.find(a=>a.id===app.id)??app,p=data.panels.find(p=>p.id===panel.id&&p.app===app.id)??panel,document=owner??currentOwner,idBase='custom-panel-settings-'+p.id
  const update=async(fields:Record<string,unknown>)=>{try{await changeApps(slug,{action:'panel_update',panel:p.id,expected_rev:p.rev,...fields});setView(null);setError('')}catch(e){setError(String(e))}}
  const show=(next:typeof view)=>{setView(next);setError('');setInput(next==='rename'?p.label:'')}
  return <SurfaceDocumentOwner owner={document}><AppDialog title={p.label+' - Panel settings'} label="Panel settings" org={slug} kind={'custom-panel-settings:'+p.id} pinnable close={close} owner={document}>
    {error&&<p role="alert">{error}</p>}
    <SettingsTabs tabs={PANEL_TABS} tab={tab} setTab={setTab} idBase={idBase} label="Panel settings sections"/>
    <SettingsTabPanel id="general" idBase={idBase} active={tab==='general'}>
      <div className="set-group">
        <SetRow label="State" hint="Independent JSON data for this copy."><button type="button" onClick={()=>show('state')}>State…</button></SetRow>
        <SetRow label="Rename"><button type="button" onClick={()=>show('rename')}>Rename…</button></SetRow>
        <SetRow label="Duplicate"><button type="button" onClick={()=>void changeApps(slug,{action:'panel_duplicate',panel:p.id,expected_rev:p.rev}).catch(e=>setError(String(e)))}>Duplicate</button></SetRow>
        <SetRow label="Delete panel" hint="Removes this copy and its saved data."><button type="button" className="danger" onClick={()=>show('delete-panel')}>Delete panel…</button></SetRow>
      </div>
    </SettingsTabPanel>
    <SettingsTabPanel id="connections" idBase={idBase} active={tab==='connections'}>{visited('connections')&&<PanelConnections key={p.id} slug={slug} app={a} panel={p}/>}</SettingsTabPanel>
    <SettingsTabPanel id="fire" idBase={idBase} active={tab==='fire'}>{visited('fire')&&<PanelFireEvent key={p.id} slug={slug} app={a} panel={p} fired={()=>setFired(n=>n+1)}/>}</SettingsTabPanel>
    <SettingsTabPanel id="history" idBase={idBase} active={tab==='history'}>{visited('history')&&<PanelHistory key={p.id+'/'+fired} slug={slug} panel={p}/>}</SettingsTabPanel>
  </AppDialog>
  {view==='state'&&<StateEditor slug={slug} app={a} panel={p} close={()=>setView(null)}/>}
  {view==='rename'&&<AppDialog title="Rename panel" close={()=>setView(null)}><label>Label<textarea aria-label="Panel label" value={input} onChange={e=>setInput(e.target.value)}/></label><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="primary" onClick={()=>void update({label:input})}>Save</button></div></AppDialog>}
  {view==='delete-panel'&&<AppDialog title="Delete panel" className="custom-app-confirm" close={()=>setView(null)}><p>Delete {p.label} and its saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setView(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'panel_delete',panel:p.id,expected_rev:p.rev}).then(close).catch(e=>setError(String(e)))}>Delete panel</button></div></AppDialog>}
  </SurfaceDocumentOwner>
}
