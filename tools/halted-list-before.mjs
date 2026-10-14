// Reverse only this ticket's presentation hunks in current combined source.
const replace=(source,old,next)=>{if(!source.includes(old))throw Error('Missing halted-list control hunk: '+old.slice(0,70));return source.replace(old,next)};
export function beforeHaltedList(file,source){
  if(file.endsWith('/canvas/desk.tsx')){
    const tray=source.indexOf('export function TrayStatus(');
    const start=source.indexOf('  if (node.halt) {',tray);
    const end=source.indexOf('  if (isUsageFrozen(node)',start);
    if(tray<0||start<0||end<0)throw Error('Missing halted tray branch');
    return source.slice(0,start)+'  if (node.halt) return <HaltStatus halt={node.halt} />\n'+source.slice(end);
  }
  if(file.endsWith('/canvas/agenttray.tsx')){
    source=replace(source,"              <div className={'tray-sum' + (stat?._stale ? ' stale' : '')}\n                title={stat?.summary || undefined}>\n                {stat?.summary ? <>","            {stat?.summary && (\n              <div className={'tray-sum' + (stat._stale ? ' stale' : '')}\n                title={stat.summary}>");
    source=replace(source,'                </> : <span className="tray-sum-text" aria-hidden="true">&nbsp;</span>}\n              </div>','              </div>\n            )}');
    return source;
  }
  if(file.endsWith('/styles.css')){
    for(const hunk of ['.tray-halted { color: var(--bad); font-size: 13px; flex: none; }\n','.tray-status-label.halted { color: var(--bad); }\n','  min-height: 1.4em; line-height: 1.4;\n'])source=replace(source,hunk,'');
  }
  return source;
}
