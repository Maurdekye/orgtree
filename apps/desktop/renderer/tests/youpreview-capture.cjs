module.exports=async page=>{
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.msg.assistant',{timeout:5000})
  await page.eval(()=>{
    const messages=document.querySelector('.msgs')
    messages.scrollTop=messages.scrollHeight
    messages.dispatchEvent(new Event('scroll'))
  })
  await page.waitFor('.pinuser-t',{timeout:5000})
  const details=await page.eval(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))
    const pin=document.querySelector('.pinuser'),rect=pin.getBoundingClientRect()
    return {text:pin.textContent.trim(),title:pin.title,
      hireCards:document.querySelectorAll('[data-event-variant="lifecycle.hired"]').length,
      visible:rect.width>0&&rect.height>0&&rect.x>=0&&rect.right<=innerWidth&&rect.y>=0&&rect.bottom<=innerHeight}
  })
  if(details.text!=='↑ you: Please check the release checklist.'||details.hireCards!==4||!details.visible)
    throw new Error(JSON.stringify(details))
  return {details,screenshots:[await page.screenshot('desk-you-message-preview')]}
}
