module.exports=async page=>{
  await page.resize('1000x600');await page.goto('/')
  await page.waitFor('.org-mail-attribution')
  const paint=()=>page.eval(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,160)))))
  await page.eval(()=>{const s=document.createElement('style');s.textContent='.settings.wide{width:950px;max-width:calc(100vw - 24px)}.mailer-list{width:140px;min-width:140px;max-width:140px}';document.head.appendChild(s)})
  await paint()
  const snapshot=()=>page.eval(()=>{
    const d=document.querySelector('iframe[data-proof-popout]')?.contentDocument??document
    const h=d.querySelector('.mailer-head'),link=h.querySelector('.ref-agent'),badge=link.querySelector('.tier'),meta=h.querySelector('.mail-head-meta')
    const b=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}}
    return {header:b(h),link:b(link),badge:b(badge),meta:b(meta),overflow:h.scrollWidth>h.clientWidth+1,
      attribution:h.querySelector('.org-mail-attribution').textContent,recipient:!!h.querySelector('[data-hub-address]'),
      metadata:meta.textContent,ownerIsPopout:d!==document}
  })
  const wide=await snapshot()
  if(wide.overflow||wide.badge.y<wide.link.y-1||wide.badge.bottom>wide.link.bottom+1||Math.abs(wide.meta.y-wide.link.y)>6
    ||Math.abs(wide.meta.right-wide.header.right)>12||!wide.recipient)throw Error('wide header '+JSON.stringify(wide))
  await page.resize('520x600');await paint()
  const narrow=await snapshot()
  if(narrow.overflow||narrow.meta.right>narrow.header.right+1)throw Error('narrow header '+JSON.stringify(narrow))
  await page.resize('1000x600');await paint()
  // Exercise the real MovableSurface adoption/redock path in a second browser
  // document. The iframe substitutes for the native window only.
  await page.eval(()=>{
    const frame=document.createElement('iframe');frame.dataset.proofPopout='1'
    frame.style.cssText='position:fixed;inset:0;width:1000px;height:600px;border:0;z-index:99999'
    document.body.appendChild(frame)
    window.open=()=>frame.contentWindow
    document.querySelector('.popout-button').click()
  });await paint()
  const popout=await snapshot()
  if(!popout.ownerIsPopout||popout.overflow||popout.badge.y<popout.link.y-1||popout.badge.bottom>popout.link.bottom+1)
    throw Error('popout header '+JSON.stringify(popout))
  await page.eval(()=>{const f=document.querySelector('iframe[data-proof-popout]');f.contentDocument.querySelector('.popout-button').click()});await paint()
  await page.eval(()=>document.querySelector('iframe[data-proof-popout]').remove());await paint()
  await page.screenshot('org-outbox-header')
  return {wide,narrow,popout}
}
