// Real isolated HTTP logger, synthetic notes only. Run with and without --quiet-log.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {Proof} from '../proof.mjs'
import {TOKEN_HEADER} from '../lib.mjs'

export function setup() {
  return {fixture:{org:{name:'Template wire proof'},agents:[{name:'worker',tier:'sol'}]}}
}

export default async function(rig,{flags}) {
  const mode=flags['quiet-log']?'off':'on',p=new Proof('template-wire-privacy-'+mode)
  await rig.waitFor(async()=>!(await rig.api('GET','/api/templates')).loading,{what:'synthetic model availability settled',timeout:60000})
  const runtime=await rig.api('GET','/api/app-settings/runtime')
  p.check('requested verbose mode is actually active',runtime.verbose_logging===(mode==='on'))
  const pid=rig.refresh().enginePid
  const logFile=await rig.waitFor(()=>rig.engineLogFiles().find(file=>fs.readFileSync(file,'utf8').includes(`engine starting pid=${pid} `)),{what:'this engine session log',timeout:10000})
  const offset=fs.statSync(logFile).size
  const marker='PRIVATE-NOTE-CANARY-'+mode+'-'+crypto.randomBytes(6).toString('hex')
  const markers=[marker+'-shared',marker+'-team',marker+'-personal']
  const row=rig.one(`SELECT id,scratch_dir FROM ot.agents WHERE name='worker' AND state='live'`)
  const root=path.join(rig.data,'scratch',rig.org)
  const noteFiles=[path.join(root,'_shared','AGENTS.md'),path.join(root,'_teams',String(row.id),'AGENTS.md'),path.join(row.scratch_dir,'AGENTS.md')]
  for(let i=0;i<noteFiles.length;i++){fs.mkdirSync(path.dirname(noteFiles[i]),{recursive:true});fs.writeFileSync(noteFiles[i],markers[i])}
  const saveRoute=`/api/orgs/${rig.org}/template`
  const saved=await rig.api('POST',saveRoute,{name:'Wire copy '+mode,include:{standing_notes:true,charters:false,org_md:false,settings:false,quick_chat:false}})
  const copy=JSON.parse(saved.content)
  p.check('downloadable response retains all three exact note texts',copy.shared_agents_md===markers[0]&&copy.agents[0].team_agents_md===markers[1]&&copy.agents[0].scratch_agents_md===markers[2])
  p.check('saved file bytes match the downloadable response',fs.readFileSync(saved.path,'utf8')===saved.content)
  p.check('safe save metadata is unchanged',saved.id==='wire-copy-'+mode&&saved.file==='wire-copy-'+mode+'.json'&&saved.agents===1&&Array.isArray(saved.problems))
  const listed=await rig.api('GET','/api/templates')
  const preview=await rig.api('POST','/api/templates/resolve',{id:saved.id,name:'Wire recreated '+mode,dirs:[]})
  p.check('list and preview return metadata rather than copied note contents',!JSON.stringify([listed,preview]).includes(marker)&&preview.standing_notes===3&&preview.agents.length===1&&preview.ok)
  const created=await rig.api('POST','/api/orgs',{name:'Wire recreated '+mode,dirs:[],net_autoconnect:false,template:{id:saved.id}})
  const made=rig.one(`SELECT a.id,a.scratch_dir FROM ot.agents a JOIN ot.orgs o ON o.id=a.org_id WHERE o.slug='${created.slug}' AND a.state='live'`)
  const madeRoot=path.join(rig.data,'scratch',created.slug)
  const actual=[path.join(madeRoot,'_shared','AGENTS.md'),path.join(madeRoot,'_teams',String(made.id),'AGENTS.md'),path.join(made.scratch_dir,'AGENTS.md')]
  p.check('creation seeds all copied notes while returning only safe metadata',created.hired.length===1&&created.standing_notes.created===3&&actual.every((file,i)=>fs.readFileSync(file,'utf8')===markers[i])&&!JSON.stringify(created).includes(marker))
  const requestMarker='PRIVATE-TEMPLATE-REQUEST-'+mode+'-'+crypto.randomBytes(6).toString('hex')
  const raw=async(route,{auth=true,body={discarded_private_field:requestMarker},method='POST'}={})=>{
    const res=await fetch(rig.url+route,{method,headers:{'Content-Type':'application/json',...(auth?{[TOKEN_HEADER]:rig.token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
    await res.text();return res.status
  }
  const unauth=await raw(saveRoute,{auth:false})
  const unknown=await raw(saveRoute+'/unknown-child')
  const malformed=await raw(saveRoute,{body:{name:{private:requestMarker}}})
  const unknownPreview=await raw('/api/templates/unknown-child')
  const malformedPreview=await raw('/api/templates/resolve',{body:{name:{private:requestMarker}}})
  p.check('unauthenticated, unknown-child and malformed requests are actually rejected',unauth===403&&unknown===404&&malformed===422&&unknownPreview===404&&malformedPreview===422,{unauth,unknown,malformed,unknownPreview,malformedPreview})
  const conflict=await raw(saveRoute,{body:{name:'Wire copy '+mode,include:{standing_notes:true},discarded_private_field:requestMarker}})
  p.check('duplicate-name refusal keeps the saved template intact',conflict===409&&fs.readFileSync(saved.path,'utf8')===saved.content)
  // the window marker rides in the path: normal logs elide query values (verbose logs keep them)
  const end='wire-window-end-'+mode
  await rig.api('GET','/api/templates/'+end).then(()=>null,e=>e.status)
  await rig.waitFor(()=>fs.readFileSync(logFile,'utf8').split(/\r?\n/).some(line=>line.includes('RESPONSE')&&line.includes(end)),{what:'wire logger completed window',timeout:10000})
  const log=fs.readFileSync(logFile).subarray(offset).toString('utf8')
  const wire=log.split(/\r?\n/).filter(line=>/\b(?:REQUEST|RESPONSE)\s/.test(line))
  const responses=wire.filter(line=>line.includes('RESPONSE')&&line.includes(saveRoute)&&line.includes('200 OK'))
  p.check('positive diagnostic control includes the successful save response',responses.length===1,{lines:responses.length})
  p.check('accepted save wire responses never contain the note canaries',responses.every(line=>!line.includes(marker)),{leaked:responses.some(line=>line.includes(marker))})
  p.check('template wire logs omit accepted and rejected body contents',wire.filter(line=>line.includes('/template')).every(line=>line.includes('[body omitted]'))&&!wire.some(line=>line.includes(requestMarker)))
  p.check('no other engine log entry discloses copied notes',!log.includes(marker))
  p.file('wire-window.log',wire.join('\n')+'\n')
  p.note('Synthetic canaries only; this engine PID/session log and byte window were measured. No live org, real credentials or provider inference.',{mode,pid,logFile,offset})
  return p.summary()
}
