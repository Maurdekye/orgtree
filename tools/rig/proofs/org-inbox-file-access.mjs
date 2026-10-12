import { retainedInboxUpload } from './fixtures/retained-inbox-upload.mjs'
import { Proof } from '../proof.mjs'
export function setup() {
  return { fixture: { org: { name: 'Disabled attachment source' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}
export default async function(rig) {
  const p = new Proof('org-inbox-file-access')
  const A = rig.org
  await rig.op({op:'halt',nodes:['rhea']})
  const B = (await rig.api('POST','/api/orgs',{name:'Accepted recipient',dirs:[],net_autoconnect:false})).slug
  const C = (await rig.api('POST','/api/orgs',{name:'Unrelated reader',dirs:[],net_autoconnect:false})).slug
  await rig.op({op:'hire',name:'outsider',tier:'luna',grant:4},{org:C})
  await rig.op({op:'halt',nodes:['outsider']},{org:C})
  const marker = 'PRIVATE_RETAINED_INBOX_ATTACHMENT_TEST_ONLY'
  const staged = retainedInboxUpload(rig,A,'retained.txt',marker)
  const path = staged.path
  const get = async (org,node,filePath=path) => {
    const res=await fetch(`${rig.url}/api/orgs/${org}/nodes/${node}/file?path=${encodeURIComponent(filePath)}`,
      {headers:{'X-Orgtree-Desktop-Token':rig.token}})
    return {status:res.status,text:await res.text()}
  }
  p.check('enabled own-org control serves retained attachment',(await get(A,'rhea')).text===marker)
  const ordinaryResponse=await fetch(`${rig.url}/api/orgs/${A}/nodes/rhea/upload?name=ordinary.txt`,
    {method:'POST',headers:{'X-Orgtree-Desktop-Token':rig.token},body:'ORDINARY_UPLOAD_CONTROL'})
  if(!ordinaryResponse.ok) throw new Error('ordinary upload: '+ordinaryResponse.status)
  const ordinary=await ordinaryResponse.json()
  // A retained, unsubmitted staging file is protected by the same owner policy.
  const stagingPath=retainedInboxUpload(rig,A,'staged.txt','UNSUBMITTED_STAGE_CONTROL').path
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:false})
  p.check('unsubmitted staging file denied through unrelated route',(await get(C,'outsider',stagingPath)).status===403)
  p.check('ordinary upload remains readable while its owner inbox is disabled',(await get(A,'rhea',ordinary.path)).text==='ORDINARY_UPLOAD_CONTROL')
  const own=await get(A,'rhea'), neighbor=await get(C,'outsider')
  p.check('disabled own-org route denies',own.status===403,own)
  p.check('unrelated enabled neighbor cannot serve disabled inbox attachment',neighbor.status===403,neighbor)
  await rig.api('POST',`/api/orgs/${C}/settings`,{org_inbox_enabled:false})
  const bothOff=await get(C,'outsider')
  p.check('unrelated disabled neighbor cannot serve other disabled inbox attachment',bothOff.status===403,bothOff)
  await rig.api('POST',`/api/orgs/${A}/settings`,{org_inbox_enabled:true})
  p.check('re-enable restores original attachment',(await get(A,'rhea')).text===marker)
  p.check('re-enable restores unsubmitted stage',(await get(C,'outsider',stagingPath)).text==='UNSUBMITTED_STAGE_CONTROL')
  p.keep(rig,{grep:/retained.txt|inbox is disabled/})
  return p.summary()
}
