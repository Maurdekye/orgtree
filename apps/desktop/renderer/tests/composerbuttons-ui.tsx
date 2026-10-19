import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {ComposerButtonsFixture,seedComposer} from './composerbuttons-fixture'
import '../src/styles.css'
import '../src/shell.css'
seedComposer()
globalThis.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('/chat')?{
  messages:[],live:[],pending_mail:[],busy:String(url).includes('busy'),responding:String(url).includes('busy'),
  windowed:true,has_older:false,before:null,draft_epoch:'synthetic:0',
}:{}),{headers:{'Content-Type':'application/json'}})
document.documentElement.dataset.theme='dark'
function Fixture(){
 const [effort,setEffort]=useState('xhigh')
 ;(window as unknown as {setComposerEffort:(level:string)=>void}).setComposerEffort=setEffort
 return <main style={{padding:18,display:'flex',flexDirection:'row',gap:12}}>
  {[['idle',false,false],['queued effort / interrupt',true,false],['project broadcast',false,true]].map(([name,busy,project])=>
    <section data-buttons={String(name)} key={String(name)} style={{height:640,minWidth:0,flex:1}}>
      <h4 style={{margin:'0 0 4px'}}>{String(name)}</h4>
      <div className="desk-body" style={{height:600,display:'flex',flexDirection:'column'}}>
        <ComposerButtonsFixture busy={!!busy} project={!!project} effort={effort}/>
      </div>
    </section>)}
</main>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
