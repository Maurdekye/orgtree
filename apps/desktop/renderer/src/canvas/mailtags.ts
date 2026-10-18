/** Hue depends on the same normalized key used by the engine dictionary. */
export const mailTagKey = (tag:string):string => tag.trim().toLowerCase()
/** The picker, filter chips and mail chips all toggle the same normalized key. */
export function toggleMailTag(selected:readonly string[],tag:string):string[] {
  const key=mailTagKey(tag)
  return selected.some(t=>mailTagKey(t)===key)?selected.filter(t=>mailTagKey(t)!==key):[...selected,tag]
}
export function mailTagHue(tag:string):string {
  let hash=2166136261
  for(const ch of mailTagKey(tag)) {
    hash^=ch.codePointAt(0)!
    hash=Math.imul(hash,16777619)>>>0
  }
  return (hash/4294967296*360).toFixed(6)
}

/** All selected keys must be present; an empty selection includes untagged mail. */
export function mailMatchesTags(tags:readonly string[]|undefined,selected:readonly string[]):boolean {
  const present=new Set(tags?.map(mailTagKey))
  return selected.every(t=>present.has(mailTagKey(t)))
}
