import type { WorkItem } from '../src/types'

export type ReaderContentNode = { id: string; members?: string[] }

/** Memory/send tests need real nonempty scoped readers before picking their
 * optional tabs. Model availability and the lists from the same small dataset;
 * projects own presentations and list tickets owned by their agent members. */
export function withReaderContent(fallback: typeof fetch, nodes: ReaderContentNode[]): typeof fetch {
  const at='2026-10-22T10:00:00Z'
  const work=nodes.map(node=>({slug:node.id+'-ticket',title:node.id+' ticket',objective:'Reader fixture',
    rev:1,kind:'code',status:'in_progress',archived:false,owner:{node:node.members?.[0]??node.id,generation:1},
    owner_current:true,owner_state:'live',participants:[],questions:[],done_so_far:[],working_on_next:[],dependencies:[],
    evidence:[],history:[],dismissals:[],acceptance:[],attention_sources:[],effective_attention:false,manual_attention:null,
    at,updated_at:at,docket_at:at} as WorkItem))
  const docs=nodes.map(node=>({id:node.id+'-document',node:node.id,title:node.id+' document',at,viewed_at:at,
    format:'markdown',node_state:'live',evicted:false}))
  const scopedWork=(id:string)=>{const node=nodes.find(node=>node.id===id);return node?work.filter(row=>[node.id,...(node.members??[])].includes(row.owner!.node)):[]}
  const json=(value:unknown)=>Promise.resolve(new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}}))
  return ((input,init)=>{
    if(init?.method && init.method!=='GET')return fallback(input,init)
    const url=new URL(String(input),'http://fixture'),q=url.searchParams
    const availability=/\/nodes\/([^/]+)\/reader-availability$/.exec(url.pathname)
    if(availability){const id=decodeURIComponent(availability[1]),hasWork=scopedWork(id).length>0,hasDocs=docs.some(row=>row.node===id)
      return json({work:{own:hasWork,team:hasWork},presented:{own:hasDocs,team:hasDocs}})}
    if(url.pathname.endsWith('/work-items-page')){
      const group=q.get('group')??'items',all=group==='items'?scopedWork(q.get('agent')??q.get('team')??''):[]
      const offset=Number(q.get('offset')??0),rows=all.slice(offset,offset+100)
      return json({format:'orgtree.work-page/v1',group,rows,opening_rows:all.filter(row=>row.slug===q.get('opening_last')),
        total:all.length,totals:{items:all.length,archived:0,backlogged:0},matched:{items:all.length,archived:0,backlogged:0},
        counts:{active:all.length,attention:0,archived:0,backlogged:0},assigned_count:all.length,next_offset:null,revision:'reader-content-v1',at})
    }
    const ticket=/\/work-items\/([^/]+)$/.exec(url.pathname)
    if(ticket){const item=work.find(row=>row.slug===decodeURIComponent(ticket[1]));if(item)return json({item})}
    if(url.pathname.endsWith('/documents')){
      const all=docs.filter(row=>!q.get('node')||row.node===q.get('node')),offset=Number(q.get('offset')??0),limit=Number(q.get('limit')??40)
      return json({documents:all.slice(offset,offset+limit),total:all.length,offset,next_offset:null})
    }
    const document=/\/documents\/([^/]+)$/.exec(url.pathname)
    if(document){const row=docs.find(row=>row.id===decodeURIComponent(document[1]));if(row)return json({...row,body:'Reader fixture document'})}
    return fallback(input,init)
  })as typeof fetch
}
