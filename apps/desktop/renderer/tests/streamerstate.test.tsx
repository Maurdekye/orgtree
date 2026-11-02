import { JSDOM, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { protectStreamerDocument, setStreamerMode, startStreamerMode } from '../src/streamer'

test('startup fails closed, newer preferences beat late loads, popouts follow toggles, and failed saves retain protection', async () => {
  const globals = globalThis as unknown as Record<string, unknown>, saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const previousBridge = Object.getOwnPropertyDescriptor(window, 'orgtreeDesktop')
  const css = Object.getOwnPropertyDescriptor(window, 'CSS'), highlight = Object.getOwnPropertyDescriptor(window, 'Highlight')
  const registry = new Map(), child = new JSDOM('<!doctype html><html><body>Private Account</body></html>', {url:'http://localhost/'})
  for (const win of [window, child.window]) {
    Object.defineProperty(win, 'CSS', {value:{highlights:registry},configurable:true})
    Object.defineProperty(win, 'Highlight', {value:class extends Array {constructor(...args:unknown[]){super(...args)}},configurable:true})
  }
  let receive: (e:unknown)=>void = () => {}, complete: (p:unknown)=>void = () => {}, fail = false
  const patches: unknown[] = []
  Object.defineProperty(window, 'orgtreeDesktop', {configurable:true,value:{
    onEvent:(fn:(e:unknown)=>void)=>{receive=fn;return()=>{}},
    getPreferences:()=>new Promise(resolve=>{complete=resolve}),
    setPreferences:async(p:unknown)=>{patches.push(p);if(fail)throw Error('no save');receive({type:'preferences',data:p});return p},
  }})
  class Socket { onclose: (()=>void)|null=null; close(){this.onclose?.()} }
  globals.WebSocket=Socket
  const epoch='streamer-state', snapshot={type:'app_snapshot',epoch,seq:1,registry:{type:'registry_snapshot',epoch,cursor:{app_uuid:'test',incarnation:epoch,rev:1},records:[]},summaries:{},notices:{},runtime:{orgs:{},values:{}}}
  globals.fetch=async(url:unknown)=>new Response(JSON.stringify(String(url)==='/api/app/records'?snapshot:{accounts:[{id:'private-account',name:'Private Account'}]}))
  const stop=startStreamerMode(), stopChild=protectStreamerDocument(child.window.document)
  try {
    assert.ok(document.documentElement.classList.contains('streamer-covered'))
    receive({type:'preferences',data:{streamerMode:true}}); complete({streamerMode:false}); await flush(12)
    assert.ok(document.documentElement.classList.contains('streamer-on'))
    assert.equal(document.documentElement.classList.contains('streamer-covered'),false)
    assert.ok(child.window.document.documentElement.classList.contains('streamer-on'))
    await setStreamerMode(false); await flush()
    assert.equal(child.window.document.documentElement.classList.contains('streamer-on'),false)
    await setStreamerMode(true); await flush()
    fail=true; await setStreamerMode(false)
    assert.ok(document.documentElement.classList.contains('streamer-on'))
    assert.deepEqual(patches,[{streamerMode:false},{streamerMode:true},{streamerMode:false}])
    assert.equal(child.window.document.body.textContent?.includes('Private Account'),true,'original text remains available to copy')
  } finally {
    stopChild();stop();child.window.close();Object.assign(globals,saved)
    for(const [key,descriptor] of [['CSS',css],['Highlight',highlight],['orgtreeDesktop',previousBridge]] as const) {
      if(descriptor)Object.defineProperty(window,key,descriptor);else Reflect.deleteProperty(window,key)
    }
  }
})
