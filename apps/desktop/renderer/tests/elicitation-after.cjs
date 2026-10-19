module.exports = async page => {
  await page.resize('1000x700')
  const results = []
  for (const mode of ['form', 'url']) {
    await page.goto('/?mode=' + mode)
    await page.waitFor('[data-elicitation-id]')
    await page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 150)) })
    const value = await page.eval(() => {
      const card = document.querySelector('[data-elicitation-id]')
      return { text: card.textContent, fields: card.querySelectorAll('select,input').length,
        links: [...card.querySelectorAll('a')].map(a => a.href),
        buttons: [...card.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return { text: b.textContent, visible: r.top >= 0 && r.bottom <= innerHeight } }) }
    })
    if (value.buttons.some(b => !b.visible) || JSON.stringify(value.buttons.map(b => b.text)) !== JSON.stringify(['Accept', 'Decline', 'Cancel'])
      || value.fields !== (mode === 'form' ? 4 : 0) || (mode === 'url' && value.links[0] !== 'https://example.invalid/permission'))
      throw new Error('Elicitation card layout mismatch ' + JSON.stringify(value))
    await page.screenshot('elicitation-' + mode)
    results.push({ mode, ...value })
  }
  return results
}
