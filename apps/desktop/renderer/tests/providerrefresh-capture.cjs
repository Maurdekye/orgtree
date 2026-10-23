module.exports = async page => {
  await page.resize('1000x700'); await page.goto('/')
  await page.waitFor('.native-login .acct-claude-login button',{timeout:5000})
  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve,150))))
    const row = document.querySelector('.native-login')
    const button = row.querySelector('.acct-claude-login button')
    const rect = button.getBoundingClientRect()
    return {row:row.textContent,button:button.textContent,refresh:!!document.querySelector('[aria-label="refresh provider status"]'),
      box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{width:innerWidth,height:innerHeight}}
  })
  if(details.button!=='Sign in'||!details.refresh||details.box.width<=0||details.box.x<0
    ||details.box.x+details.box.width>details.viewport.width||details.box.y+details.box.height>details.viewport.height) throw new Error(JSON.stringify(details))
  return {details,screenshots:[await page.screenshot('default-codex-sign-in')]}
}
