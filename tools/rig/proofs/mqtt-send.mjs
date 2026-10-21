// Synthetic MQTT 3.1.1 loopback broker; never connects to a live Orgtree dog.
import net from 'node:net'
import {Proof} from '../proof.mjs'
export async function setup(){return {recover:true,'quiet-log':true,maxParked:1,fixture:{org:{name:'MQTT publish'},agents:[{name:'boss',tier:'sol',grant:20},{name:'carol',tier:'sol',grant:0}]}}}
export default async function(rig){
 const p=new Proof('mqtt-send'),sockets=new Set(),got=[],subscriptions=[];let connects=0
 const packet=(head,body)=>{const len=[];let n=body.length;do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;len.push(b)}while(n);return Buffer.concat([Buffer.from([head,...len]),body])}
 const str=s=>{const b=Buffer.from(s),n=Buffer.alloc(2);n.writeUInt16BE(b.length);return Buffer.concat([n,b])}
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buf=Buffer.alloc(0)
  socket.on('data',chunk=>{buf=Buffer.concat([buf,chunk]);for(;;){
   if(buf.length<2)return;let n=0,m=1,i=1,b;do{if(i>=buf.length)return;b=buf[i++];n+=(b&127)*m;m*=128;if(i>5)throw Error('bad test packet')}while(b&128)
   if(buf.length<i+n)return;const head=buf[0],body=buf.subarray(i,i+n);buf=buf.subarray(i+n)
   if(head>>4===1){connects++;socket.write(Buffer.from([0x20,2,0,0]))}
   else if(head>>4===8){const topic=body.subarray(4,4+body.readUInt16BE(2)).toString();subscriptions.push(topic);socket.write(Buffer.from([0x90,3,body[0],body[1],0]))}
   else if(head>>4===3){const size=body.readUInt16BE(0),topic=body.subarray(2,2+size).toString(),qos=(head>>1)&3,off=2+size,payload=body.subarray(off+(qos?2:0));got.push({topic,payload:payload.toString(),qos,retain:!!(head&1)});
    if(qos===1)socket.write(Buffer.from([0x40,2,body[off],body[off+1]]));
    if(topic.startsWith('mqtt-send/'))socket.write(packet(0x30,Buffer.concat([str(topic),payload])))
   }else if(head>>4===12)socket.write(Buffer.from([0xd0,0]));else if(head>>4===14)socket.end()
  }})
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const until=async fn=>{try{await rig.waitFor(fn,{what:'synthetic MQTT publish evidence',timeout:5000});return true}catch{return false}}
 const send=extra=>rig.tool('boss','orgtree_watchdog',{action:'send',id:'publish',...extra})
 try{
  const made=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'mqtt',name:'publish',target:`mqtt://127.0.0.1:${server.address().port}`,pattern:'mqtt-send/#',interval_s:5,notice:true})
  p.check('control: local MQTT dog connected and subscribed',made.ok&&await until(()=>subscriptions.includes('mqtt-send/#')),made.text)
  const first=await send({topic:'mqtt-send/reply',message:{hello:'世界'},qos:1,retain:true})
  p.check('MQTT send succeeds with byte/topic/time receipt',first.ok&&first.json?.sent&&first.json?.topic==='mqtt-send/reply'&&first.json?.bytes===Buffer.byteLength('{"hello":"世界"}')&&!!first.json?.at,first.text)
  p.check('broker receives exact topic, compact JSON, qos and retain',first.ok&&await until(()=>got.some(x=>x.topic==='mqtt-send/reply'&&x.payload==='{"hello":"世界"}'&&x.qos===1&&x.retain)))
  p.check('publish uses the original connection',connects===1,{connects})
  p.check('matching reply becomes an untrusted dog fire',first.ok&&await until(()=>rig.sql("SELECT body FROM ot.mail WHERE body LIKE '%世界%' AND body LIKE '%untrusted%'").length>0))
  const second=await send({topic:'mqtt-send/plain',payload:'text'})
  p.check('payload alias defaults to qos0 and retainfalse',second.ok&&await until(()=>got.some(x=>x.topic==='mqtt-send/plain'&&x.payload==='text'&&x.qos===0&&!x.retain)),second.text)
  const empty=await send({topic:'mqtt-send/clear',message:'',retain:true})
  p.check('empty MQTT payload can clear a retained value',empty.ok&&await until(()=>got.some(x=>x.topic==='mqtt-send/clear'&&x.payload===''&&x.retain)),empty.text)
  for(const topic of ['mqtt-send/+','mqtt-send/#','']){
   const r=await send({topic,message:'refused'});p.check('invalid publish topic refused: '+JSON.stringify(topic),!r.ok&&/topic/i.test(r.text),r.text)
  }
  for(const extra of [{topic:'mqtt-send/large',message:'界'.repeat(21846)},{topic:'mqtt-send/large-json',message:{text:'x'.repeat(65536)}},{topic:'mqtt-send/qos',message:'no',qos:3},{topic:'mqtt-send/retain',message:'no',retain:'yes'}]){
   const r=await send(extra);p.check('invalid send options refused '+extra.topic,!r.ok&&/bytes|KB|qos|retain/i.test(r.text),r.text)
  }
  const outsider=await rig.tool('carol','orgtree_watchdog',{action:'send',id:'boss/publish',topic:'mqtt-send/foreign',message:'forbidden'})
  p.check('unrelated non-owner cannot publish',!outsider.ok&&/owner|superior|manage/i.test(outsider.text),outsider.text)
  await rig.tool('boss','orgtree_watchdog',{action:'pause',id:'publish'})
  const paused=await send({topic:'mqtt-send/paused',message:'no'})
  p.check('paused dog refuses publishing',!paused.ok&&/paused/i.test(paused.text),paused.text)
  await rig.tool('boss','orgtree_watchdog',{action:'resume',id:'publish'})
  await until(()=>rig.one("SELECT memo->'run'->'mqtt'->>'state' AS state FROM ot.watchdogs WHERE name='publish'")?.state==='connected')
  const before=got.length;for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r))
  await until(()=>rig.one("SELECT memo->'run'->'mqtt'->>'state' AS state FROM ot.watchdogs WHERE name='publish'")?.state!=='connected')
  const down=await send({topic:'mqtt-send/down',message:'not queued'})
  p.check('disconnected connection refuses instead of buffering',!down.ok&&/connect|connection/i.test(down.text)&&got.length===before,down.text)
  p.check('refused payloads never reached broker',!got.some(x=>/foreign|paused|down|large|qos|retain/.test(x.topic)),got.map(({topic})=>topic))
  p.file('broker.json',{connects,subscriptions,got});return p.summary()
 }finally{for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(r=>server.close(r))}
}
