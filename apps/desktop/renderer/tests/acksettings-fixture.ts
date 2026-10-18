import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
export function ackProject(scope: Record<string,unknown> = {}): CanvasNode {
  return {id:'build-project',title:'Build project',tier:'project',kind:'project',state:'live',seat:0,grant:0,free:0,
    parent:'boss',charter:'Shared build tasks.',children:[],lineage:[],turns:[],audiences_held:[],mail_pending:0,
    busy:false,configured_scope:{tools:{},add_dirs:[],...scope},scope:{tools:{},add_dirs:[]}} as unknown as CanvasNode
}
export const ackTree={slug:'synthetic',roots:[]} as unknown as TreePayload
export function mockAckSettings(checkups=true) {
  globalThis.fetch=(async(url)=>({ok:true,status:200,headers:new Headers(),json:async()=>
    String(url).includes('/app-settings/runtime')?{working_checkups_enabled:checkups}:
    String(url).includes('history')?{history:[]}: {}} as Response)) as typeof fetch
}
