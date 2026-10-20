// Synthetic loopback only: connection signals are Orgtree events, not
// pattern-matched server greetings. Toggle without redial; persist on restart.
import http from 'node:http'
import crypto from 'node:crypto'
import {Proof} from '../proof.mjs'
export async function setup(){return {recover:true,'quiet-log':true,maxParked:1,fixture:{org:{name:'WebSocket connection notifications'},agents:[{name:'boss',tier:'sol',grant:20}]}}}
export default async function(rig){
 const p=new Proof('ws-connect-notify'),sockets=new Set(),counts=new Map()
 const frame=(op,text)=>{const b=Buffer.from(text);if(b.length>=126)throw Error('small synthetic frame only');return Buffer.concat([Buffer.from([0x80|op,b.length]),b])}
 const server=http.createServer()
 server.on('upgrade',(req,socket)=>{
  const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`)
  sockets.add(socket);counts.set(req.url,(counts.get(req.url)??0)+1)
  socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>sockets.delete(socket))
  socket.on('data',buf=>{if((buf[0]&15)===8)socket.end()})
  socket.write(frame(1,'welcome: synthetic server greeting'))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const target=name=>`ws://127.0.0.1:${server.address().port}/${name}`
 const dog=name=>rig.one(`SELECT id,uid,state,memo FROM ot.watchdogs WHERE name='${name}' ORDER BY id DESC LIMIT 1`)
 const signals=name=>rig.sql(`SELECT body FROM ot.mail WHERE body LIKE '%Orgtree connection event: WebSocket %' AND body LIKE '%"${name}"%'`)
 const fires=name=>rig.one(`SELECT fired FROM ot.watchdogs WHERE name='${name}' ORDER BY id DESC LIMIT 1`)?.fired??0
 const until=async check=>{try{await rig.waitFor(check,{timeout:4000,every:20,what:'synthetic websocket fire'})}catch{}return !!check()}
 const create=(name,extra={})=>rig.tool('boss','orgtree_watchdog',{action:'create',kind:'websocket',name,target:target(name),pattern:'^payload:',notice:true,interval_s:5,...extra})
 const configure=(name,enabled)=>rig.api('POST',`/api/orgs/${rig.org}/watchdogs`,{id:'boss/'+dog(name).uid,action:'configure',notify_on_connect:enabled})
 try{
  p.check('default dog creates', (await create('connect-default')).ok)
  p.check('explicit off dog creates', (await create('connect-off',{notify_on_connect:false})).ok)
  p.check('opt-in dog creates', (await create('connect-on',{notify_on_connect:true})).ok)
  p.check('opt-in sends one initial Orgtree connection fire despite a nonmatching server regex',await until(()=>signals('connect-on').length===1))
  p.check('default/off emit no initial connection events',signals('connect-default').length===0&&signals('connect-off').length===0)
  p.check('connection event is labelled Orgtree and is not EXTERNAL server data',signals('connect-on').some(r=>r.body.includes('WebSocket connected')&&!r.body.includes('untrusted')))
  const listed=await rig.api('GET',`/api/orgs/${rig.org}/watchdogs?owner=boss`)
  p.check('desktop inventory exposes explicit true/false',listed.watchdogs.find(w=>w.name==='connect-on')?.notify_on_connect===true&&listed.watchdogs.find(w=>w.name==='connect-default')?.notify_on_connect===false)
  const toolList=await rig.tool('boss','orgtree_watchdog',{action:'list'})
  p.check('tool list exposes notify_on_connect',toolList.ok&&toolList.text.includes('notify_on_connect'))
  const before=[...counts.values()].reduce((a,b)=>a+b,0)
  let changed=false
  try{await configure('connect-on',false);await configure('connect-off',true);changed=true}catch{}
  p.check('user can change the setting without reconnecting',changed&&before===[...counts.values()].reduce((a,b)=>a+b,0))
  // Emulate an existing row from before this field existed.
  rig.exec(`UPDATE ot.watchdogs SET memo=memo #- '{websocket,notify_on_connect}' WHERE id=${dog('connect-default').id}`)
  await rig.restart()
  p.check('enabled flag persists and sends reconnected on engine restart',await until(()=>signals('connect-off').some(r=>r.body.includes('WebSocket reconnected'))))
  p.check('disabled and legacy-absent flags remain silent after restart',signals('connect-default').length===0&&signals('connect-on').length===1)
  await rig.waitFor(()=>['connect-default','connect-off','connect-on'].every(name=>(counts.get('/'+name)??0)>=2),{timeout:10000,every:20,what:'all synthetic sessions reconnect'})
  for(const socket of sockets)socket.write(frame(1,'payload: still delivered'))
  p.check('server messages still fire with switch off',await until(()=>fires('connect-on')>=2&&fires('connect-default')>=1))
  p.check('matching server messages retain EXTERNAL tag',rig.sql("SELECT body FROM ot.mail WHERE body LIKE '%payload: still delivered%'").some(r=>r.body.includes('untrusted')))
  p.check('no nonmatching greeting bypasses the server pattern',rig.sql("SELECT 1 FROM ot.mail WHERE body LIKE '%welcome: synthetic server greeting%'").length===0)
  const greeting=await create('server-greeting',{notify_on_connect:false,pattern:'^welcome:'})
  p.check('switch off does not suppress a matching server greeting',greeting.ok&&await until(()=>fires('server-greeting')===1))
  const once=await create('connect-once',{notify_on_connect:true,once:true})
  p.check('connection event obeys normal one-shot semantics',once.ok&&await until(()=>dog('connect-once')?.state==='spent'))
  const invalid=await create('invalid-connect',{notify_on_connect:'yes'})
  p.check('nonboolean connect flag is refused',!invalid.ok&&invalid.text.includes('notify_on_connect'))
  const foreign=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'event',name:'foreign-connect',target:'engine.started',notify_on_connect:true})
  p.check('connect flag on another kind is refused',!foreign.ok&&foreign.text.includes('websocket'))
  p.file('counts.json',{connections:Object.fromEntries(counts),defaultFires:fires('connect-default'),onFires:fires('connect-on'),offFires:fires('connect-off')})
  return p.summary()
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))}
}
