module.exports=async page=>{
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.phone-acts button.primary',{timeout:5000})
  const details=await page.eval(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Turn on phone access')
    const r=button?.getBoundingClientRect()
    return {accessButton:button?.textContent,checkbox:!!document.querySelector('.phone-cbx'),
      obsoleteText:/keep.*awake/i.test(document.body.textContent),
      visible:!!r&&r.width>0&&r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight}
  })
  if(details.checkbox||details.obsoleteText||!details.visible)throw new Error(JSON.stringify(details))
  return {details,screenshots:[await page.screenshot('phone-access-without-power-setting')]}
}
