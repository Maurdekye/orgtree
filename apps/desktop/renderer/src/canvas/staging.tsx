import { useEffect, useRef, useState } from 'react'
import type { UploadOptions, UploadProgress } from '../api'
import { fmtBytes } from './img'

interface Pending { id: number; file: File; stop: AbortController; progress: UploadProgress; error?: string; cancelled?: boolean }
/** Keep a chosen file in the draft until it completes or the user removes it. */
export function useStaging<T>(upload: (file: File, options: UploadOptions) => Promise<T>, complete: (file: File, result: T) => void) {
  const pending=useRef(new Map<number,Pending>())
  const seq=useRef(0), live=useRef(true)
  const [rows,setRows]=useState<Pending[]>([])
  const refresh=()=>{ if(live.current) setRows([...pending.current.values()]) }
  useEffect(()=>{ live.current=true; return()=>{ live.current=false; for(const p of pending.current.values()) p.stop.abort() } },[])
  const run=(p:Pending)=>{
    const stop=p.stop
    void upload(p.file,{signal:stop.signal,progress:value=>{
      if(pending.current.get(p.id)?.stop!==stop) return
      p.progress=value; refresh()
    }}).then(result=>{
      if(!live.current || pending.current.get(p.id)?.stop!==stop || stop.signal.aborted) return
      complete(p.file,result); pending.current.delete(p.id); refresh()
    }).catch(err=>{
      if(!live.current || pending.current.get(p.id)?.stop!==stop) return
      p.error=stop.signal.aborted?'Cancelled; remove this file or retry before sending':err instanceof Error?err.message:String(err)
      p.cancelled=stop.signal.aborted; refresh()
    })
  }
  return {
    rows, blocked:()=>pending.current.size>0,
    add:(file:File)=>{
      const p:Pending={id:++seq.current,file,stop:new AbortController(),progress:{sent:0,total:file.size,phase:'preparing'}}
      pending.current.set(p.id,p); refresh(); run(p)
    },
    cancel:(id:number)=>{ pending.current.get(id)?.stop.abort() },
    remove:(id:number)=>{ pending.current.get(id)?.stop.abort(); pending.current.delete(id); refresh() },
    retry:(id:number)=>{
      const p=pending.current.get(id); if(!p?.error) return
      p.stop=new AbortController(); p.error=undefined; p.cancelled=false; p.progress={sent:0,total:p.file.size,phase:'preparing'}
      refresh(); run(p)
    },
  }
}

export function StagingRows({staging}:{staging:ReturnType<typeof useStaging>}) {
  if(!staging.rows.length) return null
  return <div className="local-staging" aria-label="Files being attached">
    {staging.rows.map(p=><div className="transfer-file" key={p.id} data-stage-state={p.error?(p.cancelled?'cancelled':'failed'):p.progress.phase}>
      <strong>{p.file.name}</strong>
      <progress max={p.progress.total||1} value={p.progress.sent} aria-label={`${p.file.name} local upload bytes`} />
      <small>{p.error || (p.progress.phase==='preparing'?'Preparing local upload':p.progress.phase==='confirming'?'Saving on this computer…':`${fmtBytes(p.progress.sent)} of ${fmtBytes(p.progress.total)} uploaded to this computer`)}</small>
      <div className="transfer-actions">
        {p.error?<button onClick={()=>staging.retry(p.id)}>Retry file</button>:<button onClick={()=>staging.cancel(p.id)}>Cancel upload</button>}
        <button onClick={()=>staging.remove(p.id)}>Remove file</button>
      </div>
    </div>)}
    <small>Send waits for these files. Retry or remove any failed file.</small>
  </div>
}
