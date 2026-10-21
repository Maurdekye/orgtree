// Synthetic text/thinking through fake CLI, then the real chat HTTP boundary.
import fs from 'node:fs'
import crypto from 'node:crypto'
import {Proof} from '../proof.mjs'

export function setup() { return {fixture:{org:{name:'Chat wire proof'},agents:[{name:'worker',tier:'sol'}]}} }

export default async function(rig,{flags}) {
  const mode=flags['quiet-log']?'off':'on',p=new Proof('chat-wire-privacy-'+mode)
  const marker='PRIVATE-CHAT-CANARY-'+mode+'-'+crypto.randomBytes(6).toString('hex')
  const thought=marker+'-thinking',reply=marker+'-text'
  rig.scenario({agents:{worker:{turns:[{match:'WIRE-CHAT-PROBE',steps:[{thinking:thought},{text:reply}]}]}}})
  await rig.userMail('worker','WIRE-CHAT-PROBE')
  await rig.waitTurns('worker',1,{timeout:60000})
  await rig.waitFor(()=>rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'synthetic turn settled',timeout:60000})
  const runtime=await rig.api('GET','/api/app-settings/runtime')
  p.check('requested verbose mode is actually active',runtime.verbose_logging===(mode==='on'))
  const pid=rig.refresh().enginePid
  const logFile=await rig.waitFor(()=>rig.engineLogFiles().find(file=>fs.readFileSync(file,'utf8').includes(`engine starting pid=${pid} `)),{what:'this engine session log',timeout:10000})
  const offset=fs.statSync(logFile).size,route=`/api/orgs/${rig.org}/nodes/worker/chat`
  const chat=await rig.api('GET',route+'?last=50')
  p.check('client receives both synthetic text and thinking',JSON.stringify(chat.messages).includes(reply)&&JSON.stringify(chat.messages).includes(thought))
  const paged=await rig.api('GET',route+'?last=50&before=9007199254740991')
  p.check('parameterized chat still returns the private transcript',JSON.stringify(paged.messages).includes(reply)&&JSON.stringify(paged.messages).includes(thought))
  p.check('normal chat metadata remains available',chat.windowed===true&&typeof chat.conversation_id==='string'&&chat.busy===false)
  const unauth=await fetch(rig.url+route,{signal:AbortSignal.timeout(10000)});await unauth.text()
  const bad=await rig.api('GET',route+'?last=not-a-number').then(()=>null,e=>e.status)
  p.check('rejected chat requests are actually exercised',unauth.status===403&&bad===400,{unauth:unauth.status,bad})
  const end='chat-wire-window-end-'+mode
  await rig.api('GET','/api/templates?name='+end)
  await rig.waitFor(()=>fs.readFileSync(logFile,'utf8').split(/\r?\n/).some(line=>line.includes('RESPONSE')&&line.includes(end)),{what:'wire logger completed chat window',timeout:10000})
  const log=fs.readFileSync(logFile).subarray(offset).toString('utf8')
  const wire=log.split(/\r?\n/).filter(line=>/\b(?:REQUEST|RESPONSE)\s/.test(line)&&line.includes('/chat'))
  const responses=wire.filter(line=>line.includes('RESPONSE')&&line.includes('200 OK'))
  p.check('positive wire control retains route, query and status metadata',responses.length===2&&responses.some(line=>line.includes('before=9007199254740991')),{lines:responses.length})
  p.check('chat response wire lines never disclose text or thinking canaries',responses.every(line=>!line.includes(marker)),{leaked:responses.some(line=>line.includes(marker))})
  p.check('accepted and rejected chat bodies are omitted',wire.length>=8&&wire.every(line=>line.includes('[body omitted]')))
  p.check('no diagnostic entry in the read window discloses transcript contents',!log.includes(marker))
  p.file('wire-window.log',wire.join('\n')+'\n')
  p.note('Fake-CLI turn and real HTTP responses; synthetic text/thinking only. Window begins after turn completion and uses this engine PID/session file.',{mode,pid,logFile,offset})
  return p.summary()
}
