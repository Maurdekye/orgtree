module.exports = async page => {
  await page.resize('1000x700'); await page.goto('/')
  await page.waitFor('[role="dialog"]')
  await page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 80)) })
  const value = await page.eval(() => {
    const dialog = document.querySelector('[role="dialog"]'), rect = dialog.getBoundingClientRect()
    return { ...rect.toJSON(), text: dialog.textContent, radios: dialog.querySelectorAll('input[type="radio"]').length,
      buttons: [...dialog.querySelectorAll('.row > button')].map(b => ({ label:b.textContent,disabled:b.disabled })),
      sections: dialog.querySelectorAll('[data-compact-preview]').length,
      inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }
  })
  if(value.radios || value.sections!==2 || !value.inViewport
    || JSON.stringify(value.buttons)!==JSON.stringify([{label:'compact 2 agents',disabled:false},{label:'cheap-compact 4 agents',disabled:false},{label:'cancel',disabled:false}])
    || !value.text.includes('Codex') || !value.text.includes('busy-worker') || !value.text.includes('new-worker'))
    throw new Error('Two-action preview failed '+JSON.stringify(value))
  await page.screenshot('bulk-compact-two-actions')
  return value
}
