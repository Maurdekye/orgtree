// Synthetic node mailbox and retained org-inbox readers at the real HTTP boundary.
import fs from 'node:fs'
import crypto from 'node:crypto'
import {Proof} from '../proof.mjs'
export function setup(){return {fixture:{org:{name:'Remaining inbox privacy'},agents:[{name:'worker',tier:'sol'}]}}}
export default async function(rig,{flags}){
 const mode=flags['quiet-log']?'off':'on',p=new Proof('remaining-inbox-wire-'+mode)
 const marker='PRIVATE-INBOX-CANARY-'+mode+'-'+crypto.randomBytes(6).toString('hex'),nodeText=marker+'-node',orgText=marker+'-org',filterText=marker+'-filter'
 await rig.op({op:'halt',nodes:['worker']})
 await rig.userMail('worker',nodeText,{notice:true})
 const tagged=await rig.tool('worker','orgtree_message',{metadata:{to:'user',tags:['Privacy canary'],notice:true},body:filterText})
 const orgId=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id,node=rig.agentRow('worker')
 // Seed only this isolated rig database; no outside message or live org is used.
 rig.exec(`INSERT INTO ot.org_inbox(uid,org_id,dir,peer,body) VALUES('synthetic-retained',${orgId},'in','@org:synthetic','${orgText}')`)
 p.check('synthetic node mail, tagged user mail and retained org-inbox fixtures exist',tagged.ok&&!!rig.one(`SELECT id FROM ot.mail WHERE recipient_agent_id=${node.id} AND body='${nodeText}'`)&&!!rig.one(`SELECT id FROM ot.org_inbox WHERE org_id=${orgId} AND body='${orgText}'`))
 p.check('requested verbose mode is actually active',(await rig.api('GET','/api/app-settings/runtime')).verbose_logging===(mode==='on'))
 const pid=rig.refresh().enginePid
 const logFile=await rig.waitFor(()=>rig.engineLogFiles().find(file=>fs.readFileSync(file,'utf8').includes(`engine starting pid=${pid} `)),{what:'this engine session log',timeout:10000})
 const cases=[
  ['node-inbox',`/api/orgs/${rig.org}/nodes/worker/inbox`,nodeText,v=>Array.isArray(v.pending)&&JSON.stringify(v).includes(nodeText)],
  ['node-history',`/api/orgs/${rig.org}/nodes/worker/inbox?folder=inbox`,nodeText,v=>JSON.stringify(v).includes(nodeText)],
  ['org-inbox',`/api/orgs/${rig.org}/org_inbox`,orgText,v=>v.total===1&&v.unread===1&&v.entries?.[0]?.body===orgText],
  ['inbox-filter',`/api/orgs/${rig.org}/inbox/filter`,filterText,v=>JSON.stringify(v).includes(filterText)&&JSON.stringify(v).includes('Privacy canary'),'POST',{tags:['Privacy canary']}]
 ]
 const shown=route=>mode==='on'?route:route.replace(/=[^&]*/g,'=****') // the normal log keeps parameter names only
 for(const [name,route,canary,clientOK,method='GET',body]of cases){
  const offset=fs.statSync(logFile).size,value=await rig.api(method,route,body)
  p.check(name+': client receives unchanged private content and metadata',clientOK(value))
  const end='remaining-inbox-end-'+name+'-'+mode
  // the window marker rides in the path: normal logs elide query values (verbose logs keep them)
  await rig.api('GET','/api/templates/'+end).then(()=>null,e=>e.status)
  await rig.waitFor(()=>fs.readFileSync(logFile,'utf8').split(/\r?\n/).some(line=>line.includes('RESPONSE')&&line.includes(end)),{what:'reader wire window complete',timeout:10000})
  const log=fs.readFileSync(logFile).subarray(offset).toString('utf8')
  const wire=log.split(/\r?\n/).filter(line=>/\b(?:REQUEST|RESPONSE)\s/.test(line)&&line.includes(shown(route))),responses=wire.filter(line=>line.includes('RESPONSE')&&line.includes('200 OK'))
  p.check(name+': positive wire metadata control exists',responses.length===1,{lines:responses.length})
  p.check(name+': wire bodies omit the private canary',wire.length===2&&wire.every(line=>line.includes('[body omitted]'))&&!wire.some(line=>line.includes(canary)),{leaked:responses.some(line=>line.includes(canary))})
  p.check(name+': handler and helper logs omit the private canary',!log.includes(canary))
  p.file(name+'-window.log',log)
 }
 p.note('Synthetic HTTP-created node mail and retained row in this run database only; separate per-reader byte windows and exact engine PID log. No live data, external mail or provider inference.',{mode,pid,logFile})
 return p.summary()
}
