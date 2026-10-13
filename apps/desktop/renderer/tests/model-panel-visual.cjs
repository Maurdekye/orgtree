module.exports=async (page,ctx)=>{
  const results=[]
  const baseline=ctx.args.baseline
  for(const theme of ['dark','light'])for(const size of ['1366x768','390x844']){
    await page.resize(size);await page.goto('/')
    await page.eval(light=>document.documentElement.classList.toggle('contrast-light',light),theme==='light')
    await page.click('#app-settings-tab-providers');await page.waitFor('.ls-toggles .orr-tog')
    for(const selector of ['.orr-toggles:not(.ls-toggles)','.ls-toggles']){
      await page.eval(s=>document.querySelector(s).scrollIntoView({block:'center'}),selector)
      const geometry=await page.eval(s=>{
        const panel=document.querySelector(s),r=panel.getBoundingClientRect()
        const card=s==='.ls-toggles'?panel.closest('.ls-server').querySelector('.ls-server-row'):
          document.querySelector('.orr-keyrow')
        if(!card)throw new Error('missing key/server card')
        const c=card.getBoundingClientRect(),container=document.querySelector('#app-settings-panel-providers')
        const target=document.elementFromPoint(r.right-10,r.top+r.height/2)
        return {left:r.left,right:r.right,cardLeft:c.left,cardRight:c.right,width:r.width,
          overflow:container.scrollWidth>container.clientWidth+1,cursor:getComputedStyle(panel).cursor,
          hit:target?.className,empty:{x:r.right-10,y:r.top+r.height/2}}
      },selector)
      if(geometry.overflow)throw new Error('overflow '+JSON.stringify(geometry))
      if(!baseline&&(Math.abs(geometry.left-geometry.cardLeft)>1||Math.abs(geometry.right-geometry.cardRight)>1||geometry.cursor!=='pointer'))
        throw new Error('alignment '+JSON.stringify(geometry))
      const shot=await page.screenshot('model-'+(selector==='.ls-toggles'?'language':'openrouter')+'-'+size+'-'+theme)
      results.push({theme,size,selector,baseline,...geometry,shot})
      if(baseline)continue
      const menu=selector==='.ls-toggles'?'.ls-browser':'.orr-picker'
      await page.mouse('mousePressed',geometry.empty.x,geometry.empty.y);await page.mouse('mouseReleased',geometry.empty.x,geometry.empty.y)
      await page.waitFor(menu);await page.press('Escape')
      await page.eval(s=>document.querySelector(s+' .orr-panel-open').focus(),selector)
      await page.press('Enter');await page.waitFor(menu);await page.press('Escape')
      await page.eval(s=>document.querySelector(s+' .orr-panel-open').focus(),selector)
      await page.press('Space');await page.waitFor(menu);await page.press('Escape')
      await page.click(selector+' .orr-more');await page.waitFor(menu);await page.press('Escape')
      results.push({theme,size,selector,emptyClick:true,enter:true,space:true,plus:true})
    }
    if(!baseline){
      await page.eval(()=>document.querySelector('.orr-toggles:not(.ls-toggles)').scrollIntoView({block:'center'}))
      await page.click('.orr-toggles:not(.ls-toggles) .orr-tog')
      const chip=await page.eval(()=>({menu:!!document.querySelector('.orr-picker'),seen:window.modelPanelFixture.seen}))
      if(chip.menu||!chip.seen.some(s=>s.path==='/api/openrouter/favorites'&&s.body.selected===false))throw new Error('chip action '+JSON.stringify(chip))
      results.push({theme,size,chipToggled:true,noMenuFromChip:true})
    }
  }
  return results
}
