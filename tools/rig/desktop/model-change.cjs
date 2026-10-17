module.exports=async page=>{
  await page.waitFor('[data-modelcase="3"]')
  await page.eval(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  await page.sleep(60)
  await page.screenshot('01-model-change-cases')
  return page.eval(()=>[...document.querySelectorAll('[data-modelcase]')].map(el=>({
    label:el.querySelector('h3').textContent,
    models:[...el.querySelectorAll('.tier')].map(chip=>[...chip.classList].find(c=>c.startsWith('t-'))),
    arrow:el.querySelector('.tool-ref-agent')?.textContent.includes('→') ?? false,
  })))
}
