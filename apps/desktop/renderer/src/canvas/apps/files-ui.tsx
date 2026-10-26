import {useEffect,useRef,useState} from 'react'
import {customAppsFiles} from '../../api'
import {SetGroup,SetRow} from '../settingskit'
import {AppDialog} from './dialog'
import type {CustomApp} from './types'
import type {FileBrowse,FileGrants,FilePrompt} from './files'

/** This picker is part of the trusted native shell. Its paths never travel
 * through the app's message port or saved JSON. */
export function AppFilePermissionPrompt({slug,prompt,owner,canSend}:{slug:string;prompt:FilePrompt;owner:Document;canSend:boolean}){
  const [page,setPage]=useState<FileBrowse|null>(null),[path,setPath]=useState(''),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const view=useRef<HTMLDivElement>(null),alive=useRef(true),serial=useRef(0)
  const choose=prompt.request.request.action==='choose'
  const browse=async(next:string,after?:string)=>{
    const at=++serial.current;setBusy(true);setError('')
    try{const result=await customAppsFiles<FileBrowse>(slug,{action:'browse',session:prompt.session,path:next,...(after?{after}:{}),limit:100});if(alive.current&&at===serial.current){setPage(p=>after&&p?.path===result.path?{...result,items:[...p.items,...result.items]}:result);setPath(result.path);setSelected('')}}
    catch(e){if(alive.current&&at===serial.current)setError(String(e))}finally{if(alive.current&&at===serial.current)setBusy(false)}
  }
  useEffect(()=>{
    alive.current=true;const before=owner.activeElement as HTMLElement|null
    const cancel=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();prompt.finish(null)}}
    owner.addEventListener('keydown',cancel,true);view.current?.querySelector<HTMLElement>('button,input')?.focus()
    const timer=window.setTimeout(()=>prompt.finish(null),120_000)
    if(choose)void browse('')
    return()=>{alive.current=false;owner.removeEventListener('keydown',cancel,true);window.clearTimeout(timer);if(before?.isConnected)before.focus()}
  },[prompt,owner])
  const request=prompt.request.request
  return <AppDialog title="Allow app to read files?" label="App file permission" owner={owner} close={()=>prompt.finish(null)} className="custom-app-permission"><div ref={view}>
    <p><strong>{prompt.request.name}</strong> · {prompt.request.label}</p>
    <p>{choose?'Choose one file this app may read.':request.action==='open'?"Allow this app to read this organization's scratch, uploads and retained artifacts?":'Allow this app to read its remembered file?'}</p>
    {request.action==='open'&&<p>Requested: <code>{String(request.root)}/{String(request.path)}</code></p>}
    <p className="dim">Read-only. Always allow remembers this scope for every copy of this app. Allow once lasts until this host closes. Revoke access in App settings → Permissions → Files.</p>
    {canSend&&<p role="note">This app also declares mail sending. File contents could be included in a message if you allow that action.</p>}
    {choose&&<div className="custom-app-file-picker">
      <form onSubmit={e=>{e.preventDefault();void browse(path)}}><label>Folder <input aria-label="File picker folder" value={path} onChange={e=>setPath(e.target.value)}/></label><button disabled={busy}>Open folder</button><button type="button" disabled={busy} onClick={()=>void browse(page?.parent??'')}>Up</button></form>
      <div role="list" aria-label="Files" className="custom-app-file-list">{page?.items.map(item=><button key={item.path} type="button" role="listitem" aria-pressed={!item.directory&&selected===item.path} disabled={busy} onClick={()=>item.directory?void browse(item.path):setSelected(item.path)}>{item.directory?'▸ ':'  '}{item.name}</button>)}</div>
      {page?.next_cursor&&<button type="button" disabled={busy} onClick={()=>void browse(page.path,page.next_cursor!)}>More files</button>}
      {page?.scan_limited&&<p>Large folder: only the first 20,000 entries were scanned. Open a narrower folder.</p>}
      <p>{selected||'Select a file to continue.'}</p>
    </div>}
    {error&&<p role="alert">{error}</p>}
    <div className="custom-app-dialog-actions"><button type="button" onClick={()=>prompt.finish(null)}>Cancel</button><span/><button type="button" onClick={()=>prompt.finish({choice:'deny'})}>Deny</button><button type="button" disabled={busy||(choose&&!selected)} onClick={()=>prompt.finish({choice:'once',...(choose?{path:selected}:{})})}>Allow once</button><button type="button" className="primary" disabled={busy||(choose&&!selected)} onClick={()=>prompt.finish({choice:'always',...(choose?{path:selected}:{})})}>Always allow</button></div>
  </div></AppDialog>
}

export function AppFilePermissions({slug,app,save,disabled,refresh}:{slug:string;app:CustomApp;save:(cap:string,value:string)=>Promise<void>;disabled:boolean;refresh:()=>Promise<void>}){
  const [data,setData]=useState<FileGrants|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const load=()=>customAppsFiles<FileGrants>(slug,{action:'permissions',app:app.id}).then(setData)
  useEffect(()=>{let active=true;void customAppsFiles<FileGrants>(slug,{action:'permissions',app:app.id}).then(v=>{if(active)setData(v)}).catch(e=>{if(active)setError(String(e))});return()=>{active=false}},[slug,app.id,app.rev,app.permission_rev])
  const revoke=async(id:string)=>{if(!data)return;setBusy(true);setError('');try{setData(await customAppsFiles<FileGrants>(slug,{action:'revoke',app:app.id,expected_rev:data.rev,expected_permission_rev:data.permission_rev,grant:id}));await refresh()}catch(e){setError(String(e));void load().catch(()=>{})}finally{setBusy(false)}}
  return <SetGroup title="Files"><SetRow label="Read files" hint="Ask requests native consent for a file or this org's files. Returning to Ask or Deny removes remembered grants and stops playback."><select aria-label="Files read permission" disabled={disabled||busy} value={app.permissions['files.read']??'ask'} onChange={e=>void save('files.read',e.target.value)}><option value="ask">Ask</option><option value="allow">Allow granted scopes</option><option value="deny">Deny</option></select></SetRow>
    {app.capabilities.includes('mail.send')&&<p>This app also declares mail sending. Granted file contents could be included in a message.</p>}
    {data?.grants.map(grant=><SetRow key={grant.id} label={grant.scope==='orgtree'?'Orgtree files':grant.name} hint={grant.path??grant.name}><button type="button" disabled={disabled||busy} onClick={()=>void revoke(grant.id)}>Revoke</button></SetRow>)}
    {data&&!data.grants.length&&<p>No remembered file access. The app asks when it needs a file.</p>}
    <SetRow label="Write files" hint="Not available in this slice. Files are read-only."/>
    {error&&<p role="alert">{error}</p>}
  </SetGroup>
}
