import { createRoot } from 'react-dom/client'
import { SentFileCard } from '../src/canvas/filecard'
import { MailReadPane } from '../src/canvas/mail'
import '../src/styles.css'
import '../src/shell.css'

createRoot(document.getElementById('root')!).render(<main style={{padding:24,width:970,boxSizing:'border-box'}}>
  <h2>In-chat media</h2><p className="dim">Synthetic files · native controls · local playback</p>
  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
    <section><h3>Agent delivery</h3><SentFileCard slug="synthetic" nid="agent" file={{name:'Synthetic clip.webm',path:'clip.webm',bytes:2048,note:'A short generated video'}} />
      <SentFileCard slug="synthetic" nid="agent" file={{name:'Synthetic tone.wav',path:'tone.wav',bytes:96044}} />
      <SentFileCard slug="synthetic" nid="agent" file={{name:'Large video.mp4',path:'large.mp4',bytes:268435457}} /></section>
    <section><h3>Message attachments</h3><MailReadPane cur={{id:'visual-mail',from:'agent',kind:'message',body:'Files stay in this conversation.',at:'2026-10-25T00:00:00Z',attachments:[{name:'Synthetic image.png',path:'image.png',bytes:1024},{name:'Synthetic tone.wav',path:'tone.wav',bytes:96044}]}}
      sender={() => 'Synthetic agent'} party="agent" members={[]} fileHref={path => '/api/orgs/synthetic/nodes/agent/file?path='+encodeURIComponent(path)} /></section>
  </div>
</main>)
;(window as unknown as {mediaReady:boolean}).mediaReady = true
