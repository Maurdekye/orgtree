module.exports=async page=>{
  const results=[]
  const dialog=()=>page.eval(()=>!!document.querySelector('.provider-dialog'))
  const reveal=target=>page.eval(t=>{
    const selector=typeof t==='string'?t:t.selector
    const e=[...document.querySelectorAll(selector)]
      .find(e=>typeof t==='string'||e.textContent===t.text)
    if(!e)throw new Error('missing visual target '+JSON.stringify(t))
    e.scrollIntoView({block:'center'})
  },target)
  const dismiss=async(target,name)=>{
    await reveal(target)
    await page.click(target)
    await page.waitFor('.provider-dialog')
    await page.click('.provider-dialog input')
    await page.type('synthetic-unsaved-draft')
    const box=await page.eval(()=>{
      const d=document.querySelector('.provider-dialog'),i=d.querySelector('input')||d
      const r=i.getBoundingClientRect()
      return {x:r.x+r.width/2,y:r.y+r.height/2}
    })
    await page.mouse('mousePressed',box.x,box.y)
    await page.mouse('mouseReleased',box.x,box.y)
    if(!await dialog())throw new Error(name+' inside click dismissed')
    await page.mouse('mousePressed',box.x,box.y)
    await page.mouse('mouseMoved',3,3)
    await page.mouse('mouseReleased',3,3)
    if(!await dialog())throw new Error(name+' drag-out dismissed')
    await page.mouse('mousePressed',3,3)
    await page.mouse('mouseReleased',3,3)
    if(await dialog())throw new Error(name+' outside click did not dismiss')
    await reveal(target)
    await page.click(target)
    const discarded=await page.eval(()=>![...document.querySelectorAll('.provider-dialog input')]
      .some(i=>i.value.includes('synthetic-unsaved-draft')))
    if(!discarded)throw new Error(name+' unsaved draft retained')
    await page.press('Escape')
    if(await dialog())throw new Error(name+' Escape did not dismiss')
    results.push({name,insideRetained:true,dragRetained:true,outsideClosed:true,draftDiscarded:true,escapeClosed:true})
  }
  for(const theme of ['dark','light'])for(const size of ['1366x768','390x844']){
    await page.resize(size);await page.goto('/')
    await page.eval(light=>document.documentElement.classList.toggle('contrast-light',light),theme==='light')
    await page.click('[role="tab"][id="app-settings-tab-providers"]')
    await page.waitFor('.prov-openrouter')
    const geometry=await page.eval(()=>{
      const head=document.querySelector('.prov-openrouter'),right=head.querySelector('.set-head-right')
      const add=right.querySelector('button.acct-secondary-btn'),r=add.getBoundingClientRect()
      const all=[...head.parentElement.querySelectorAll('button')].filter(b=>/^Add (another )?OpenRouter key$/.test(b.textContent))
      const panel=document.querySelector('#app-settings-panel-providers')
      const scroller=head.closest('.acct-panel')
      // Include the neighboring native provider header in the wide screenshot.
      scroller.scrollTop+=head.getBoundingClientRect().top-scroller.getBoundingClientRect().top-420
      return {oneAdd:all.length===1,besideSwitch:!!right.querySelector('input[type="checkbox"]'),
        popup:add.getAttribute('aria-haspopup'),class:add.className,height:r.height,
        providerWidth:panel.clientWidth,providerScrollWidth:panel.scrollWidth,
        overflow:panel.scrollWidth>panel.clientWidth+1,noSeparateName:!document.querySelector('button[title="name this key"]')}
    })
    if(!geometry.oneAdd||!geometry.besideSwitch||geometry.popup!=='dialog'||geometry.height<28||geometry.overflow||!geometry.noSeparateName)
      throw new Error('header '+JSON.stringify(geometry))
    const shot=await page.screenshot('providers-'+size+'-'+theme)
    results.push({name:'header-'+size+'-'+theme,...geometry,shot})
    await dismiss({selector:'.prov-openrouter button',text:'Add another OpenRouter key'},'openrouter-add-'+size+'-'+theme)
    await dismiss('button[title^="replace the key"]','openrouter-settings-'+size+'-'+theme)
    await dismiss('button[title^="add a model server"]','language-add-'+size+'-'+theme)
    await dismiss('button[title="edit this server"]','language-edit-'+size+'-'+theme)
  }
  return results
}
