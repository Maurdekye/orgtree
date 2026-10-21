/** The engine derives this from visible content; urgency itself stays unchanged. */
export function hasMailAttention(m: {urgent?:boolean;mailbox_attention?:boolean}):boolean {
  return !!(m.urgent || m.mailbox_attention)
}
export function mailRepresentsMention(m:{from:string;body:string;at?:string;mailbox_attention?:boolean;urgent?:boolean},node:{id:string;user_mention?:{blurb?:string;at?:string}|null}):boolean {
  // Keep the engine's read-clear and native-count window in sync. Prose alone
  // is never enough: old mail must not hide a later independent mention.
  const gap=Date.parse(m.at??'')-Date.parse(node.user_mention?.at??'')
  if(!Number.isFinite(gap)||gap<0||gap>10_000)return false
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim()
  const blurb=normalize(node.user_mention?.blurb??'').replace(/^…|…$/g,'')
  return hasMailAttention(m)&&m.from.replace(/^@/,'')===node.id.replace(/^@/,'')&&!!blurb&&blurb.includes('@user')&&normalize(m.body).includes(blurb)
}
