import {customAppsBridge} from '../../api'

export type PermissionChoice = 'once'|'always'|'deny'
export interface AppPermissionRequest {
  challenge:string; app:string; panel:string; name:string; label:string
  capability:string; request:Record<string,unknown>
  detail?:{path:string;operation:string;previous_bytes:number|null;bytes:number|null;sha256:string|null}
}
type Ask = (request:AppPermissionRequest,signal:AbortSignal)=>Promise<PermissionChoice|null>
const fields:Record<string,readonly string[]>={
  'org.read':['after','limit'], 'mail.send':['to','body','notice'],
  'docket.create':['title','objective','owner'], 'events.fire':['name','payload'],
}
const capability=(action:string)=>action==='docket.create'?'docket.write':action
/** A hidden panel keeps running but never opens a native prompt (user 2026-10-26). */
export const HIDDEN_PROMPT='interaction_required: this panel is hidden; show it to answer its permission prompt'
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)

/** Parent realm only. Neither the session nor native decision is part of the
 * iframe SDK. Engine independently binds and validates every action again. */
export class AppActionClient {
  private active=true
  private session:string|null=null
  private until=0
  private stop=new AbortController()
  constructor(private slug:string,private app:string,private rev:number,private panel:string,private ask:Ask,private generation?:number){}
  private check(){if(!this.active)throw Error('App host closed or hidden.')}
  private closeSession(){
    const session=this.session;this.session=null;this.until=0
    if(session)void customAppsBridge(this.slug,{action:'session_close',session}).catch(()=>{})
  }
  dispose(){this.active=false;this.stop.abort();this.closeSession()}
  cancelSession(){this.closeSession()}
  get signal(){return this.stop.signal}
  /** Used only by the trusted file client sharing this host's lifetime. */
  async hostSession():Promise<string>{
    this.check()
    if(this.until<=Date.now()+5000){
      this.closeSession()
      const opened=await customAppsBridge<{session:string;app:string;app_rev:number;run_generation?:number;expires_in:number}>(this.slug,{action:'session_open',panel:this.panel,...(this.generation?{generation:this.generation}:{})})
      if(typeof opened.session!=='string')throw Error('Invalid app host session.')
      if(!this.active||opened.app!==this.app||opened.app_rev!==this.rev||(this.generation!==undefined&&opened.run_generation!==undefined&&opened.run_generation!==this.generation)){
        void customAppsBridge(this.slug,{action:'session_close',session:opened.session}).catch(()=>{})
        throw Error('App changed or host closed; reopen its panel.')
      }
      this.session=opened.session;this.until=Date.now()+Math.min(1800,opened.expires_in)*1000
    }
    this.check();return this.session!
  }
  async call(input:unknown):Promise<unknown>{
    this.check()
    if(!object(input)||Object.keys(input).some(k=>!['action','args'].includes(k))||typeof input.action!=='string'||!Object.hasOwn(fields,input.action))throw Error('Unsupported app action or identity fields.')
    const args=input.args??{}
    if(!object(args)||Object.keys(args).some(k=>!fields[input.action as string].includes(k)))throw Error('Unsupported app action arguments or identity fields.')
    const request={...args,action:input.action}
    if(new TextEncoder().encode(JSON.stringify(request)).length>64*1024)throw Error('App action exceeds 64 KiB.')
    // Renew BEFORE sending an action. Never retry a possibly executed action.
    const session=await this.hostSession()
    const result=await customAppsBridge<Record<string,unknown>>(this.slug,{action:'call',session,request})
    this.check()
    if(!Object.hasOwn(result,'permission_required'))return result
    const pending=result.permission_required as AppPermissionRequest
    if(!object(pending)||pending.app!==this.app||pending.panel!==this.panel||pending.capability!==capability(input.action)||typeof pending.challenge!=='string'||!pending.challenge||!object(pending.request)||pending.request.action!==input.action)throw Error('App permission request does not match its host.')
    // A refused prompt (hidden panel) still discards the engine's challenge.
    let choice:PermissionChoice|null
    try{choice=await this.ask(pending,this.stop.signal)}catch(e){this.closeSession();throw e}
    this.check()
    if(choice===null){this.closeSession();throw Error('App action cancelled.')}
    // Only the challenge travels: the engine retained the exact original action.
    return customAppsBridge(this.slug,{action:'decide',session,challenge:pending.challenge,choice})
  }
}
