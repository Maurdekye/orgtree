import {useEffect,useRef,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SurfaceDocumentOwner,useSurfaceDocument} from '../../popout'
import {SetRow,SettingsTabPanel,SettingsTabs,renameReady,useVisitedTabs} from '../settingskit'
import {useCopyFeedback} from '../contextmenu'
import {closeIfCentred} from '../modalpin'
import type {SettingsTab} from '../settingskit'
import {changeApps,useApps} from './store'
import {AppDialog} from './dialog'
import {AppPermissions} from './permissions'
import {AppPermissionHistory} from './net-ui'
import {AppEvents,PanelConnections,PanelFireEvent,PanelHistory} from './events'
import type {FireChoice} from './events'
import {AppExport,saveAppJson} from './portable'
import type {CustomApp,CustomPanel} from './types'

/** Panel settings' State tab (user 2026-10-26: "and make state its own tab"): the
 * panel's own JSON data, edited in place. Save is revision-checked and reports a
 * conflict if another edit arrived; Reload reads the saved data again. Import is a
 * button like the other five (user 2026-10-27 m531629c33a06 "why is the import
 * button styled differently"): it opens a hidden file picker, which is cleared
 * after each choice so the same file can be imported again. */
export function PanelState({slug,panel,app}:{slug:string;panel:CustomPanel;app:CustomApp}){
  const owner=useSurfaceDocument(),picker=useRef<HTMLInputElement>(null),[text,setText]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(true),[rev,setRev]=useState(panel.rev)
  const load=async(alive=()=>true)=>{setBusy(true);setError('');setStatus('');try{const p=await customAppsRequest<CustomPanel>(slug,{action:'panel_get',panel:panel.id});if(alive()){setText(JSON.stringify(p.state??{},null,2));setRev(p.rev)}}catch(e){if(alive())setError(String(e))}finally{if(alive())setBusy(false)}}
  useEffect(()=>{let alive=true;void load(()=>alive);return()=>{alive=false}},[slug,panel.id])
  const value=()=>{if(new TextEncoder().encode(text).length>2*1024*1024)throw Error('State exceeds 2 MiB.');const v:unknown=JSON.parse(text);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('State must be a JSON object.');return v}
  const save=async()=>{try{setBusy(true);setStatus('');const p=await changeApps<CustomPanel>(slug,{action:'state_set',panel:panel.id,expected_rev:rev,state:value()});setRev(p.rev);setError('');setStatus('Saved.')}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <div className="set-group custom-app-state">
    <p className="dim">Each panel keeps its own JSON data. Save reports a conflict if another edit arrived; Reload reads the saved data again.</p>
    <textarea aria-label="Panel JSON state" spellCheck={false} value={text} disabled={busy} onChange={e=>{setText(e.target.value);setStatus('')}}/>
    {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
    <div className="custom-app-dialog-actions"><button type="button" onClick={()=>picker.current?.click()}>Import</button><input ref={picker} type="file" accept="application/json,.json" hidden onChange={async e=>{const input=e.currentTarget;try{const f=input.files?.[0];if(!f)return;if(f.size>2*1024*1024)throw Error('State exceeds 2 MiB.');const text=await f.text();JSON.parse(text);setText(text);setError('')}catch(error){setError(String(error))}finally{input.value=''}}}/>
      <button type="button" onClick={()=>{try{saveAppJson(owner,panel.label+'.json',value())}catch(e){setError(String(e))}}}>Export</button>
      <button type="button" onClick={async()=>{try{await owner.defaultView?.navigator.clipboard.writeText(JSON.stringify(value(),null,2))}catch(e){setError(String(e))}}}>Copy</button>
      <button type="button" onClick={async()=>{try{const a=await customAppsRequest<CustomApp>(slug,{action:'app_get',app:app.id});setText(JSON.stringify(a.definition?.initial_state??{},null,2))}catch(e){setError(String(e))}}}>Reset</button>
      <span/><button type="button" disabled={busy} onClick={()=>void load()}>Reload</button><button type="button" className="primary" disabled={busy} onClick={()=>void save()}>Save</button></div>
  </div>
}

type AppTab='general'|'events'|'permissions'|'history'
const APP_TABS:SettingsTab<AppTab>[]=[{id:'general',label:'General'},{id:'events',label:'Events'},{id:'permissions',label:'Permissions'},{id:'history',label:'Permission history'}]
// Each section of a panel has its own tab, History last (user 2026-10-26: "put
// connections and fire event on their own tabs"; "make history the last tab";
// "and make state its own tab").
type PanelTab='general'|'state'|'connections'|'fire'|'history'
const PANEL_TABS:SettingsTab<PanelTab>[]=[{id:'general',label:'General'},{id:'state',label:'State'},{id:'connections',label:'Connections'},{id:'fire',label:'Fire event'},{id:'history',label:'History'}]

/** App-wide settings never choose a saved panel or start its HTML. Permissions has
 * its own tab (user 2026-10-26: "for now, make permissions a second tab in app
 * settings"), as does Permission history, last (2026-10-27 m838e66af753b "put tgat
 * on i6s own tab"); Events, after General, lists the declared events (2026-10-27
 * me1e204ce94e4). The description heads the window above the tabs, and General
 * has no section header or creator row (user 2026-10-26: "put the description
 * above the tabs and remove the app header"; "remove created-by"). The delete
 * confirmation fits its content. */
export function AppSettings({slug,app,close,owner,confirmDelete=false}:{slug:string;app:CustomApp;close:()=>void;owner?:Document;confirmDelete?:boolean}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[tab,setTab,visited]=useVisitedTabs<AppTab>('general'),[view,setView]=useState<'delete-app'|null>(confirmDelete?'delete-app':null),[error,setError]=useState('')
  const a=data.apps.find(a=>a.id===app.id)??app,document=owner??currentOwner,idBase='custom-app-settings-'+app.id
  const cancelDelete=()=>confirmDelete?close():setView(null)
  return <SurfaceDocumentOwner owner={document}><AppDialog title={a.name+' - App settings'} label="App settings" org={slug} kind={'custom-app-settings:'+app.id} pinnable close={close} owner={document}>
    {a.description?.trim()&&<p className="dim">{a.description}</p>}
    {error&&<p role="alert">{error}</p>}
    <SettingsTabs tabs={APP_TABS} tab={tab} setTab={setTab} idBase={idBase} label="App settings sections"/>
    <SettingsTabPanel id="general" idBase={idBase} active={tab==='general'}>
      <div className="set-group"><AppExport slug={slug} app={a} owner={document}/>
        <SetRow label="Delete app" hint="Removes the definition and every saved panel."><button type="button" className="danger" onClick={()=>setView('delete-app')}>Delete app…</button></SetRow>
      </div>
    </SettingsTabPanel>
    <SettingsTabPanel id="events" idBase={idBase} active={tab==='events'}>{visited('events')&&<AppEvents app={a}/>}</SettingsTabPanel>
    <SettingsTabPanel id="permissions" idBase={idBase} active={tab==='permissions'}>{visited('permissions')&&<AppPermissions slug={slug} app={a} close={close} embedded/>}</SettingsTabPanel>
    <SettingsTabPanel id="history" idBase={idBase} active={tab==='history'} className="app-settings-panel custom-app-log-tab">{visited('history')&&<AppPermissionHistory key={a.id} slug={slug} app={a}/>}</SettingsTabPanel>
  </AppDialog>
  {view==='delete-app'&&<AppDialog title="Delete app" className="custom-app-confirm" close={cancelDelete}><p>Delete {a.name}, all its panels and their saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={cancelDelete}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'app_delete',app:a.id,expected_rev:a.rev,delete_panels:true}).then(close).catch(e=>setError(String(e)))}>Delete app and panels</button></div></AppDialog>}
  </SurfaceDocumentOwner>
}

