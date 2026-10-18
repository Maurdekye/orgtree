import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { ShellHeader } from '../src/shell/header'
import { OrgHeaderLogo } from '../src/shell/orgheaderlogo'
import { SettingsIcon } from '../src/icons'
import { applyTheme } from '../src/themes'

const image=document.createElement('canvas');image.width=image.height=32
const draw=image.getContext('2d')!;draw.fillStyle='#71d6ca';draw.fillRect(0,0,32,32)
draw.strokeStyle='#143c45';draw.lineWidth=3;draw.strokeRect(5,5,8,8);draw.strokeRect(19,19,8,8);draw.beginPath();draw.moveTo(9,13);draw.lineTo(9,23);draw.lineTo(19,23);draw.stroke()
const data=image.toDataURL('image/png').split(',')[1]
window.fetch=async()=>new Response(JSON.stringify({owner:1,picture:{revision:'r1',data}}),{headers:{'Content-Type':'application/json'}})
applyTheme('orgtree')
const menu=<button className="iconbtn" aria-label="Menu">☰</button>
const modes=<button>Canvas</button>
function Header({name='Orgtree',quick=false,logo=true}:{name?:string;quick?:boolean;logo?:boolean}) {
  return <ShellHeader menu={menu} title={name} orgSlug="synthetic" logoRevision={logo?'r1':null}
    modes={modes} quick={quick?<input placeholder="Quick chat" style={{width:240}}/>:undefined}/>
}
function SeparateSettings() {
  const frame=useRef<HTMLIFrameElement>(null),[owner,setOwner]=useState<Document|null>(null)
  useEffect(()=>{
    const doc=frame.current!.contentDocument!
    for(const sheet of document.querySelectorAll('link[rel=stylesheet]'))doc.head.appendChild(sheet.cloneNode(true))
    doc.body.style.cssText='margin:0;padding:12px;background:var(--bg);color:var(--ink)'
    setOwner(doc)
  },[])
  return <><iframe ref={frame} title="Separate organization settings" style={{width:620,height:90,border:'1px solid var(--line)'}}/>
    {owner&&createPortal(<div className="settings" style={{width:'100%',maxWidth:'none',padding:12,boxSizing:'border-box'}}>
      <h3><SettingsIcon fontSize="inherit" /> <OrgHeaderLogo slug="synthetic" revision="r1"/>Orgtree - Org settings</h3>
    </div>,owner.body)}</>
}
const style=document.createElement('style');style.textContent='body{display:block;margin:0;overflow:hidden}#root{padding:14px}h4{margin:12px 0 6px;font:12px system-ui;color:var(--dim)}.example{border:1px solid var(--line);width:930px}.example.narrow{width:430px}';document.head.append(style)
createRoot(document.getElementById('root')!).render(<>
  <h4>Canvas header · logo set</h4><div className="example"><Header/></div>
  <h4>Quick chat at top · same title and logo</h4><div className="example"><Header quick/></div>
  <h4>No logo · plain title, no reserved icon space</h4><div className="example"><Header logo={false}/></div>
  <h4>Narrow window · long name truncates beside the logo</h4><div className="example narrow"><Header name="A very long organization name that should truncate without changing header height"/></div>
  <h4>Organization settings header · separate document</h4><SeparateSettings/>
</>)
