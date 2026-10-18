/** The engine derives this from visible content; urgency itself stays unchanged. */
export function hasMailAttention(m: {urgent?:boolean;mailbox_attention?:boolean}):boolean {
  return !!(m.urgent || m.mailbox_attention)
}
export function mailRepresentsMention(m:{from:string;body:string;mailbox_attention?:boolean;urgent?:boolean},node:{id:string;user_mention?:{blurb?:string}|null}):boolean {
  const normalize=(s:string)=>s.replace(/\s+/g,' ').trim()
  const blurb=normalize(node.user_mention?.blurb??'').replace(/^…|…$/g,'')
  return hasMailAttention(m)&&m.from.replace(/^@/,'')===node.id.replace(/^@/,'')&&!!blurb&&blurb.includes('@user')&&normalize(m.body).includes(blurb)
}
