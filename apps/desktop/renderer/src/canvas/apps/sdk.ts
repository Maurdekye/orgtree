// Provisional4.5 API: opaque HTML talks only to its bound host. No credential,
// arbitrary endpoint, caller identity or permission-decision method is exposed.
export const PANEL_PROTOCOL = 'orgtree-panel-v1'
export const PANEL_CSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
export interface PanelRequest {id:string;method:string;args:unknown}
export function panelRequest(event:MessageEvent,source:Window|null,channel:string):PanelRequest|null {
  if(!source || event.source!==source || event.origin!=='null')return null
  const d=event.data
  if(!d || typeof d!=='object' || Array.isArray(d) || d.protocol!==PANEL_PROTOCOL || d.channel!==channel)return null
  if(typeof d.id!=='string'||d.id.length>80||!d.id||typeof d.method!=='string'||d.method.length>80)return null
  if(Object.keys(d).some(k=>!['protocol','channel','id','method','args'].includes(k)))return null
  try{if(JSON.stringify(d).length>2*1024*1024+8192)return null}catch{return null}
  return{id:d.id,method:d.method,args:d.args}
}
export function panelDocument(html:string,channel:string,mediaSource?:string):string {
  // Prefix before ANY author markup: even a script placed before <head> must
  // follow the restrictive policy. Additional app CSP can only restrict it.
  const sdk=String.raw`(()=>{'use strict';const protocol='orgtree-panel-v1',channel=CHANNEL;
let ready=false,seq=0;const pending=new Map(),queued=[],listeners=new Map();
let transport;const hello=()=>{transport?.close();const link=new MessageChannel();transport=link.port1;transport.onmessage=e=>receive(e.data);transport.start();parent.postMessage({protocol,channel,id:'ready',method:'host.ready'},'*',[link.port2])};const handshake=setInterval(hello,250);hello();setTimeout(()=>clearInterval(handshake),30000);
const send=m=>{if(ready)parent.postMessage(m,'*');else queued.push(m)};
const call=(method,args)=>new Promise((resolve,reject)=>{if(pending.size>=64){reject(Error('Too many pending panel requests'));return}const id=String(++seq),timer=setTimeout(()=>{pending.delete(id);reject(Error('Panel request timed out'))},method==='engine.call'||method==='files.call'?150000:30000);pending.set(id,{resolve,reject,timer});send({protocol,channel,id,method,args})});
const on=(name,fn)=>{if(typeof fn!=='function')throw Error('Expected an event listener');if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);return()=>listeners.get(name)?.delete(fn)};
const receive=d=>{if(!d||d.protocol!==protocol||d.channel!==channel)return;
if(d.kind==='ready'){clearInterval(handshake);if(!ready){ready=true;for(const m of queued.splice(0))parent.postMessage(m,'*')}return}
if(d.kind==='event'){for(const fn of listeners.get(d.name)||[])try{fn(d.payload)}catch{};return}
const p=pending.get(d.id);if(!p)return;pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(Error(d.error)):p.resolve(d.result)};
const state=Object.freeze({get:()=>call('state.get'),set:value=>call('state.set',value),patch:value=>call('state.patch',value),onChange:fn=>on('state.changed',fn)});
const storage=Object.freeze({getItem:async key=>{const s=await state.get();return Object.prototype.hasOwnProperty.call(s,key)?s[key]:null},setItem:async(key,value)=>{const s=await state.get();Object.defineProperty(s,String(key),{value,writable:true,enumerable:true,configurable:true});return state.set(s)},removeItem:key=>state.patch({[String(key)]:null}),clear:()=>state.set({})});
const files=Object.freeze({choose:()=>call('files.call',{action:'choose'}),open:(root,path)=>call('files.call',{action:'open',root,path}),read:(file,options={})=>call('files.call',{action:'read',file,offset:options.offset,limit:options.limit}),media:file=>call('files.call',{action:'media',file})});
Object.defineProperty(window,'orgtree',{value:Object.freeze({version:1,state,storage,files,on,events:Object.freeze({fire:(name,payload)=>call('engine.call',{action:'events.fire',args:{name,payload}})}),emit:(name,payload)=>call('event.emit',{name,payload}),call:(action,args)=>call('engine.call',{action,args})}),writable:false,configurable:false});
})();`.replace('CHANNEL',JSON.stringify(channel))
  let csp=PANEL_CSP
  if(mediaSource){
    const url=new URL(mediaSource)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!/^\/api\/orgs\/[^/]+\/apps\/media$/.test(url.pathname)||/[\s;<>"']/.test(url.href))throw Error('Invalid host media source.')
    csp=csp.replace('media-src data: blob:;',`media-src data: blob: ${url.href};`)
  }
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="referrer" content="no-referrer"><script>'+sdk+'</script>'+html.replace(/^\s*<!doctype[^>]*>/i,'')
}
