import { useEffect, useRef, useState } from 'react'
import { savedLocalFiles, dismissLocalFile, cancelLocalFile, type StagingTicket, type UploadOptions, type UploadProgress } from '../api'
import { fmtBytes } from './img'

interface Pending { id: number; file: File; stop: AbortController; progress: UploadProgress; error?: string; cancelled?: boolean }
/** Keep a chosen file in the draft until it completes or the user removes it. */
export function useStaging<T>(upload: (file: File, options: UploadOptions) => Promise<T>, complete: (file: File, result: T) => void) {
  const pending=useRef(new Map<number,Pending>())
  const seq=useRef(0), live=useRef(true)
  const draft=useRef(crypto.randomUUID())
  const [rows,setRows]=useState<Pending[]>([])
  const refresh=()=>{ if(live.current) setRows([...pending.current.values()]) }
  useEffect(()=>{ live.current=true; return()=>{ live.current=false; for(const p of pending.current.values()) p.stop.abort() } },[])
  const run=(p:Pending)=>{
    const stop=p.stop
    void upload(p.file,{draft:draft.current,signal:stop.signal,progress:value=>{
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

/** Recovery is explicit: a saved file never jumps into a different draft. */
export function SavedLocalFiles({slug,attached,onAttach,disabled=false}:{slug:string;attached:string[];onAttach:(file:StagingTicket)=>void;disabled?:boolean}) {
  const [open,setOpen]=useState(false),[files,setFiles]=useState<StagingTicket[]>([])
  const [next,setNext]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const live=useRef(true)
  useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
  const load=async(after='')=>{
    setBusy(true);setError('')
    try {
      const result=await savedLocalFiles(slug,after)
      if(live.current) {setFiles(old=>after?[...old,...result.files]:result.files);setNext(result.next)}
    } catch(e) {if(live.current) setError(e instanceof Error?e.message:String(e))}
    finally {if(live.current) setBusy(false)}
  }
  const change=async(file:StagingTicket)=>{
    setBusy(true);setError('')
    try {
      if(file.state==='queued'||file.state==='uploading') await cancelLocalFile(slug,file.id)
      else await dismissLocalFile(slug,file.id)
      await load()
    } catch(e) {if(live.current) {setError(e instanceof Error?e.message:String(e));setBusy(false)}}
  }
  return <div className="saved-local-files">
    <button disabled={disabled} onClick={()=>{setOpen(!open);if(!open) void load()}} aria-expanded={open}>Saved local files</button>
    {open && <div className="local-staging">
      <small>Files kept on this computer from earlier drafts. Attach a finished file, or select the original file again for an interrupted upload. Message text is not saved here.</small>
      {files.filter(f=>!attached.includes(f.id)).map(f=><div className="transfer-file" key={f.id} data-saved-file={f.id}>
        <strong>{f.name}</strong><small>{f.state==='complete'?`${fmtBytes(f.bytes)} ? ready to attach`:f.error||'Local upload is still pending'}</small>
        <div className="transfer-actions">
          {f.state==='complete'&&<button disabled={busy||disabled} onClick={()=>onAttach(f)}>Attach saved file</button>}
          <button disabled={busy||disabled} onClick={()=>void change(f)}>{f.state==='queued'||f.state==='uploading'?'Cancel upload':'Dismiss saved entry'}</button>
        </div>
      </div>)}
      {!files.length&&!busy&&<small>No saved local files.</small>}
      {error&&<small role="alert">{error}</small>}
      <button disabled={busy} onClick={()=>void load()}>Refresh saved files</button>
      {next&&<button disabled={busy} onClick={()=>void load(next)}>More saved files</button>}
    </div>}
  </div>
}
