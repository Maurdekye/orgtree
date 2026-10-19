import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {build} from 'esbuild'
const root=process.env.TAB_ORIGIN_NATIVE_OUT
assert.match(root||'',/^C:[\\/]orgtree-build[\\/]helper-transcript-sol[\\/]/i)
assert.equal(fs.existsSync(root),false,'preserve prior native receipts')
fs.mkdirSync(root,{recursive:true})
const output=path.join(root,'windows.cjs')
await build({entryPoints:['apps/desktop/main/windows.ts'],outfile:output,bundle:true,platform:'node',format:'cjs',
 plugins:[{name:'synthetic-screen',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'synthetic-screen'}));
  b.onLoad({filter:/.*/,namespace:'synthetic-screen'},()=>({loader:'js',contents:`module.exports={screen:{
   dipToScreenRect:(_owner,r)=>r,screenToDipRect:(_owner,r)=>r,
   getDisplayMatching:r=>r.x<0?{id:2,workArea:{x:-1280,y:0,width:1280,height:720}}:{id:1,workArea:{x:0,y:0,width:1280,height:720}}
  }}`}))}}]})
const {configureWindow}=createRequire(import.meta.url)(output)
function window(){
 const events=new Map();let handler
 return {bounds:[],on(){},isVisible:()=>false,isMinimized:()=>false,
  setContentBounds(r){this.bounds.push({...r})},getContentBounds(){return this.bounds.at(-1)||{x:20,y:40,width:900,height:600}},
  webContents:{getURL:()=> 'http://127.0.0.1:1234/',getZoomFactor:()=>1,setBackgroundThrottling(){},
   on(e,f){events.set(e,[...(events.get(e)||[]),f])},setWindowOpenHandler(f){handler=f}},
  open(details){return handler(details)},created(child,name){for(const f of events.get('did-create-window')||[])f(child,{frameName:name,options:{}})}
 }
}
function place(rect,clamp){
 const parent=window(),child=window();configureWindow(parent,'http://127.0.0.1:1234',true)
 const {x,y,width,height}=rect
 const features=`popup,orgtreeExactRect=1,left=${x},top=${y},width=${width},height=${height}`+(clamp?',orgtreeClampDisplay=1':'')
 assert.equal(parent.open({url:'about:blank',frameName:'tab-origin',features}).action,'allow')
 parent.created(child,'tab-origin');return child.bounds[0]
}
test('inline exact popup clamps its first placement to the matching work area',()=>{
 assert.deepEqual(place({x:1100,y:650,width:500,height:300},true),{x:780,y:420,width:500,height:300})
})
test('inline exact popup fits an oversized source on a negative-coordinate display',()=>{
 assert.deepEqual(place({x:-1700,y:-100,width:1900,height:1000},true),{x:-1280,y:0,width:1280,height:720})
})
test('an exact source that already fits stays exact',()=>{
 assert.deepEqual(place({x:80,y:60,width:400,height:300},true),{x:80,y:60,width:400,height:300})
})
test('existing exact pop-outs without a tab clamp request keep their existing bounds',()=>{
 const rect={x:1100,y:650,width:500,height:300};assert.deepEqual(place(rect,false),rect)
})
