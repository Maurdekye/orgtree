import { AttentionQueue } from '../src/attention/AttentionQueue'
import type { AttentionNotificationFocus } from '../src/attention/AttentionQueue'
import type { AskInfo, MailEntry, TreePayload } from '../src/types'
import { compatibilityWorkFixture } from './workcompat.fixture'

export const org = 'attention-deselect'
export const mention: MailEntry = { id:'mention-mail', from:'writer', kind:'message',
  at:'2026-10-19T18:42:00Z', body:'Please review this result, @user.', mailbox_attention:true }
export const urgent: MailEntry = { ...mention, id:'urgent-mail', at:'2026-10-19T18:42:01Z', body:'Please review the urgent result.',
  mailbox_attention:false, urgent:true, urgent_reason:'Review needed' }
export const remaining: MailEntry = { ...urgent, id:'remaining', at:'2026-10-19T18:40:00Z', body:'Another unread request.' }
export const question: AskInfo = { id:'question', node:'writer', kind:'question', status:'open',
  at:'2026-10-19T18:43:00Z', question:'Which result should we use?', options:[{label:'First'}] }
export const tree = (withQuestion = false) => ({ slug:org, name:org, roots:[{
  id:'writer', tier:'sol', state:'live', generation:0, seat:2, grant:2, free:0, children:[],
  user_mention:{id:'mention-marker',event_id:'e1',at:mention.at,blurb:mention.body},
}], asks:withQuestion?[question]:[], asks_open:withQuestion?1:0,
  work_items_summary:{attention:0,active:0}, max_top_grant:1000,
} as unknown as TreePayload)

export function installAttentionServer(target: MailEntry = mention) {
  const state = { pending:[target,remaining], delivered:[] as MailEntry[], reads:[] as string[] }
  globalThis.fetch = compatibilityWorkFixture(async (url,init) => {
    const path = new URL(String(url),'http://localhost').pathname
    let body: unknown = {ok:true}
    if(path.endsWith('/inbox/read')) {
      const ids = JSON.parse(String(init?.body)).ids as string[]
      state.reads.push(...ids)
      state.delivered.push(...state.pending.filter(m=>ids.includes(m.id)))
      state.pending = state.pending.filter(m=>!ids.includes(m.id))
    } else if(path.endsWith('/inbox')) body = {pending:state.pending,delivered:state.delivered,sent:[]}
    else if(/\/work-items(?:-view)?$/.test(path)) body = {items:[],archived:[],backlogged:[],counts:{attention:0,active:0,archived:0,backlogged:0}}
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})
  })
  return state
}

export function AttentionDeselectFixture({withQuestion=false,onNotificationFocus}: {
  withQuestion?:boolean;onNotificationFocus?:(focus:AttentionNotificationFocus|null)=>void
}) {
  return <AttentionQueue slug={org} tree={tree(withQuestion)} toast={()=>{}}
    treeStatus={{loading:false,failed:false,stale:false,unavailable:false,error:null,at:Date.now()}}
    onNotificationFocus={onNotificationFocus}/>
}
