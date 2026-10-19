import { Proof } from '../proof.mjs'
export async function setup(){return {fixture:{org:{name:'Project credit relations'},agents:[{name:'boss',tier:'sol',grant:1000}]}}}
export default async function(rig) {
  const p=new Proof('project-credit-relations')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const id=n=>rig.agentRow(n).id
  const project=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const hire=(name,parent,grant=0,tier='sol')=>rig.op({op:'hire',name,...(parent?{parent}:{}),grant,tier})
  const op=body=>rig.op(body).then(value=>({ok:true,value}),e=>({ok:false,error:String(e.body?.detail??e.message)}))
  const settings=s=>rig.api('POST',`/api/orgs/${rig.org}/settings`,s)
  const grant=n=>rig.one(`SELECT grant_credits::float8 AS g FROM ot.agents WHERE id=${id(n)}`).g
  const ledger=()=>rig.sql(`SELECT a.name,a.grant_credits::float8 AS grant,(a.grant_credits-coalesce((SELECT sum(c.seat+c.grant_credits) FROM ot.agents c WHERE c.id IN(SELECT ot.reports_of(a.org_id,a.id)) AND c.state='live'),0))::float8 AS free FROM ot.agents a WHERE a.kind='agent' AND a.state='live'`)
  for(const shape of ['direct','one','nested']) {
    const payer=`payer-${shape}`;await hire(payer,'boss',50)
    let parent=payer
    if(shape!=='direct'){await project(`outer-${shape}`,parent);parent=`outer-${shape}`}
    if(shape==='nested'){await project(`inner-${shape}`,parent);parent=`inner-${shape}`}
    const child=`claw-${shape}`;await hire(child,parent,6)
    const before=grant(payer),stake=rig.agentRow(child).seat+grant(child)
    await rig.op({op:'rescind',node:child})
    p.check(`${shape}: rescind removes the freed stake from the real payer`,Math.abs(grant(payer)-(before-stake))<1e-6,{before,after:grant(payer),stake})
    await hire(`ask-${shape}`,parent,1)
    await rig.api('POST',`/api/orgs/${rig.org}/audiences`,{action:'grant',node:`ask-${shape}`,target:'user'})
    await settings({cascade_alloc:false})
    const asked=await rig.tool(`ask-${shape}`,'orgtree_request_credits',{new_limit:3,reason:'Synthetic payer headroom'})
    p.check(`${shape}: credit request sees free credits of the nearest agent payer`,asked.ok,asked.text)
    if(asked.ok) await rig.tool(`ask-${shape}`,'orgtree_withdraw_ask',{})
    await settings({cascade_alloc:true})
    // Different wrappers, one payer: the seat cost swap is budget-neutral.
    await project(`peer-wrapper-${shape}`,payer)
    await hire(`swap-a-${shape}`,parent,1,'sol')
    await hire(`swap-b-${shape}`,`peer-wrapper-${shape}`,1,'astra')
    const pre=ledger().find(r=>r.name===payer)
    const sw=await op({op:'swap',a:`swap-a-${shape}`,b:`swap-b-${shape}`})
    const post=ledger().find(r=>r.name===payer)
    p.check(`${shape}: cross-tier swap across project wrappers uses the common real payer`,sw.ok&&pre.free===post.free,{sw,pre,post})
  }
  for(const shape of ['direct','one','nested']) {
    let parent
    if(shape!=='direct'){await project(`cap-root-${shape}`);parent=`cap-root-${shape}`}
    if(shape==='nested'){await project('cap-inner',parent);parent='cap-inner'}
    const name=`top-${shape}`;await settings({max_top_grant:50});await hire(name,parent,20)
    const ra=await op({op:'reallocate',node:name,delta:31})
    p.check(`${shape}: top-level reallocation cap applies through wrappers atomically`,!ra.ok&&grant(name)===20,{ra,grant:grant(name)})
    if(ra.ok) await rig.op({op:'reallocate',node:name,delta:20-grant(name)})
    await rig.op({op:'retire',node:name})
    const rh=await op({op:'rehire',node:name,grant:60})
    p.check(`${shape}: top-level rehire cap applies through wrappers atomically`,!rh.ok&&rig.agentRow(name).state==='archived',{rh,state:rig.agentRow(name).state})
    if(rh.ok) await rig.op({op:'retire',node:name})
    await rig.op({op:'rehire',node:name,grant:20})
    const asked=await rig.tool(name,'orgtree_request_credits',{new_limit:60,reason:'Synthetic cap preview'})
    const card=rig.one(`SELECT uid FROM ot.asks WHERE agent_id=${id(name)} AND status='open'`)
    const preview=card?await rig.api('POST',`/api/orgs/${rig.org}/credit-requests`,{id:card.uid,action:'approve',granted:60,dry:true}):null
    p.check(`${shape}: top-level credit preview rejects an over-cap approval`,asked.ok&&preview?.ok===false,{asked:asked.text,preview})
    if(card) await rig.tool(name,'orgtree_withdraw_ask',{})
    const warning=await settings({max_top_grant:15})
    p.check(`${shape}: cap warnings name the real top-level agent`,JSON.stringify(warning.warnings??[]).includes(name),warning.warnings)
    const zero=await rig.tool(name,'orgtree_request_credits',{new_limit:21,reason:'Synthetic zero headroom'})
    p.check(`${shape}: exhausted top cap refuses credit request`,!zero.ok&&zero.text.includes('ZERO'),zero.text)
  }
  await settings({max_top_grant:1000})
  const all=ledger()
  p.check('all live agent balances remain solvent',all.every(r=>r.free>=-1e-6),all)
  p.keep(rig,{agents:['payer-nested','top-nested'],grep:/credit|reallocate|swap|rescind/})
  return p.summary()
}
