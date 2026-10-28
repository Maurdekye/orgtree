import {customAppsRequest} from '../../api'
import {fmtFull,fmtShort} from '../../timefmt'
import {SetGroup,SetRow} from '../settingskit'
import {LOG_PAGE,LogList} from './loglist'
import type {LogCursor} from './loglist'
import {useApps} from './store'
import type {CustomApp,PermissionHistoryEntry,PermissionHistoryPage} from './types'

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

const who=(actor:string)=>actor==='user'?'You':actor
const choices:Record<PermissionHistoryEntry['permission'],string>={ask:'Ask',allow:'Allow',deny:'Deny',default:'Default',once:'Allow once'}
const ways:Record<PermissionHistoryEntry['via'],string>={change:'Changed in Permissions',prompt:'Answered at a prompt',code:'Reset by a code change'}
/** A Permission history row on one line: when, what changed and how, and who. */
function permissionSummary(entry:PermissionHistoryEntry){
  return <><time dateTime={entry.at}>{fmtShort(entry.at)}</time>{' '}<span>{describePermission(entry)}</span>{' '}<span className="dim">{who(entry.actor)}</span></>
}

/** App settings' Permission history tab, the last one (user 2026-10-27 m838e66af753b:
 * "ssme for permission history, and put tgat on i6s own tab"): every stored
 * permission change, prompt answer and code-change reset, as the same live list as
 * a panel's History. It follows Apps changes; a panel's own fires change nothing here.
 * It opens on the list, with no intro line (user 2026-10-28 m420ce21a63f4: "and this
 * one"); an empty history keeps its one line. */
export function AppPermissionHistory({slug,app}:{slug:string;app:CustomApp}){
  const panels=useApps(slug).panels
  const read=(cursor:LogCursor)=>customAppsRequest<PermissionHistoryPage>(slug,{action:'permission_history',app:app.id,limit:LOG_PAGE,...cursor}).then(page=>({items:page.entries??[],next_cursor:page.next_cursor??null}))
  // An expanded row: the exact time, who, and what was set where.
  const details=(entry:PermissionHistoryEntry)=>{const panel=entry.panel&&(panels.find(p=>p.id===entry.panel)?.label??entry.panel)
    return <dl>
      <dt>Time</dt><dd>{fmtFull(entry.at)}</dd><dt>By</dt><dd>{who(entry.actor)}</dd><dt>Capability</dt><dd>{entry.capability}</dd>
      {entry.site&&<><dt>Site</dt><dd>{entry.site==='*'?'Any site':entry.site}</dd></>}
      <dt>Permission</dt><dd>{choices[entry.permission]??entry.permission}</dd><dt>How</dt><dd>{ways[entry.via]??entry.via}</dd>
      {panel&&<><dt>Panel</dt><dd>{panel}</dd></>}
    </dl>}
  return <div className="set-group custom-app-log-group">
    <LogList slug={slug} label="Permission history" read={read} follows={change=>!change.panel&&!change.listeners} summary={permissionSummary} details={details} empty="No permission changes yet."/>
  </div>
}
