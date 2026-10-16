module.exports = async page => {
  const samples = []
  for (let i = 0; i < 4; i++) {
    await page.goto('/?case=' + i)
    await page.waitFor(() => !!document.querySelector('line[data-reorder-before],line[data-reorder-after]'))
    const sample = await page.eval(() => ({
      label: document.querySelector('h2').textContent,
      gutter: Number(document.querySelector('[data-gutter]').dataset.gutter),
      request: { before: document.querySelector('line').dataset.reorderBefore, after: document.querySelector('line').dataset.reorderAfter },
    }))
    if (Math.abs(sample.gutter - 16) > 1e-8) throw Error(JSON.stringify(sample))
    await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.screenshot('ring-end-' + i)
    samples.push(sample)
  }
  return samples
}
