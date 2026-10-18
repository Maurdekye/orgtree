import type { TreePayload } from '../src/types'
import { forgetAttentionMode, setOrgView } from '../src/attention/mode'
import { resetSeenMentions } from '../src/canvas/agentmentions'
import { resetConvos } from '../src/convo'

export function installMentionFixture(mode: 'canvas'|'attention', withMentions=true) {
  const globals=globalThis as unknown as Record<string, unknown>
  const saved={fetch:globals.fetch,WebSocket:globals.WebSocket,history:globals.history,CustomEvent:globals.CustomEvent,DocumentFragment:globals.DocumentFragment}
  const bridge=Object.getOwnPropertyDescriptor(window,'orgtreeDesktop')
  const slug='transcript-jump', observed:string[]=[], chats:string[]=[]
  const node=(id:string,at?:string)=>({id,state:'live',tier:'sol',generation:0,children:[],parent:null,seat:1,grant:10,free:5,
    scope:{tools:{},add_dirs:[],permission_mode:'default',org_visibility:'team'},
    ...(at&&withMentions?{user_mention:{id:'um-'+id,event_id:'e1',blurb:`Review ${id}, @user.`,at}}:{})})
  const tree={slug,name:'Transcript mentions',roots:[node('idle'),node('older','2026-10-18T15:00:00Z'),node('newest','2026-10-18T15:30:00Z')],
    epoch:1,rev:1,dirs:[],tiers:{sol:1},max_top_grant:1000,default_top_grant:50,compact_at:0,credit_requests:[],audience_requests:[],audiences:[],watchdogs:[],asks:[],asks_open:0,
    work_items_summary:{attention:0,active:0},audit:{live_nodes:3,top_level_holds:0,no_overdraft:true,problems:[]},user_inbox_count:1,urgent_unread:1,org_inbox:null,net:null} as unknown as TreePayload
  const json=(data:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}))
  class Socket {readyState=1;send(){}close(){this.readyState=3}addEventListener(){}removeEventListener(){}}
  Object.assign(globals,{WebSocket:Socket,history:window.history,CustomEvent:window.CustomEvent,DocumentFragment:window.DocumentFragment})
  globals.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),window.location.origin).pathname
    if(path==='/api/app/records')return json({detail:'synthetic legacy fixture'},501)
    if(path.endsWith('/foreground-tree'))return json({kind:'compatibility'},409)
    if(path==='/api/orgs')return json([{slug,name:tree.name,live:3,seats:3}])
    if(path==='/api/orgs/'+slug)return json(tree)
    if(path==='/api/providers')return json({providers:[]})
    if(path.endsWith('/mention-seen')){observed.push(path.split('/').at(-2)!);return json({ok:true})}
    if(path.endsWith('/chat')){
      const id=path.split('/').at(-2)!;chats.push(id)
      return json({messages:[{seq:1,role:'assistant',text:`Review ${id}, @user.`,tools:[]}],live:[],pending_mail:[],busy:false,windowed:true,has_older:false,before:null,draft_epoch:'fixture:0'})
    }
    if(path.endsWith('/detail'))return json(tree.roots.find(n=>n.id===path.split('/').at(-2)))
    if(path.endsWith('/inbox'))return json({pending:[{id:'mail-only',from:'outside',body:'A mail-only @user mention.',mailbox_attention:true,kind:'message',at:'2026-10-18T15:32:00Z'}],delivered:[],sent:[]})
    if(/\/work-items(?:-view)?$/.test(path))return json({items:[],archived:[],backlogged:[],counts:{attention:0,active:0}})
    if(path.endsWith('/documents'))return json({documents:[],total:0})
    return json({})
  }
  const identity={windowId:'mention-fixture',kind:'org',org:slug,notificationOwner:false}
  Object.defineProperty(window,'orgtreeDesktop',{configurable:true,value:{windowIdentity:identity,getWindowIdentity:async()=>identity,
    getPreferences:async()=>({quickChatPosition:'none'}),onEvent:()=>()=>{},requestOrg:async()=>({action:'focused',org:slug}),getAppVersion:async()=>'4.4.0-fixture'}})
  localStorage.clear();forgetAttentionMode();resetSeenMentions();resetConvos();setOrgView(slug,mode)
  window.history.replaceState(null,'','/o/'+slug)
  return {tree,slug,observed,chats,restore:()=>{resetConvos();resetSeenMentions();forgetAttentionMode();localStorage.clear();Object.assign(globals,saved);if(bridge)Object.defineProperty(window,'orgtreeDesktop',bridge);else delete(window as unknown as Record<string,unknown>).orgtreeDesktop;window.history.replaceState(null,'','/')}}
}
