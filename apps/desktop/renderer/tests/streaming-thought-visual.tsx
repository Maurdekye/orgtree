import {createRoot} from 'react-dom/client'
import type {ComponentType} from 'react'
import * as desk from '../src/canvas/desk'
import '../src/styles.css'

// The visual runner exposes these existing private components only in its
// in-memory test bundle. Product exports and the production DOM stay unchanged.
const {ThoughtBody,ThoughtLine}=desk as unknown as {
  ThoughtBody:ComponentType<{text:string;live?:boolean}>
  ThoughtLine:ComponentType<{text?:string;secs?:number;sealed?:boolean;foldKey?:string}>
}
const query=new URLSearchParams(location.search)
const kind=query.get('kind')??'live'
const pressure=query.get('pressure')??'crowded'
const size=query.get('size')??'short'
const text=size==='long'?Array.from({length:45},(_,i)=>`Reasoning line ${i+1}: inspect the current layout.`).join('\n')
  :size==='multi'?'Check the transcript height.\nKeep each line readable.\nPreserve the existing thought styling.'
    :'Inspect the streaming thought without clipping its text.'
const history=Array.from({length:8},(_,i)=><div className="msg assistant" key={i}>
  Previous response {i+1}.{'\n'}The transcript already contains several readable lines.{'\n'}It scrolls when full.
</div>)
createRoot(document.getElementById('root')!).render(<main style={{padding:24,width:940}}>
  <h2>Streaming thought height</h2>
  <div className="dim">{kind} / {pressure} / {size}</div>
  <div style={{height:pressure==='crowded'?180:480,marginTop:16}}>
    <div className="msgs" data-fixture="transcript">
      {pressure==='crowded'&&history}
      <div className="reply-event" data-fixture="target">
        {kind==='live'?<ThoughtBody text={text} live/>
          :kind==='sealed'?<div className="msg live thinking sealed">thinking… for 3s</div>
            :<div className="msg assistant live"><ThoughtLine text={text} secs={3}/></div>}
      </div>
    </div>
  </div>
</main>)
