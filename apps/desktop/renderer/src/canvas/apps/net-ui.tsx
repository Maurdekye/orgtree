import {useEffect,useState} from 'react'
import {customAppsRequest} from '../../api'
import {SetGroup,SetRow} from '../settingskit'
import type {CustomApp,PermissionHistoryEntry} from './types'

/** host[:port] with a bracketed IPv6 literal, as the engine's net.rs reads it. */
function hostPort(site:string):[string,number]|null{
  const v6=/^\[([^\]]+)\](?::(\d+))?$/.exec(site)
  if(v6)return [v6[1]!.toLowerCase(),v6[2]?Number(v6[2]):443]
  const at=site.lastIndexOf(':')
  if(at>0&&!site.slice(0,at).includes(':')&&/^\d+$/.test(site.slice(at+1)))return [site.slice(0,at).toLowerCase(),Number(site.slice(at+1))]
  return site?[site.toLowerCase(),443]:null
}
/** Whether a declared site covers a concrete site row (engine site_matches). */
export function siteCovers(declared:string,row:string){
  if(declared==='*')return true
  const want=hostPort(row),have=hostPort(declared)
  if(!want||!have||want[1]!==have[1])return false
  if(have[0].startsWith('*.')){const suffix=have[0].slice(1);return want[0].length>suffix.length&&want[0].endsWith(suffix)}
  return want[0]===have[0]
}

/** Internet access (USER 2026-10-26 m95c57abc95fb; design m232e1d1ccb57): off until
 * the user allows it; one row per declared site, Deny wins; Any site only by its
 * own Allow. Hosts answered at a prompt under a *.domain or * declaration keep
 * their own rows, which the user can change or remove. */
export function AppNetPermissions({app,save,disabled}:{app:CustomApp;save:(capability:string,permission:string,site?:string)=>Promise<void>;disabled:boolean}){
  const sites=app.sites??[],rows=app.site_permissions??{},capability=app.permissions['net.fetch']??'ask'
  const value=(site:string)=>rows[site]??(capability==='allow'&&site!=='*'?'allow':'ask')
  const answered=Object.keys(rows).filter(site=>!sites.includes(site)).sort()
  const label=(site:string)=>site==='*'?'Any site':site
  const choice=(site:string)=><select aria-label={`${label(site)} internet permission`} disabled={disabled} value={value(site)} onChange={e=>void save('net.fetch',e.target.value,site)}><option value="ask">Ask</option><option value="allow">Allow</option><option value="deny">Deny</option></select>
  return <SetGroup title="Internet access" note="Orgtree makes each request for the app over HTTPS, without your cookies or sign-ins, and never to this computer or your local network. A site you allow can receive anything the app can read, including org data and files.">
    <SetRow label="Internet access" hint={capability==='deny'?'Deny blocks every site.':capability==='allow'?'Every listed site is allowed except Any site, unless its own row says Ask or Deny.':'Each site asks first. Deny on any row wins.'}>
      <select aria-label="Internet access permission" disabled={disabled} value={capability} onChange={e=>void save('net.fetch',e.target.value)}><option value="ask">Ask</option><option value="allow">Allow listed sites</option><option value="deny">Deny</option></select>
    </SetRow>
    {!sites.length&&<p>This app declares no sites, so it cannot connect anywhere.</p>}
    {sites.map(site=><SetRow key={site} label={label(site)} hint={site==='*'?<strong>Lets the app connect to any website. Allow it only for an app you trust with everything it can read.</strong>:site.startsWith('*.')?`Any subdomain of ${site.slice(2)}`:undefined}>{choice(site)}</SetRow>)}
    {answered.map(site=><SetRow key={site} label={site} hint={sites.some(declared=>siteCovers(declared,site))?'Answered at a prompt.':'Answered at a prompt; the app no longer declares it.'}>
      {choice(site)}<button type="button" disabled={disabled} aria-label={`Remove ${site}`} onClick={()=>void save('net.fetch','default',site)}>Remove</button>
    </SetRow>)}
  </SetGroup>
}

const verbs:Record<PermissionHistoryEntry['permission'],string>={ask:'set to Ask',allow:'allowed',deny:'denied',default:'returned to default',once:'allowed once'}
/** One line per entry: what changed, how, by whom. */
export function describePermission(entry:PermissionHistoryEntry){
  const target=entry.capability==='net.fetch'?(entry.site?(entry.site==='*'?'Any site':entry.site):'Internet access'):entry.capability
  const verb=entry.via==='code'?'Allow cleared by a code change':verbs[entry.permission]??entry.permission
  return `${target}: ${verb}${entry.via==='prompt'?' at a prompt':''}`
}

/** The app-level Permission history at the bottom of App settings > Permissions:
 * every stored permission change, prompt answer and code-change reset. */
export function AppPermissionHistory({slug,app}:{slug:string;app:CustomApp}){
  const [entries,setEntries]=useState<PermissionHistoryEntry[]|null>(null),[error,setError]=useState('')
  useEffect(()=>{let active=true;setError('')
    void customAppsRequest<{entries?:PermissionHistoryEntry[]}>(slug,{action:'permission_history',app:app.id}).then(v=>{if(active)setEntries(Array.isArray(v.entries)?v.entries:[])}).catch(e=>{if(active)setError(String(e))})
    return()=>{active=false}
  },[slug,app.id,app.rev,app.permission_rev])
  return <SetGroup title="Permission history" note="Permission changes and prompt answers for this app, newest first. Orgtree keeps the latest 128.">
    {error&&<p className="dim">Permission history is unavailable: {error}</p>}
    {entries&&!entries.length&&<p>No permission changes yet.</p>}
    {!!entries?.length&&<ol className="custom-app-permission-history" aria-label="Permission history">{entries.map(entry=><li key={entry.seq}>
      <span>{describePermission(entry)}</span><small>{new Date(entry.at).toLocaleString()} · {entry.actor==='user'?'You':entry.actor}</small>
    </li>)}</ol>}
  </SetGroup>
}
