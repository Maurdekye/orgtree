// Loopback-only administrative connection mail and data-fire boundaries.
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'
export async function setup(){return {recover:true,'quiet-log':true,maxParked:1,fixture:{org:{name:'Connection modes'},agents:[{name:'boss',tier:'sol',grant:20},{name:'carol',tier:'sol',grant:0}]}}}
export default async function(rig){
 const p=new Proof('connection-messages'),sockets=new Set(),refused=new Set(),connections=new Map()
 const frame=text=>Buffer.concat([Buffer.from([0x81,Buffer.byteLength(text)]),Buffer.from(text)])
 const server=http.createServer()
 server.on('upgrade',(req,socket)=>{
  const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`)
  sockets.add(socket);connections.set(req.url,(connections.get(req.url)??0)+1)
  socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})
  socket.on('data',buf=>{if((buf[0]&15)===8)socket.end()})
  socket.write(frame('greeting: nonmatching'))
 })
 const broker=net.createServer(socket=>{
  refused.add(socket);socket.on('close',()=>refused.delete(socket));socket.on('error',()=>{})
  socket.once('data',()=>socket.write(Buffer.from([0x20,2,0,5])))
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r));await new Promise(r=>broker.listen(0,'127.0.0.1',r))
 const dog=name=>rig.one(`SELECT id,uid,state,fired,memo FROM ot.watchdogs WHERE name='${name}' ORDER BY id DESC LIMIT 1`)
 const mail=name=>rig.sql(`SELECT notice,body FROM ot.mail WHERE kind='watchdog' AND body LIKE '%"${name}"%' ORDER BY id`)
 const until=async fn=>{try{await rig.waitFor(fn,{timeout:6000,every:30,what:'synthetic connection verdict'});return true}catch{return false}}
 try{
  for(const [mode,dataNotice] of [['notice',false],['wake',true],['off',false]]){
   const name='ws-'+mode,made=await rig.tool('boss','orgtree_watchdog',{action:'create',name,kind:'websocket',target:`ws://127.0.0.1:${server.address().port}/${name}`,pattern:'^payload:',interval_s:5,...(mode==='notice'?{}:{connection_messages:mode}),notice:dataNotice,once:true,
    fire_actions:[{tool:'orgtree_watchdog',args:{action:'create',name:'action-'+mode,kind:'event',target:'engine.started'}}]})
   p.check(`${name} creates`,made.ok,made.text)
   p.check(`${name} runner connected`,await until(()=>dog(name)?.memo?.run?.websocket?.state==='connected'))
   p.check(`${name} independent connection delivery`,mode==='off'?mail(name).length===0:await until(()=>mail(name).some(m=>m.notice===(mode==='notice')&&m.body.includes('WebSocket connected'))))
   p.check(`${name} connection does not spend once, count or run actions`,dog(name)?.state==='armed'&&dog(name)?.fired===0&&!dog('action-'+mode))
  }
  const before=[...connections.values()].reduce((a,b)=>a+b,0)
  const changed=await rig.tool('boss','orgtree_watchdog',{action:'configure',id:dog('ws-off').uid,connection_messages:'notice'})
  p.check('agent configures without reconnect or fire',changed.ok&&before===[...connections.values()].reduce((a,b)=>a+b,0)&&dog('ws-off').fired===0)
  const saved=await rig.api('POST',`/api/orgs/${rig.org}/watchdogs`,{id:'boss/'+dog('ws-off').uid,action:'configure',connection_messages:'off'})
  p.check('desktop configures without reconnect',saved.connection_messages==='off'&&before===[...connections.values()].reduce((a,b)=>a+b,0))
  for(const socket of sockets)socket.write(frame('payload: normal data'))
  for(const [mode,dataNotice] of [['notice',false],['wake',true],['off',false]]){
   const name='ws-'+mode
   p.check(`${name} data keeps once, actions and original delivery`,await until(()=>dog(name)?.fired===1&&dog(name)?.state==='spent'&&!!dog('action-'+mode)&&mail(name).some(m=>m.body.includes('payload: normal data')&&m.body.includes('untrusted')&&m.notice===dataNotice)))
  }
  for(const mode of ['notice','wake','off']){
   const name='mqtt-'+mode,made=await rig.tool('boss','orgtree_watchdog',{action:'create',name,kind:'mqtt',target:`mqtt://127.0.0.1:${broker.address().port}`,pattern:'#',connection_messages:mode,notice:mode==='wake',credentials:{username:'synthetic',client_id:name}})
   p.check(`${name} creates at synthetic refusing broker`,made.ok,made.text)
   p.check(`${name} runner observed refusal`,await until(()=>dog(name)?.memo?.run?.mqtt?.state==='refused'))
   p.check(`${name} refusal respects independent connection delivery`,mode==='off'?mail(name).length===0:await until(()=>mail(name).some(m=>m.notice===(mode==='notice')&&m.body.includes('REFUSED'))))
   p.check(`${name} refusal never counts as fire`,dog(name)?.fired===0)
  }
  const legacy=dog('mqtt-notice');rig.exec(`UPDATE ot.watchdogs SET memo=(memo-'connection_messages')||'{"websocket":{"notify_on_connect":false}}' WHERE id=${legacy.id}`)
  const listed=await rig.tool('boss','orgtree_watchdog',{action:'list'})
  p.check('agent legacy inventory defaults notice',listed.json?.watchdogs?.some(d=>d.name==='mqtt-notice'&&d.connection_messages==='notice'))
  const desktop=await rig.api('GET',`/api/orgs/${rig.org}/watchdogs?owner=boss`)
  p.check('desktop inventory has same migrated default',desktop.watchdogs.some(d=>d.name==='mqtt-notice'&&d.connection_messages==='notice'))
  const conflict=await rig.tool('boss','orgtree_watchdog',{action:'configure',id:legacy.uid,connection_messages:'wake',notify_on_connect:true})
  p.check('conflicting alias is refused',!conflict.ok)
  const alias=await rig.tool('boss','orgtree_watchdog',{action:'configure',id:legacy.uid,notify_on_connect:false})
  p.check('legacy alias false maps off',alias.ok&&alias.json?.connection_messages==='off')
  const forbidden=await rig.tool('carol','orgtree_watchdog',{action:'configure',id:'boss/'+legacy.uid,connection_messages:'wake'})
  p.check('peer cannot change another watcher',!forbidden.ok&&dog('mqtt-notice').memo.connection_messages==='off')
  p.file('mail.json',rig.sql("SELECT notice,body FROM ot.mail WHERE kind='watchdog' ORDER BY id"));p.file('connections.json',Object.fromEntries(connections))
  return p.summary()
 }catch(error){p.check('connection-message proof completed',false,String(error));return p.summary()}
 finally{for(const socket of [...sockets,...refused])socket.destroy();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>broker.close(r))])}
}
