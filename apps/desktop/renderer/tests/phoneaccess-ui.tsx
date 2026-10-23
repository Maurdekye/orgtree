import {createRoot} from 'react-dom/client'
import {PhonePanel} from '../src/canvas/phonelink'
import '../src/styles.css'
import '../src/shell.css'

const state={download_url:'https://example.invalid/Hubchat.apk',download_qr:null,link:null,
  org:{slug:'example',name:'Example org',address:'example.org',on_local_hub:true,persons:[],code:null},
  tailscale:{state:'T2',backend:'Running',account:'Example network',pc:'This PC',ipv4:'100.64.0.2'},
  access:{state:'A0',scope:'tailnet',port:7371},hub:{running:true,healthy:true},
  card:{show:false,dismissed:false,org:'example'},warnings:{},hubchat_pc:false}
globalThis.fetch=async()=>new Response(JSON.stringify(state),{status:200,headers:{'Content-Type':'application/json'}})
document.documentElement.dataset.theme='dark'
createRoot(document.getElementById('root')!).render(<PhonePanel org="example" onClose={()=>{}}/>)
