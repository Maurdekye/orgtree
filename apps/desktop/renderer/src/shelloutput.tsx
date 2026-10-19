import { createContext, useContext } from 'react'
import { TurnActiveContext, RunningTurnContext, ofRunningTurn } from './canvas/toolclock'
import type { ToolChip } from './types'
export interface ShellOutputFrame { turn_started_at: string; revision: number; tools: { id: string; text: string; truncated: boolean; kind?: 'execute' }[] }
export const ShellOutputContext = createContext<ShellOutputFrame | null>(null)
export function acceptShellOutput(current: ShellOutputFrame | null | undefined, incoming: unknown, turn?: string | null): ShellOutputFrame | null {
 const old=current??null
 if(!incoming||typeof incoming!=='object')return old
 const f=incoming as ShellOutputFrame,at=Date.parse(f.turn_started_at),known=Date.parse(turn??''),previous=Date.parse(old?.turn_started_at??'')
 if(!Number.isFinite(at)||!Number.isSafeInteger(f.revision)||f.revision<0||!Array.isArray(f.tools)||f.tools.length>8)return old
 if(Number.isFinite(known)&&at<known||Number.isFinite(previous)&&at<previous)return old
 if(old&&at===previous&&f.revision<=old.revision)return old
 const ids=new Set<string>();let bytes=0
 for(const t of f.tools){
  if(!t||typeof t.id!=='string'||t.id.length>512||ids.has(t.id)||typeof t.text!=='string'||typeof t.truncated!=='boolean')return old
  const size=new TextEncoder().encode(t.text).length;if(size>32768)return old
  ids.add(t.id);bytes+=size
 }
 return bytes<=262144?f:old
}
export function LiveShellOutput({tool}:{tool:ToolChip}) {
 const frame=useContext(ShellOutputContext),active=useContext(TurnActiveContext),turn=useContext(RunningTurnContext)
 if(!active||!turn||frame?.turn_started_at!==turn||!ofRunningTurn(tool.started_at,turn)||tool.result!==undefined||tool.ended_at||tool.error||tool.writing_started_at)return null
 const output=frame.tools.find(t=>t.id===tool.id);if(!output?.text)return null
 if(!['bash','powershell','exec_command','run_command','run_shell_command','shell'].includes(tool.name.split('__').at(-1)?.toLowerCase()??'')&&output.kind!=='execute')return null
 return <div className="tool-live-output"><div className="dim">Output · running</div>
  {output.truncated&&<div className="dim">Earlier output omitted</div>}
  <pre className="filepre respre">{output.text}</pre></div>
}
