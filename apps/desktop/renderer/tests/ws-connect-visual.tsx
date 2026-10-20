import {createRoot} from 'react-dom/client'
import {WatchdogPanel} from '../src/canvas/modals'
import '../src/styles.css'
let saved=false
globalThis.fetch=(async(_url,init)=>{
 const body=JSON.parse(String(init?.body??'{}'));saved=!!body.notify_on_connect
 ;(window as any).lastConnectRequest=body
 return {ok:true,status:200,headers:new Headers(),json:async()=>({notify_on_connect:saved})} as Response
}) as typeof fetch
const dog={id:'synthetic/feed',owner:'synthetic',name:'Build event feed',kind:'websocket' as const,
 target:'wss://events.example.test/builds',pattern:'^build:',state:'armed' as const,interval_s:60,
 fired:0,once:false,spent:false,at:'2026-10-20T18:00:00Z',events:[],notify_on_connect:false,
 connection:{state:'connected' as const,since:'2026-10-20T18:00:00Z'}}
createRoot(document.getElementById('root')!).render(<WatchdogPanel slug="synthetic" dog={dog} toast={()=>{}} close={()=>{}}/>)
