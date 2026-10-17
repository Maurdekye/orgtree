import { mailTagKey } from './mailtags'

export interface MailTagPickerProps {
  selected:string[]
  choices:string[]
  onChange:(tags:string[])=>void
  onSearch?:(text:string)=>void
  onLoadMore?:()=>void
  hasMore?:boolean
  loading?:boolean
  error?:string|null
  onRetry?:()=>void
}

/** Baseline extraction: preserves the existing typed single-tag control. */
export function MailTagPicker({selected,choices,onChange}:MailTagPickerProps) {
  const value=selected[0]??''
  return <div className="mail-tag-picker">
    <input aria-label="Filter mail by tag" className="mail-tag-filter" list="user-mail-tag-choices"
      placeholder="all tags" value={value} onChange={e=>onChange(e.target.value?[e.target.value]:[])} />
    <datalist id="user-mail-tag-choices">{choices.map(t=><option key={mailTagKey(t)} value={t}/>)}</datalist>
    {value && <button type="button" aria-label="Clear tag filter" onClick={()=>onChange([])}>clear</button>}
  </div>
}
