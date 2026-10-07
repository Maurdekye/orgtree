// Load the org canvas (args.loads times) and watch it for args.ms each time;
// report whether the renderer's crash screen ("Orgtree hit a problem") showed.
// args.sizes: viewport presets to switch to right after each load, in turn
// (a resize during mount is what the driver does anyway).
module.exports = async (page, { args, org }) => {
  const loads = args.loads ?? 1
  const sizes = args.sizes ?? []
  const out = []
  for (let i = 0; i < loads; i++) {
    if (i > 0) {
      await page.goto(`/o/${org}`)
      if (sizes.length) await page.resize(sizes[i % sizes.length])
    }
    const end = Date.now() + (args.ms ?? 8000)
    let crashed = null
    while (Date.now() < end && !crashed) {
      crashed = await page.eval(() => {
        const t = document.body ? document.body.innerText : ''
        return /hit a problem and had to stop/.test(t) ? t.slice(0, 600) : null
      })
      if (!crashed) await page.sleep(150)
    }
    out.push({ load: i, size: page.size, crashed: !!crashed, text: crashed })
    if (crashed) { await page.screenshot(`crash-${i}`); break }
  }
  return { loads: out, crashes: out.filter((x) => x.crashed).length, consoleErrors: page.consoleErrors.filter((e) => !/Electron Security Warning/.test(e)) }
}
