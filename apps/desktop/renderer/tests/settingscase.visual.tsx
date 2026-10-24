// Synthetic settings-only capture. No engine, account probing or native actions.
import {createRoot} from 'react-dom/client'
import {AccountsPanel} from '../src/canvas/accounts'
import {SettingsPanel, DefaultsPanel, NewOrg} from '../src/App'
import {NodeConfig, DraftScopeModal} from '../src/canvas/modals'
import {CurrentOrg} from '../src/popout'
import type {TreePayload} from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

const slug='synthetic-settings',noop=()=>{},tools={bash:true,edit:true,web:true,subagents:true,mcp:['*']},scope={add_dirs:[],tools,org_visibility:'full',permission_mode:'default'}
const node={id:'example-agent',title:'Example agent',tier:'sol',model_id:'sol',state:'live',kind:'agent',seat:2,grant:20,free:20,children:[],lineage:[],turns:[],audiences_held:[],scope,configured_scope:scope,generation:0,charter:'Example instructions',team_charter:'Example team instructions'}
const project={...node,id:'example-project',kind:'project',tier:null,charter:'Example project description'}
const tree={slug,name:'Synthetic settings',roots:[node,project],dirs:[],tiers:{sol:2,opus:5},max_top_grant:1000,default_top_grant:20,compact_at:0.8,default_effort:'',default_visibility:'full',default_tools:tools,credit_requests:[],audience_requests:[],audiences:[],org_inbox:{multi:false},user_inbox_count:0,cost_usd_total:0,net:{hubs:[],identity:null},auto_cheap_compact:{enabled:true,occ:0.4},cascade_hire:true,cascade_alloc:true} as unknown as TreePayload
const providers=['claude','openai','google','muse'].map((id,i)=>({id,label:['Claude Code','Codex','Antigravity','Muse Code'][i],cli:id,status:{installed:true,connected:true,version:'1.0 (synthetic)'},tiers:[{tier:id==='openai'?'sol':id==='claude'?'opus':id==='google'?'pro':'muse',provider:id,seat:2,model:'synthetic-model',letter:'S',name:'Synthetic model'}],user_enabled:true,hire_enabled:true}))
const accountRows=providers.map(p=>({id:p.id+'/primary',name:p.id+'/primary',provider:p.id,mode:'subscription',ambient:true,credential:{kind:'managed',path:'Synthetic profile'},standing:{auth:'authenticated',state:'ready',marks:{}},bound:[],identity:{},auth:'authenticated',enabled:true,label:p.label+' synthetic',signed_in:true,connected:true,usage:{limits:[]}}))
const runtime={warming_enabled:true,max_concurrent_turns:4,working_checkups_enabled:true,wait_for_mcp_tools_enabled:true,idle_docket_reminders_enabled:true,blocked_docket_reminders_enabled:true,project_listener_wake_enabled:true,credit_bubble_hire_enabled:true,credit_bubble_alloc_enabled:true,suggest_agent_feedback_enabled:true,verbose_logging:false,enter_key_behavior:'send'}
const prefs={startAtLogin:true,automaticUpdates:true,exitOnClose:false,notificationsEnabled:true,startupMode:'restore',questionTarget:'desk'}
Object.assign(window,{orgtreeDesktop:{getPreferences:async()=>prefs,setPreferences:async(p:object)=>({...prefs,...p}),onEvent:()=>noop,getProviderLoginStatus:async()=>({phase:'idle'}),getStartupKind:async()=>'boot',getUpdateCapability:async()=>({unattendedInstall:true,installDirectory:'Synthetic installation'}),getRunAsAdministrator:async()=>({enabled:false,available:true,capable:true,engine_elevated:false,helper_elevated:false}),getAppVersion:async()=>({version:'4.4.5 settings fixture',commit:'case-only'}),openLogsFolder:async()=>({ok:true}),windowIdentity:{kind:'org',org:slug},getWindowIdentity:async()=>({kind:'org',org:slug}),copyText:async()=>{throw Error('Clipboard denied in fixture')}}})
Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>'',read:async()=>[],writeText:async()=>{throw Error('Clipboard denied')},write:async()=>{throw Error('Clipboard denied')}},configurable:true})
window.WebSocket=class {close(){} addEventListener(){} removeEventListener(){}} as unknown as typeof WebSocket
window.fetch=async (input,init)=>{
 const url=new URL(String(input),'http://fixture.invalid'),p=url.pathname
 if(init?.method&&!['GET','HEAD'].includes(init.method))throw Error('Settings capture is read-only: '+p)
 const empty={entries:[],rows:[],items:[],messages:[],history:[],servers:[],details:[],templates:[],dirs:[],folders:[],charters:[],accounts:[],accounts_choices:[],counts:{},hubs:[],pending:[],delivered:[],sent:[],transfers:[],root:'Synthetic templates',busy:false,capability:{available:true}}
 let data:unknown=empty
 if(p==='/api/providers'||p.includes('/providers/'))data={providers,apikey_fallback:{},subscription_inference:{}}
 else if(p==='/api/app-settings/runtime')data=runtime
 else if(p.includes('/accounts'))data={...empty,accounts:accountRows,primary:{id:'primary',signed_in:true},keys:[],assignments:{},version:2}
 else if(p==='/api/harnesses')data={harnesses:providers.map(p=>({id:p.id,name:p.label,installed:true,selectable:true,version:'Synthetic',providers:[{id:p.id}],tags:[]}))}
 else if(p==='/api/desktop/hub')data={version:2,name:'Synthetic hub',port:0,bind:'127.0.0.1',retention_days:null,public_listener:false,status:{running:false}}
 else if(p==='/api/defaults')data={max_top_grant:1000,default_top_grant:20,compact_at:0.8,default_effort:''}
 else if(p.endsWith('/orgmd'))data={content:'# Synthetic organization',length:24}
 else if(p.endsWith('/net'))data={hubs:[],identity:null}
 else if(p.includes('openrouter'))data={...empty,keys:[],models:[],tiers:[],harness:'codex'}
 else if(p.includes('langserver'))data={...empty,models:[],harness:'codex'}
 else if(p==='/api/host')data={platform:'win32',hostname:'Synthetic host',version:'4.4.5',engine:{version:'4.4.5',commit:'fixture'},home:'Synthetic home'}
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}})
}
const root=createRoot(document.getElementById('root')!)
const map=new Map([[node.id,node],[project.id,project]])
Object.assign(window,{settingsCaseRender:(screen:string)=>{
 let content
 const props={map,tree,slug,op:async()=>{throw Error('No capture writes')},toast:noop,close:noop}
 if(screen==='app')content=<AccountsPanel toast={noop} close={noop}/>
 else if(screen==='org')content=<SettingsPanel tree={tree} toast={noop} close={noop}/>
 else if(screen==='agent'||screen==='project')content=<NodeConfig {...props as any} node={(screen==='agent'?node:project) as any} codexProvider={providers[1] as any} claudeProvider={providers[0] as any}/>
 else if(screen==='draft')content=<DraftScopeModal {...{tree,map,close:noop,draft:{tier:'sol',name:'Draft agent',parent:null},scope,accounts:accountRows,onSave:noop} as any}/>
 else if(screen==='defaults')content=<DefaultsPanel toast={noop} close={noop}/>
 else content=<NewOrg onCreate={noop}/>
 root.render(<CurrentOrg.Provider value={slug}><div className="app" key={screen}>{content}</div></CurrentOrg.Provider>)
}})
