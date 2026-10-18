module.exports = async page => {
  await page.resize('1000x700'); await page.goto('/')
  await page.waitFor('[role="dialog"]')
  const initial = await page.eval(() => ({ cheap: document.querySelector('input[value="cheap"]')?.checked, normal: document.querySelector('input[value="normal"]')?.checked }))
  if (!initial.cheap || initial.normal) throw new Error('Cheap is not the initial default '+JSON.stringify(initial))
  await page.eval(() => document.querySelector('input[value="normal"]').click())
  await page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 80)) })
  const value = await page.eval(() => {
    const dialog = document.querySelector('[role="dialog"]'), rect = dialog.getBoundingClientRect()
    return { ...rect.toJSON(), text: dialog.textContent, normal: dialog.querySelector('input[value="normal"]')?.checked,
      confirmDisabled: dialog.querySelector('button.danger.solid')?.disabled,
      inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }
  })
  if (!value.normal || value.confirmDisabled || !value.inViewport || !/2 agents/.test(value.text)
    || !value.text.includes('Codex') || !value.text.includes('busy-worker') || !value.text.includes('new-worker')) throw new Error('Modal preview failed '+JSON.stringify(value))
  await page.screenshot('bulk-compact-type-choice')
  return { initial, ...value }
}