/** A panel gear is bound to that exact panel, including a closed one. Its Name
 * row is the Agent settings rename (user 2026-10-26: "make rename work the same
 * way renaming agents does"): an inline field above the tabs whose Rename button
 * is always shown and enabled once the trimmed text is a different, non-empty
 * name (renameReady), and applies at once, with no Enter submit; the engine
 * validates, a refusal toasts its error, and a rename toasts and closes the
 * window. General holds the panel's own actions under no section header (user
 * 2026-10-26: remove the "This panel" title); State, Connections, Fire event and
 * History (last) each have a tab; History follows the live change feed, a fire
 * included, and a Connections row's event opens Fire event with that event chosen
 * (user 2026-10-27 m930f15583b2c). Placement lives on the window itself and in
 * orgtree_apps, not here;
 * remembered grants stay app-wide, and Allow once still belongs to the live
 * host's native prompt. The delete confirmation fits its content. */
export function PanelSettings({slug,app,panel,close,owner,confirmDelete=false}:{slug:string;app:CustomApp;panel:CustomPanel;close:()=>void;owner?:Document;confirmDelete?:boolean}){
  const currentOwner=useSurfaceDocument(),data=useApps(slug),[tab,setTab,visited]=useVisitedTabs<PanelTab>('general'),[view,setView]=useState<'delete-panel'|null>(confirmDelete?'delete-panel':null),[nameEdit,setNameEdit]=useState<string>(),[error,setError]=useState('')
  const [fireChoice,setFireChoice]=useState<FireChoice|null>(null),fireEvent=(name:string)=>{setFireChoice(c=>({name,seq:(c?.seq??0)+1}));setTab('fire')}
  const a=data.apps.find(a=>a.id===app.id)??app,p=data.panels.find(p=>p.id===panel.id&&p.app===app.id)??panel,document=owner??currentOwner,idBase='custom-panel-settings-'+p.id,name=nameEdit??p.label
  // The app's toast, which ObjectMenuBoundary provides at the window root, as Agent settings receives it.
  const toast=useCopyFeedback()
  const rename=async()=>{const from=p.label;try{const r=await changeApps<CustomPanel>(slug,{action:'panel_update',panel:p.id,expected_rev:p.rev,label:name.trim()});toast?.([`renamed ${from} → ${r.label}`]);close()}catch(e){if(toast)toast([`error: ${e instanceof Error?e.message:String(e)}`]);else setError(String(e))}}
  const show=(next:typeof view)=>{setView(next);setError('')}
  const cancelDelete=()=>confirmDelete?close():setView(null)
  return <SurfaceDocumentOwner owner={document}><AppDialog title={p.label+' - Panel settings'} label="Panel settings" org={slug} kind={'custom-panel-settings:'+p.id} pinnable close={close} owner={document}>
    {error&&<p role="alert">{error}</p>}
    <SetRow label="Name"><span className="agent-identity-row"><input type="text" aria-label="Panel name" placeholder="Panel name" value={name} onChange={e=>setNameEdit(e.target.value)}/>
      <button type="button" disabled={!renameReady(name,p.label)} onClick={()=>void rename()}>Rename</button></span></SetRow>
    <SettingsTabs tabs={PANEL_TABS} tab={tab} setTab={setTab} idBase={idBase} label="Panel settings sections"/>
    <SettingsTabPanel id="general" idBase={idBase} active={tab==='general'}>
      <div className="set-group">
        <SetRow label="Duplicate"><button type="button" onClick={()=>void changeApps(slug,{action:'panel_duplicate',panel:p.id,expected_rev:p.rev}).catch(e=>setError(String(e)))}>Duplicate</button></SetRow>
        <SetRow label="Delete panel" hint="Removes this panel and its saved data."><button type="button" className="danger" onClick={()=>show('delete-panel')}>Delete panel…</button></SetRow>
      </div>
    </SettingsTabPanel>
    <SettingsTabPanel id="state" idBase={idBase} active={tab==='state'} className="app-settings-panel custom-app-state-tab">{visited('state')&&<PanelState key={p.id} slug={slug} app={a} panel={p}/>}</SettingsTabPanel>
    <SettingsTabPanel id="connections" idBase={idBase} active={tab==='connections'}>{visited('connections')&&<PanelConnections key={p.id} slug={slug} app={a} panel={p} fireEvent={fireEvent} leave={()=>closeIfCentred('custom-panel-settings:'+p.id,close,slug)}/>}</SettingsTabPanel>
    <SettingsTabPanel id="fire" idBase={idBase} active={tab==='fire'} className="app-settings-panel custom-app-log-tab">{visited('fire')&&<PanelFireEvent key={p.id} slug={slug} app={a} panel={p} choice={fireChoice}/>}</SettingsTabPanel>
    <SettingsTabPanel id="history" idBase={idBase} active={tab==='history'} className="app-settings-panel custom-app-log-tab">{visited('history')&&<PanelHistory key={p.id} slug={slug} panel={p}/>}</SettingsTabPanel>
  </AppDialog>
  {view==='delete-panel'&&<AppDialog title="Delete panel" className="custom-app-confirm" close={cancelDelete}><p>Delete {p.label} and its saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={cancelDelete}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'panel_delete',panel:p.id,expected_rev:p.rev}).then(close).catch(e=>setError(String(e)))}>Delete panel</button></div></AppDialog>}
  </SurfaceDocumentOwner>
}
