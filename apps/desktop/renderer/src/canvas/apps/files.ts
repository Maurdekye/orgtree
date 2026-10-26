import {customAppsFiles} from '../../api'
import type {AppActionClient,AppPermissionRequest,PermissionChoice} from './actions'

export interface FileDecision {choice:PermissionChoice;path?:string}
export interface FilePrompt {request:AppPermissionRequest;session:string;finish:(decision:FileDecision|null)=>void}
type Ask=(request:AppPermissionRequest,session:string,signal:AbortSignal)=>Promise<FileDecision|null>
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const fields:Record<string,readonly string[]>={choose:[],open:['root','path'],read:['file','offset','limit'],media:['file'],grant:['scope','mode'],roots:[],list:['directory','root','after','limit'],child:['directory','path'],write:['directory','name','base64','replace'],delete:['file']}

/** Parent realm only: the iframe cannot browse paths, select a grant, decide
 * permission, supply a session, or choose the playback endpoint. */
export class AppFileClient {
  constructor(private slug:string,private app:string,private panel:string,private host:AppActionClient,private ask:Ask){}
  async call(input:unknown):Promise<unknown>{
    if(!object(input)||typeof input.action!=='string'||!Object.hasOwn(fields,input.action)||Object.keys(input).some(k=>k!=='action'&&!fields[input.action as string].includes(k)))throw Error('Unsupported app file request or identity fields.')
    if(new TextEncoder().encode(JSON.stringify(input)).length>128*1024-1024)throw Error('App file request is too large.')
    const session=await this.host.hostSession()
    let result=await customAppsFiles<Record<string,unknown>>(this.slug,{action:'call',session,request:input})
    if(this.host.signal.aborted)throw Error('App host closed or hidden.')
    const confirmation=Object.hasOwn(result,'confirmation_required')
    if(Object.hasOwn(result,'permission_required')||confirmation){
      const pending=(confirmation?result.confirmation_required:result.permission_required) as AppPermissionRequest
      const cap=input.action==='write'||input.action==='delete'||input.action==='grant'&&input.mode==='write'?'files.write':'files.read'
      if(!object(pending)||pending.app!==this.app||pending.panel!==this.panel||pending.capability!==cap||typeof pending.challenge!=='string'||!pending.challenge||!object(pending.request)||pending.request.action!==input.action)throw Error('App file permission does not match its host.')
      const decision=await this.ask(pending,session,this.host.signal)
      if(this.host.signal.aborted)throw Error('App host closed or hidden.')
      if(decision===null){this.host.cancelSession();throw Error('App file request cancelled.')}
      result=await customAppsFiles<Record<string,unknown>>(this.slug,confirmation?{action:'confirm',app:this.app,session,challenge:pending.challenge,allow:decision.choice!=='deny'}:{action:'decide',session,challenge:pending.challenge,choice:decision.choice,...(decision.path===undefined?{}:{path:decision.path})})
    }
    if(this.host.signal.aborted)throw Error('App host closed or hidden.')
    if(input.action==='media'){
      const path=result.media_path,endpoint='/api/orgs/'+encodeURIComponent(this.slug)+'/apps/media'
      if(typeof path!=='string'||!path.startsWith(endpoint+'?ticket=')||!/^[a-f0-9]{64}$/.test(path.slice(endpoint.length+8)))throw Error('Invalid app media reference.')
      const {media_path:_,...info}=result
      return {...info,url:new URL(path,window.location.href).href}
    }
    return result
  }
}

export interface FileGrants {app:string;rev:number;permission_rev:number;permission:string;grants:{id:string;scope:'orgtree'|'file'|'folder'|'computer';mode:'read'|'write';name:string;path?:string}[];write:string}
export interface FileBrowse {path:string;parent:string|null;items:{name:string;path:string;directory:boolean}[];next_cursor:string|null;scan_limited?:boolean}
