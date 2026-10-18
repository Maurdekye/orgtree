import React, { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { projectMenuEntries, type AgentMenuHandlers } from '../src/canvas/agentmenu'
import { useContextMenu } from '../src/canvas/contextmenu'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'

function Fixture() {
  const menu = useContextMenu()
  const anchor = useRef<HTMLButtonElement>(null)
  const project = { id:'alpha',kind:'project',state:'live',children:[],documents:[],audiences_held:[],audiences_explicit:[] } as unknown as CanvasNode
  const h = {onSettings:()=>{},onInbox:()=>{},onOpenDesk:()=>{},onToggleUserAudience:()=>{}} as unknown as AgentMenuHandlers
  useEffect(() => { anchor.current?.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:170,clientY:120})) }, [])
  return <div style={{padding:40}}>
    <h2>Project alpha</h2>
    <button ref={anchor} onContextMenu={(e) => menu.open(e, projectMenuEntries(project,h))}>alpha</button>
    {menu.node}
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
