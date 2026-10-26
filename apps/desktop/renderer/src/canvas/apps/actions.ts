import {customAppsBridge} from '../../api'

export type PermissionChoice = 'once'|'always'|'deny'
export interface AppPermissionRequest {
  challenge:string; app:string; panel:string; name:string; label:string
  capability:string; request:Record<string,unknown>
}
type Ask = (request:AppPermissionRequest,signal:AbortSignal)=>Promise<PermissionChoice|null>
const fields:Record<string,readonly string[]>={
  'org.read':['after','limit'], 'mail.send':['to','body','notice'],
  'docket.create':['title','objective','owner'], 'events.fire':['name','payload'],
}
const capability=(action:string)=>action==='docket.create'?'docket.write':action
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)

/** Parent realm only. Neither the session nor native decision is part of the
 * iframe SDK. Engine independently binds and validates every action again. */
export class AppActionClient {
  private active=true
  private session:string|null=null
  private until=0
  private stop=new AbortController()
  constructor(private slug:string,private app:string,private rev:number,private panel:string,private ask:Ask){}
  private check(){if(!this.active)throw Error('App host closed or hidden.')}
  private closeSession(){
    const session=this.session;this.session=null;this.until=0
    if(session)void customAppsBridge(this.slug,{action:'session_close',session}).catch(()=>{})
  }
  dispose(){this.active=false;this.stop.abort();this.closeSession()}
  async call(input:unknown):Promise<unknown>{
    this.check()
    if(!object(input)||Object.keys(input).some(k=>!['action','args'].includes(k))||typeof input.action!=='string'||!Object.hasOwn(fields,input.action))throw Error('Unsupported app action or identity fields.')
    const args=input.args??{}
    if(!object(args)||Object.keys(args).some(k=>!fields[input.action as string].includes(k)))throw Error('Unsupported app action arguments or identity fields.')
    const request={...args,action:input.action}
    if(new TextEncoder().encode(JSON.stringify(request)).length>64*1024)throw Error('App action exceeds 64 KiB.')
    // Renew BEFORE sending an action. Never retry a possibly executed action.
    if(this.until<=Date.now()+5000){
      this.closeSession()
      const opened=await customAppsBridge<{session:string;app:string;app_rev:number;expires_in:number}>(this.slug,{action:'session_open',panel:this.panel})
      if(typeof opened.session!=='string')throw Error('Invalid app host session.')
      if(!this.active||opened.app!==this.app||opened.app_rev!==this.rev){
        void customAppsBridge(this.slug,{action:'session_close',session:opened.session}).catch(()=>{})
        throw Error('App changed or host closed; reopen its panel.')
      }
      this.session=opened.session;this.until=Date.now()+Math.min(1800,opened.expires_in)*1000
    }
    this.check()
    const session=this.session!
    const result=await customAppsBridge<Record<string,unknown>>(this.slug,{action:'call',session,request})
    this.check()
    if(!Object.hasOwn(result,'permission_required'))return result
    const pending=result.permission_required as AppPermissionRequest
    if(!object(pending)||pending.app!==this.app||pending.panel!==this.panel||pending.capability!==capability(input.action)||typeof pending.challenge!=='string'||!pending.challenge||!object(pending.request)||pending.request.action!==input.action)throw Error('App permission request does not match its host.')
    const choice=await this.ask(pending,this.stop.signal)
    this.check()
    if(choice===null){this.closeSession();throw Error('App action cancelled.')}
    // Only the challenge travels: the engine retained the exact original action.
    return customAppsBridge(this.slug,{action:'decide',session,challenge:pending.challenge,choice})
  }
}
