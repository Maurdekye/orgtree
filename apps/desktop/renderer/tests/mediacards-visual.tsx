import { createRoot } from 'react-dom/client'
import { SentFileCard } from '../src/canvas/filecard'
import { AgentFilesView } from '../src/canvas/files'
import { SegmentAttachments } from '../src/events/segments'
import '../src/styles.css'
import '../src/shell.css'

// the Files tab's list (USER 2026-11-10): an image, a zip chat does not embed, a video and an audio file, each under its row
const delivered=[['tone.wav','Synthetic tone.wav',96044],['clip.webm','Synthetic clip.webm',2048],['notes.zip','Notes.zip',4096],['image.png','Synthetic image.png',1024]]
const realFetch=window.fetch.bind(window)
window.fetch=((url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/agents/agent/files')
  ? Promise.resolve(new Response(JSON.stringify({node:'agent',next_cursor:null,files:delivered.map(([path,name,bytes],i)=>({delivery_id:'d'+i,name,path,bytes,note:null,at:'2026-11-10T12:0'+i+':00Z'}))}),{headers:{'Content-Type':'application/json'}}))
  : realFetch(url,init)) as typeof fetch
createRoot(document.getElementById('root')!).render(<main style={{padding:24,width:970,boxSizing:'border-box'}}>
  <h2>In-chat media</h2><p className="dim">Synthetic files · native controls · local playback</p>
  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
    <section><h3>Agent delivery</h3><SentFileCard slug="synthetic" nid="agent" file={{name:'Synthetic clip.webm',path:'clip.webm',bytes:2048,note:'A short generated video'}} />
      <SentFileCard slug="synthetic" nid="agent" file={{name:'Synthetic tone.wav',path:'tone.wav',bytes:96044}} />
      <SentFileCard slug="synthetic" nid="agent" file={{name:'Large video.mp4',path:'large.mp4',bytes:268435457}} /></section>
    <section><h3>Message attachments</h3><p>Files stay in this conversation.</p><SegmentAttachments slug="synthetic" nid="agent" values={[{name:'Synthetic image.png',path:'image.png',bytes:1024},{name:'Synthetic tone.wav',path:'tone.wav',bytes:96044}]} /></section>
  </div>
  <h3>Files tab</h3><div style={{height:560,display:'flex'}}><AgentFilesView slug="synthetic" nid="agent" /></div>
</main>)
;(window as unknown as {mediaReady:boolean}).mediaReady = true
