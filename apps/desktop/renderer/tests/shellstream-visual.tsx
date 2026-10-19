import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ToolChip } from '../src/canvas/desk'
import { RunningTurnContext, TurnActiveContext } from '../src/canvas/toolclock'
import { ShellOutputContext } from '../src/shelloutput'
const stamp=new Date(Date.now()-12000).toISOString()
window.fetch=(()=>Promise.reject(Error('Synthetic capture forbids network reads'))) as typeof fetch
function Fixture(){
 const [step,setStep]=useState(1)
 Object.assign(window,{shellStreamStep:(n:number)=>setStep(n)})
 const text=step===1?'Preparing workspace…\n':'Preparing workspace…\nChecking source files…\nValidated 42 files\nWaiting for compiler…\n'
 return <main style={{margin:'48px auto',width:850}}><h2>Build progress</h2>
  <p className="dim">Two commands are running. Expanded rows show their latest output.</p>
  <TurnActiveContext.Provider value={true}><RunningTurnContext.Provider value={stamp}>
  <ShellOutputContext.Provider value={{turn_started_at:stamp,revision:step,tools:[{id:'codex',text,truncated:false},{id:'muse',text:step===1?'Starting checks\n':'Starting checks\nNative controls: 8 passed\nRenderer checks: running\n',truncated:true},{id:'closed',text:'COLLAPSED_BYTES',truncated:false}]}}>
   <div style={{marginBottom:24}}><ToolChip slug="synthetic" nid="author" t={{id:'codex',name:'exec_command',arg:'pwsh -NoProfile -File ./check.ps1',started_at:stamp,retained_input:{command:'pwsh -NoProfile -File ./check.ps1'}}}/></div>
   <div style={{marginBottom:24}}><ToolChip slug="synthetic" nid="author" t={{id:'muse',name:'powershell',arg:'node ./verify.mjs',started_at:stamp,retained_input:{command:'node ./verify.mjs'}}}/></div>
   <ToolChip slug="synthetic" nid="author" t={{id:'closed',name:'Bash',arg:'cargo check -j1',started_at:stamp,retained_input:{command:'cargo check -j1'}}}/>
  </ShellOutputContext.Provider></RunningTurnContext.Provider></TurnActiveContext.Provider></main>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
