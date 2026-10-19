// Less frequent lifecycle paths, including project parents that themselves
// move during a swap. Run red and green against the same synthetic topology.
import { Proof } from '../proof.mjs'
export async function setup() {
  return {fixture:{org:{name:'Project lifecycle relations'},agents:[{name:'boss',tier:'sol',grant:300}]}}
}
export default async function(rig) {
  const p=new Proof('project-lifecycle-relations')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const hire=(name,parent,grant=0,extra={})=>rig.op({op:'hire',name,parent,tier:'sol',grant,...extra})
  const proj=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const mark=()=>rig.one('SELECT coalesce(max(id),0)::bigint AS id FROM ot.mail').id
  const mails=(since,variant)=>rig.sql(`SELECT recipient_name AS name,ev,notice FROM ot.mail WHERE org_id=${org} AND id>${since} AND ev->>'variant'='${variant}' ORDER BY id`)
  const has=(rows,name,role)=>rows.some(r=>r.name===name&&(r.ev.role??r.ev.relation)===role)
  for(const shape of ['direct','nested','root']) {
    const boss=shape==='root'?null:`chief-${shape}`
    if(boss) await hire(boss,'boss',70)
    let parent=boss
    if(shape!=='direct') {parent=`outer-${shape}`;await proj(parent,boss);await proj(`inner-${shape}`,parent);parent=`inner-${shape}`}
    const worker=`seat-${shape}`,peer=`other-${shape}`,child=`child-${shape}`
    await hire(peer,boss)
    await hire(worker,parent,25)
    let childParent=worker
    if(shape!=='direct') {childParent=`children-${shape}`;await proj(childParent,worker)}
    await hire(child,childParent,3)
    let since=mark()
    const inserted=`insert-${shape}`
    await hire(inserted,null,35,{above:worker})
    let rows=mails(since,'lifecycle.inserted')
    p.check(`${shape}: superior insertion reaches target, child's agent frontier, superior and peers`,
      has(rows,worker,'target')&&has(rows,child,'child')&&has(rows,peer,'peer')&&(!boss||has(rows,boss,'parent')),rows)
    since=mark()
    await rig.op({op:'swap',a:worker,b:child})
    rows=mails(since,'lifecycle.seat_swapped')
    p.check(`${shape}: nested seat swap keeps logical parent and both identities`,has(rows,inserted,'parent_of_a')&&has(rows,worker,'a')&&has(rows,child,'b'),rows)
    p.check(`${shape}: swap reports the contracted new superior for both agents`,rows.find(r=>r.name===worker&&r.ev.role==='a')?.ev.reports_to_after===child&&rows.find(r=>r.name===child&&r.ev.role==='b')?.ev.reports_to_after===inserted,rows)
    // Put another agent below the original worker so promotion also moves an
    // agent out of a project. The old manager must be snapshotted pre-move.
    const down=`promote-project-${shape}`,promoted=`promote-${shape}`,kept=`kept-${shape}`
    await proj(down,child)
    await hire(promoted,down,0)
    await hire(kept,down,0)
    since=mark()
    const step=await rig.tool(child,'orgtree_self_subjugate',{target:promoted})
    rows=mails(since,'lifecycle.subtree_promoted')
    p.check(`${shape}: self-subjugation through a project preserves notices to remaining reports`,step.ok&&has(rows,kept,'caller_child')&&has(rows,inserted,'new_parent'),{result:step.text,rows})
    // Actual provider compaction travels through lifecycle::record too.
    const native=`native-${shape}`
    await hire(native,parent)
    rig.scenario({agents:{[native]:{turns:[{steps:[{text:'Before native compact.'},
      {raw:{jsonrpc:'2.0',method:'thread/compacted',params:{threadId:'',turnId:''}}},{text:'After native compact.'}]}]}},default:{turns:[{steps:[{text:'OK.'}]}]}})
    since=mark();await rig.userMail(native,'NATIVE-COMPACT');await rig.waitTurns(native,1)
    rows=mails(since,'lifecycle.compacted')
    p.check(`${shape}: native compaction notifies self and real superior`,has(rows,native,'self')&&(!boss||has(rows,boss,'report')),rows)
    // Retire the subtree via dissolve, then rescind and delete the archived
    // leaf. These passive events are never delivered to a project.
    const archived=`archived-${shape}`
    await hire(archived,parent,3)
    since=mark();await rig.op({op:'dissolve',node:archived})
    rows=mails(since,'lifecycle.dissolved')
    p.check(`${shape}: dissolve reaches real superior and peer`,has(rows,peer,'peer')&&(!boss||has(rows,boss,'report')),rows)
    const clawed=`rescind-${shape}`;await hire(clawed,parent,3)
    since=mark();await rig.op({op:'rescind',node:clawed})
    rows=mails(since,'lifecycle.rescinded')
    p.check(`${shape}: rescind reaches its real superior when present`,boss?rows.some(r=>r.name===boss):rows.length===0,rows)
    since=mark();await rig.op({op:'delete',node:archived})
    rows=mails(since,'lifecycle.deleted')
    p.check(`${shape}: delete reaches real superior and peers`,has(rows,peer,'peer')&&(!boss||has(rows,boss,'report')),rows)
  }
  p.keep(rig,{agents:[],grep:/swap|subjugate|compact|error/})
  return p.summary()
}
