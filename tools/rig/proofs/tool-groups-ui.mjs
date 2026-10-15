import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

export default async function(rig) {
  const p = new Proof('tool-groups-ui')
  const result = await runDesktop(rig,fileURLToPath(new URL('../desktop/tool-groups.cjs',import.meta.url)),{preset:'tall',out:path.join(p.dir,'desktop'),args:{org:rig.org}})
  p.file('desktop.json',result)
  p.check('scope UI script completes',result.ok,result.error)
  const labels=['Docket work','Team management','Messaging','Organization reading','Watchdogs','Runtime and accounts','User questions and delivery','Organization Logo']
  const v=result.value??{}
  p.check('all eight groups default on',labels.every(label=>v.before?.some(x=>x.label===label&&x.checked)))
  p.check('scope save persists disabled group',v.saved?.some(x=>x.label==='Docket work'&&!x.checked))
  p.check('child shows inherited ceiling',v.inherited?.some(x=>x.label==='Docket work'&&!x.checked&&x.disabled))
  p.check('Logo switch persists off',v.saved?.some(x=>x.label==='Organization Logo'&&!x.checked))
  p.check('Logo switch shows inherited denial',v.inherited?.some(x=>x.label==='Organization Logo'&&!x.checked&&x.disabled))
  const denied=await rig.tool('boss','orgtree_work',{action:'list'})
  p.check('renderer save changes actual tool authority',!denied.ok,denied.text)
  const logo=await rig.tool('alice','orgtree_org_logo',{action:'remove'})
  p.check('renderer Logo denial changes actual child tool authority',!logo.ok,logo.text)
  return p.summary()
}
