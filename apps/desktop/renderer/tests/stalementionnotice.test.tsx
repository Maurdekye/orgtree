import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { legacyAppBackend } from './appfeed-fixture'
import { eventFanout, startBus } from './heldevents'
import { forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import { resetSeenMentions, useMentionHighlight, hasUnseenUserMention } from '../src/canvas/agentmentions'
import { DEFAULT_NOTIFICATIONS } from '../../../../packages/contracts/notifications'
import type { TreeNode, UserMentionInfo } from '../src/types'

const response=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
const scenarios=[
  {name:'stale click',currentId:'um-8-10',currentEvent:'e8',source:'e7',expected:'e7'},
  {name:'current click',currentId:'um-7-9',currentEvent:'e7',source:'e7',expected:'e7'},
  {name:'matching identity supplies a missing source',currentId:'um-7-9',currentEvent:'e7',source:undefined,expected:'e7'},
  {name:'different identity never supplies a missing source',currentId:'um-8-10',currentEvent:'e8',source:undefined,expected:undefined},
  {name:'clicked source wins even with matching mention identity',currentId:'um-7-9',currentEvent:'e8',source:'e7',expected:'e7'},
  {name:'generation mismatch',currentId:'um-8-10',currentEvent:'e8',source:'e7',expected:undefined,generation:3},
]

for(const focusDesk of [false,true])for(const scenario of scenarios) {
  test(`${focusDesk?'taskbar desk':'banner'} mention route: ${scenario.name}`,async()=>{
    localStorage.clear();forgetModalPins();forgetModalOpenCache();resetSeenMentions()
    const oldFetch=globalThis.fetch,oldBridge=Object.getOwnPropertyDescriptor(window,'orgtreeDesktop')
    const oldPath=window.location.pathname
    const globals=globalThis as unknown as Record<string,unknown>
    const oldHistory=globals.history,oldLocation=globals.location
    globals.history=window.history;globals.location=window.location
    window.history.replaceState(null,'','/')
    const fan=eventFanout()
    const notice={id:'mention:agent:2:um-7-9',source_id:scenario.source,org:'other',kind:'mention',agent:'agent',generation:2,
      title:'agent mentioned you',body:'Old mention',...(focusDesk?{focusDesk:true,fromTaskbar:true}:{})}
    const root={id:'agent',tier:'sol',model_id:'sol',generation:scenario.generation??2,state:'live',seat:1,
      grant:0,free:0,mail_pending:0,documents:[],children:[],lineage:[],turns:[],audiences_held:[],
      user_mention:{id:scenario.currentId,event_id:scenario.currentEvent,blurb:'New mention',at:'2026-10-21T20:00:00Z'} as UserMentionInfo|null,
      scope:{tools:{},add_dirs:[],permission_mode:'default',org_visibility:'team'}}
    const seen:string[]=[]
    let highlight:ReturnType<typeof useMentionHighlight>=null
    function Probe(){highlight=useMentionHighlight('other','agent');return null}
    Object.defineProperty(window,'orgtreeDesktop',{configurable:true,value:{getPreferences:async()=>({...DEFAULT_NOTIFICATIONS}),
      notify:async()=>false,syncNotifications:async()=>{},onEvent:fan.onEvent}})
    const stopBus=startBus()
    globalThis.fetch=legacyAppBackend(async(url,init)=>{
      const path=String(url).split('?')[0]
      if(path==='/api/desktop/notifications')return response({notices:[notice],total:1,truncated:false,active:[{org:'other',id:notice.id}]})
      if(path==='/api/orgs')return response([{slug:'other',name:'Other',live:1,seats:1}])
      if(path==='/api/orgs/other')return response({slug:'other',name:'Other',roots:[root],max_top_grant:1000,default_top_grant:50,
        compact_at:0,tiers:{sol:1},audience_requests:[],credit_requests:[],cost_usd_total:0,
        audit:{live_nodes:1,top_level_holds:0,no_overdraft:true,problems:[]},epoch:1,rev:1,
        work_items_summary:{attention:0,active:0},asks:[],asks_open:0,watchdogs:[],dirs:[]})
      if(path==='/api/orgs/other/nodes/agent/mention-seen'&&init?.method==='POST'){
        const id=JSON.parse(String(init.body)).id;seen.push(id)
        // Mirror the endpoint's ID-matched deletion: a stale acknowledgement
        // cannot remove a newer marker from the returned tree snapshot.
        if(root.user_mention?.id===id)root.user_mention=null
        return response({ok:true})
      }
      if(path==='/api/providers')return response({providers:[]})
      if(/inbox|mailbox|\/mail/.test(path))return response({pending:[],delivered:[],history:[],messages:[],items:[],unread:0})
      if(/\/(work|items|asks|watchdogs|events|audiences)$/.test(path))return response([])
      return response({})
    })
    const view=await mountView(<><App/><Probe/></>,el=>el)
    try {
      await inAct(async()=>{await flush(30)})
      assert.deepEqual(seen,[],'no pre-click acknowledgement')
      await inAct(async()=>{fan.emit({type:'notification-click',data:notice});await flush(60)})
      assert.equal(window.location.pathname,'/o/other','actual App notification routing ran')
      assert.deepEqual(seen,scenario.generation?[]:['um-7-9'],'only acknowledge the clicked mention identity')
      assert.equal(highlight?.eventId,scenario.expected,'highlight the clicked event, never a newer marker')
      if(!scenario.generation)assert.equal(highlight?.mentionId,'um-7-9')
      else assert.equal(highlight===null,true,'generation guard prevents highlight')
      if(scenario.currentId==='um-8-10') {
        assert.equal(root.user_mention?.id,'um-8-10','newer marker survives the synthetic ID-matched endpoint')
        assert.equal(hasUnseenUserMention(root as unknown as TreeNode,'other'),true,'newer mention remains unseen locally')
      }
    } finally {
      stopBus();await view.unmount();globalThis.fetch=oldFetch
      if(oldBridge)Object.defineProperty(window,'orgtreeDesktop',oldBridge)
      else Object.defineProperty(window,'orgtreeDesktop',{value:undefined,configurable:true})
      forgetModalPins();forgetModalOpenCache();resetSeenMentions();window.history.replaceState(null,'',oldPath)
      globals.history=oldHistory;globals.location=oldLocation
    }
  })
}
