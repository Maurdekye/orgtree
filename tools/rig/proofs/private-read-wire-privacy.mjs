// Regression for user inbox/history, single mail and document reader bodies.
import fs from 'node:fs'
import crypto from 'node:crypto'
import {Proof} from '../proof.mjs'
export function setup(){return {fixture:{org:{name:'Private read wire'},agents:[{name:'worker',tier:'sol',grant:4}]}}}
export default async function(rig,{flags}){
 const mode=flags['quiet-log']?'off':'on',p=new Proof('private-read-wire-'+mode)
 const marker='PRIVATE-READER-CANARY-'+mode+'-'+crypto.randomBytes(6).toString('hex'),mailText=marker+'-mail',docText=marker+'-document'
 const sent=await rig.tool('worker','orgtree_message',{to:'user',body:mailText,notice:true})
 const presented=await rig.tool('worker','orgtree_present',{title:'Synthetic reader proof',body:docText})
 p.check('synthetic mail and document fixtures were created through real tools',sent.ok&&presented.ok)
 if(!sent.ok||!presented.ok)return p.summary()
 const mail=rig.one(`SELECT m.uid FROM ot.mail m JOIN ot.orgs o ON o.id=m.org_id WHERE o.slug='${rig.org}' AND m.sender='worker' AND m.recipient_kind='user' ORDER BY m.id DESC LIMIT 1`)
 const doc=rig.one(`SELECT d.uid FROM ot.documents d JOIN ot.orgs o ON o.id=d.org_id WHERE o.slug='${rig.org}' AND d.node_name='worker' ORDER BY d.id DESC LIMIT 1`)
 p.check('requested verbose mode is actually active',(await rig.api('GET','/api/app-settings/runtime')).verbose_logging===(mode==='on'))
 const pid=rig.refresh().enginePid
 const logFile=await rig.waitFor(()=>rig.engineLogFiles().find(file=>fs.readFileSync(file,'utf8').includes(`engine starting pid=${pid} `)),{what:'this engine session log',timeout:10000})
 const cases=[
  ['inbox',`/api/orgs/${rig.org}/inbox`,mailText,v=>JSON.stringify(v).includes(mailText)],
  ['inbox-history',`/api/orgs/${rig.org}/inbox?folder=inbox`,mailText,v=>JSON.stringify(v).includes(mailText)],
  ['mail-by-id',`/api/orgs/${rig.org}/mail/user/${mail.uid}`,mailText,v=>v.found===true&&JSON.stringify(v.mail).includes(mailText)],
  ['document',`/api/orgs/${rig.org}/documents/${doc.uid}`,docText,v=>v.id===doc.uid&&v.body===docText]
 ]
 for(const [name,route,canary,clientOK]of cases){
  const offset=fs.statSync(logFile).size,value=await rig.api('GET',route)
  p.check(name+': client receives unchanged private content and metadata',clientOK(value))
  const end='reader-wire-end-'+name+'-'+mode
  await rig.api('GET','/api/templates?name='+end)
  await rig.waitFor(()=>fs.readFileSync(logFile,'utf8').split(/\r?\n/).some(line=>line.includes('RESPONSE')&&line.includes(end)),{what:'reader wire window complete',timeout:10000})
  const log=fs.readFileSync(logFile).subarray(offset).toString('utf8')
  const wire=log.split(/\r?\n/).filter(line=>/\b(?:REQUEST|RESPONSE)\s/.test(line)&&line.includes(route))
  const responses=wire.filter(line=>line.includes('RESPONSE')&&line.includes('200 OK'))
  p.check(name+': positive wire metadata control exists',responses.length===1,{lines:responses.length})
  p.check(name+': wire bodies omit the private canary',wire.length===2&&wire.every(line=>line.includes('[body omitted]'))&&!wire.some(line=>line.includes(canary)),{leaked:responses.some(line=>line.includes(canary))})
  p.check(name+': handler and helper logs omit the private canary',!log.includes(canary))
  p.file(name+'-window.log',log)
 }
 p.note('Synthetic tool-created mail/document content, actual HTTP responses and this engine PID/session log. Each read has a separate byte window; no live or provider data.',{mode,pid,logFile})
 return p.summary()
}
