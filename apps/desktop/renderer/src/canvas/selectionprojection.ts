import { readReplySource } from '../api'
import { sourceDigest } from '../replySelection'
import type { SelectionSource } from './replyselection'

/** A clipped display can quote its exact visible prefix. Verify every shown
 * scalar against digest-bound canonical windows; never trust a clipped digest
 * as if it named the entire retained part. */
export async function verifySelectionProjection(source:SelectionSource, expected?:string) {
  const digest=source.partial ? expected : await sourceDigest(source.text)
  if(expected&&!source.partial&&digest!==expected)throw Error('Source changed')
  const first=await readReplySource(source.org,source.target,source.part,digest?{expected_sha256:digest}:{})
  if(!source.partial)return {...first,sha256:first.sha256??digest!}
  const chars=[...source.text];let matched=0,current=first
  while(matched<chars.length){
    const window=[...current.text],count=Math.min(window.length,chars.length-matched)
    if(!count||window.slice(0,count).join('')!==chars.slice(matched,matched+count).join(''))throw Error('Source changed: the displayed prefix no longer matches.')
    matched+=count
    if(matched<chars.length){
      if(current.next_offset===null)throw Error('Source changed: the displayed prefix was shortened.')
      current=await readReplySource(source.org,source.target,source.part,{offset:current.next_offset,expected_sha256:first.sha256})
    }
  }
  return first
}
