// tools/test-placeholder-scale.mjs — the notice that stands in for a desk which
// is open somewhere else must be the size of the desk it replaces.
//
// This is a SIZE question, so it is asked in a real browser with the real
// stylesheet and a real camera transform. Two REAL components render in the
// SAME frame on two identical cards: the popped-out desk's notice, and the
// pinned desk's placeholder, which has always done this correctly and is
// therefore the reference. Measuring both in one frame means the answer does
// not depend on this fixture's card shell being pixel-exact.
//
//   node tools/test-placeholder-scale.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-placeholder-'))
await build({
  stdin: {
    contents: `
import React,{useEffect} from 'react';import{createRoot}from'react-dom/client';
import{DeskHosts,DeskSlot,useDeskActionsNow}from'./apps/desktop/renderer/src/canvas/deskhosts';
import{PinnedPlaceholder}from'./apps/desktop/renderer/src/canvas/pins';
import{NODE_W,NODE_H}from'./apps/desktop/renderer/src/canvas/shared';
import'./apps/desktop/renderer/src/styles.css';
const ORG='org', Z=3.3;
localStorage.clear();
const NODE={id:'update-glow',generation:3,tier:'opus',charter:'x',state:'live',
  children:[],turns:[],seat:1,grant:0,free:0,tasks:0};
const MAP=new Map([[NODE.id,NODE]]);
const props={node:NODE,map:MAP,op:async()=>{},slug:ORG,toast:()=>{},pub:false,
  maxTop:1000,pxc:1,onMailLink:()=>{},onWorkLink:()=>{},onOpenDoc:()=>{},
  onLineage:()=>{},onConfig:()=>{},onJump:()=>{}};
// the host bridge a packaged window provides, absent in a plain browser
window.orgtreeDesktop={onEvent:()=>()=>{},
  getPopoutState:async(name)=>({name,present:true,maximized:false}),
  minimizePopout:async()=>{},toggleMaximizePopout:async()=>{},closePopout:async()=>{}};
const Card=({id,x,children})=><div className='sq tier-opus' id={id}
  style={{width:NODE_W,height:NODE_H,transform:'translate('+x+'px,0px)'}}>{children}</div>;
const PopoutTrigger=()=>{const deskNow=useDeskActionsNow(ORG);
  return <button aria-label='Open desk in a new window'
    onClick={()=>deskNow(NODE).requestPopout()}>↗</button>};
function Fixture(){
  useEffect(()=>{
    // the accumulated on-screen scale of an element: painted width over its own
    // untransformed layout width. Independent of this fixture's card shell.
    window.scaleOf=sel=>{const el=document.querySelector(sel); if(!el||!el.offsetWidth) return null;
      return +(el.getBoundingClientRect().width/el.offsetWidth).toFixed(4)};
    window.insideCard=(sel,card)=>{const a=document.querySelector(sel),b=document.querySelector(card);
      if(!a||!b) return null; const r=a.getBoundingClientRect(),c=b.getBoundingClientRect();
      return r.left>=c.left-1&&r.top>=c.top-1&&r.right<=c.right+1&&r.bottom<=c.bottom+1};
    window.count=sel=>document.querySelectorAll(sel).length;
    window.popOut=()=>{const b=document.querySelector('[aria-label="Open desk in a new window"]');
      if(!b) return false; b.click(); return true};
  });
  return <div className='viewport' style={{position:'absolute',inset:0,overflow:'hidden'}}>
    <div className='space' style={{position:'absolute',left:120,top:120,
      transform:'scale('+Z+')',transformOrigin:'0 0'}}>
      <DeskHosts map={MAP} slug={ORG}>
        <Card id='card' x={0}><DeskSlot {...props} /></Card>
        {/* the switchboard / pinned-window case: bare, never counter-scaled */}
        <Card id='bare' x={400}><DeskSlot {...props} bare /></Card>
        {/* the popout asked for from OUTSIDE the desk. This was the Agents
            List row's ↗ button until the user had those removed on
            2026-09-12; the action lives in the row's context menu now, so the
            fixture makes that entry's call and gives it a handle to click. */}
        <div style={{position:'absolute',left:0,top:-60}}>
          <PopoutTrigger /></div>
      </DeskHosts>
      <Card id='pinned' x={200}>
        <div className='pin-holder'><PinnedPlaceholder id={NODE.id} onShow={()=>{}} /></div>
      </Card>
    </div>
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
    loader: 'tsx', resolveDir: process.cwd(),
  },
  outfile: path.join(root, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife',
  jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
await build({ entryPoints: ['tests/placeholder-scale.probe.ts'], outfile: path.join(root, 'probe.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const env = { ...process.env, ORGTREE_PLACEHOLDER_ROOT: root, ORGTREE_DATA: path.join(root, 'data'),
  HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'probe.cjs')],
  { env, windowsHide: true, stdio: 'inherit' })
child.on('error', e => { console.error(e); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
