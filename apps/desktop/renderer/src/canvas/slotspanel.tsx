import { PinFrame } from './modalpin'
import { SlotsView } from './slotsdesk'
import { projectSlotState, slotCount, slotLeadText } from './slots'
import { ViewListIcon } from '../icons'
import type { CanvasNode, OpFn } from './shared'
import type { ToastFn, TreePayload } from '../types'

/** One canonical slots view in the standard persisted modal/pin/window host. */
export function ProjectSlotsModal({slug,nid,map,tree,op,toast,close,onJump}:{
  slug:string;nid:string;map:Map<string,CanvasNode>;tree:TreePayload;op:OpFn;toast:ToastFn;
  close:()=>void;onJump?:(id:string)=>void
}) {
  const node=map.get(nid)
  const count=node?.kind==='project'?slotCount(node):0
  const state=projectSlotState(nid,count,tree.slot_leases??[],tree.watchdogs??[])
  return <PinFrame kind="project-slots" title={`${nid} · slots`} panel="settings wide" close={close}
    restore={{agent:nid,generation:node?.generation}} dialogLabel={`${nid} · slots`}>
    <h3 data-copy-agent-name={nid}><ViewListIcon fontSize="inherit" /> {nid} <span className="dim">· slots</span></h3>
    {node&&count>0?<><div className="dim">{slotLeadText(state)}</div>
      <SlotsView node={node} state={state} map={map} onJump={onJump} op={op} toast={toast}/></>
      :<div className="hint" role="status">{node?'This project has no concurrency slots.':'This project is no longer available.'}</div>}
    <div className="row"><button type="button" className="primary" onClick={close}>Close</button></div>
  </PinFrame>
}
