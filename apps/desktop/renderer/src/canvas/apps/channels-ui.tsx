import {KeyIcon,LockIcon,LockOpenIcon} from '../../icons'
import {fmtFull} from '../../timefmt'

/** One live channel an app holds (spec section 5), as the panel's status bar shows it (section 6). The host learns it
 * from the engine's own results: net.connect answers the site, scheme and network kind, and each net.recv carries the
 * state changes and a message count. Nothing here holds a message, a path or a login. */
export interface ChannelInfo {channel:string;site:string;state:'connecting'|'open'|'down'|'closed';secure:boolean;private:boolean;login:boolean;since:number|null;messages:number}

interface ChannelEvent {type:'state'|'message';state?:string;login?:boolean}
/** Fold one net.recv answer into the channel's chip: the last state wins, each message counts. */
export function foldChannel(info:ChannelInfo,events:ChannelEvent[],now=Date.now()):ChannelInfo{
  let next={...info}
  for(const e of events){
    if(e.type==='message')next.messages+=1
    else if(e.type==='state'&&(e.state==='connecting'||e.state==='open'||e.state==='down'||e.state==='closed')){
      next={...next,state:e.state,login:e.login??next.login,since:e.state==='open'?now:next.since}
    }
  }
  return next
}

const dots:Record<ChannelInfo['state'],string>={open:'var(--ok)',connecting:'var(--warn)',down:'var(--warn)',closed:'var(--dim)'}
const title=(c:ChannelInfo)=>{
  const where=c.state==='open'?`Connected to ${c.site}${c.since?` since ${fmtFull(new Date(c.since).toISOString())}`:''}`:c.state==='connecting'?`Connecting to ${c.site}`:c.state==='down'?`Reconnecting to ${c.site}`:`Closed: ${c.site}`
  return `${where}, ${c.messages.toLocaleString('en-US')} message${c.messages===1?'':'s'}`
}
/** One chip per open channel (or one a recent private fetch used): a dot (green open, amber connecting or down, grey
 * closed), the site, "private network" or "internet", a lock for wss or an open lock for ws, and a key when a saved
 * login is attached. Hover shows when it connected and how many messages it carried. */
export function ChannelChips({channels}:{channels:ChannelInfo[]}){
  return <>{channels.map(c=><span key={c.channel} className="custom-app-channel" title={title(c)}>
    <span className="dot" data-state={c.state} style={{width:8,height:8,borderRadius:'50%',display:'inline-block',background:dots[c.state]}}/>
    <span>{c.site}</span><span className="dim">{c.private?'private network':'internet'}</span>
    {c.secure?<span data-icon="lock" aria-label="Encrypted"><LockIcon fontSize="inherit"/></span>:<span data-icon="open-lock" aria-label="Not encrypted"><LockOpenIcon fontSize="inherit"/></span>}
    {c.login&&<span data-icon="key" aria-label="Saved login attached"><KeyIcon fontSize="inherit"/></span>}
  </span>)}</>
}
