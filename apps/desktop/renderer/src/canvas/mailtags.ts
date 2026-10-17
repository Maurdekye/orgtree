/** Hue depends on the same normalized key used by the engine dictionary. */
export const mailTagKey = (tag:string):string => tag.trim().toLowerCase()
export function mailTagHue(tag:string):string {
  let hash=2166136261
  for(const ch of mailTagKey(tag)) {
    hash^=ch.codePointAt(0)!
    hash=Math.imul(hash,16777619)>>>0
  }
  return (hash/4294967296*360).toFixed(6)
}
