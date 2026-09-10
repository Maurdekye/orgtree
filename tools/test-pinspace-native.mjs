import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-pinspace-'))
await build({stdin:{contents:`
import React,{useState,useLayoutEffect,useRef} from 'react';import{createRoot}from'react-dom/client';
import{PinFrame,pinModal}from'./apps/desktop/renderer/src/canvas/modalpin';
import{createPortal}from'react-dom';
import{CurrentOrg}from'./apps/desktop/renderer/src/popout';
import{pinLayerFor,adoptPinLayer,usePinSurface,raisePinSurface}from'./apps/desktop/renderer/src/canvas/pinspace';
import'./apps/desktop/renderer/src/styles.css';
localStorage.clear();
pinModal('docket',{x:0,y:0,w:500,h:400},'fixture');pinModal('gallery',{x:0,y:0,w:500,h:400},'fixture');
function Peer({i=0}){const p=usePinSurface('fixture','worker'+i,{x:0,y:0,w:500,h:400},false);return <div className='pinwin' id={'peer-'+i} style={{left:0,top:0,width:500,height:400,zIndex:p.z}} onPointerDown={()=>raisePinSurface(p.key)}>Desk peer</div>}
function Fixture(){const[open,setOpen]=useState(true);const[count,setCount]=useState(1);window.setCount=setCount;const vp=useRef(null);useLayoutEffect(()=>adoptPinLayer('fixture',vp.current),[]);window.togglePin=()=>setOpen(v=>!v);return <CurrentOrg.Provider value='fixture'>
<div ref={vp} className='viewport' data-pin-org='fixture' style={{position:'absolute',left:30,top:90,right:30,bottom:30}}>{createPortal(Array.from({length:count},(_,i)=><Peer key={i} i={i}/>),pinLayerFor('fixture'))}<div className='zoomhud' id='hud' style={{position:'absolute',left:12,top:12,right:'auto',bottom:'auto'}}><button id='hud-button'>Zoom</button></div></div>
<PinFrame kind='docket' title='Work' panel='settings fixture-docket' close={()=>{}}><textarea defaultValue='Unsent draft'/></PinFrame>
{open&&<PinFrame kind='gallery' title='Presented' panel='settings fixture-gallery' close={()=>setOpen(false)}>Presented documents</PinFrame>}
</CurrentOrg.Provider>};createRoot(document.getElementById('root')).render(<Fixture/>);
`,loader:'tsx',resolveDir:process.cwd()},outfile:path.join(root,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic'})
await build({entryPoints:['tests/pinspace-native.probe.ts'],outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const env={...process.env,ORGTREE_PINSPACE_ROOT:root,ORGTREE_DATA:path.join(root,'data'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home')};delete env.ELECTRON_RUN_AS_NODE
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'probe.cjs')],{env,windowsHide:true,stdio:'inherit'})
child.on('error',e=>{console.error(e);process.exitCode=1});child.on('exit',code=>process.exitCode=code??1)
