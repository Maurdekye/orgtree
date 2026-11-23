// Export, Import here and Duplicate driven as a user drives them, against a rig run's real
// engine, with a capture of each step (docs/rust-engine/agent-export.md).
// args: { node, team, under, copy, file } - the node to export with its team, the node the
// file is imported under, the node to duplicate, and where the exported zip is kept between.
// Each step is its own try: a step that fails is named in the result and the rest go on.
const fs = require('node:fs')

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)

module.exports = async (page, { args, base }) => {
  const card = (name) => `[data-copy-agent-name="${name}"]`
  const steps = {}
  const said = {}
  const text = (selector) => page.eval((s) => (document.querySelector(s)?.innerText ?? '').trim(), selector)
  const step = async (name, fn) => {
    try { steps[name] = (await fn()) ?? true } catch (e) {
      steps[name] = `FAILED: ${String(e && e.message || e).slice(0, 300)}`
      try { await page.screenshot(`failed-${name}`) } catch { /* nothing to capture */ }
      // whatever is open is closed, so the next step starts from the canvas
      for (let i = 0; i < 3; i++) { await page.press('Escape'); await page.sleep(200) }
    }
  }
  const menu = async (name, label) => {
    await page.rightClick(card(name))
    await page.waitFor('.ctxmenu[role="menu"]')
    return { selector: 'button.ctxmenu-item', text: `^${escapeRe(label)}$`, regex: true }
  }
  const button = (label) => ({ selector: '.portable button', text: `^${escapeRe(label)}$`, regex: true })
  const closeDialog = async () => {
    await page.click({ selector: '.portable .ls-actions button', text: '^(Done|Cancel)$', regex: true })
    await page.waitFor('.portable', { gone: true })
  }

  await page.waitFor(card(args.node), { timeout: 30000 })
  await page.sleep(1500)

  await step('menu', async () => {
    const item = await menu(args.node, 'Export…')
    await page.screenshot('01-node-menu')
    const labels = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
    await page.click(item)
    return labels.filter((l) => /Export|Import|Duplicate/.test(l))
  })

  await step('export', async () => {
    await page.waitFor('.portable')
    await page.waitFor(() => /agent/.test(document.querySelector('.portable-estimate')?.textContent ?? ''), { timeout: 30000 })
    await page.click({ selector: '.portable-scope label', text: 'and everything under it', regex: true })
    await page.sleep(800)
    await page.waitFor(() => /agents/.test(document.querySelector('.portable-estimate')?.textContent ?? ''), { timeout: 30000 })
    said.estimate = await text('.portable-estimate')
    await page.screenshot('02-export-choose')
    await page.click(button('Export'))
    await page.waitFor('.portable-found', { timeout: 60000 })
    said.found = await text('.portable-found')
    await page.screenshot('03-export-secrets-found')
    await page.click(button('Keep them in the file'))
    await page.waitFor('.portable-done', { timeout: 30000 })
    said.exported = await text('.portable-done')
    await page.screenshot('04-export-ready')
    // the file a user would save: fetched as this window's own request would be
    const href = await page.eval(() => document.querySelector('.portable-save')?.getAttribute('href'))
    const res = await fetch(new URL(href, base).href, { headers: { 'X-Orgtree-Desktop-Token': process.env.RIG_DESKTOP_TOKEN } })
    if (!res.ok) throw new Error(`the export file answered ${res.status}`)
    fs.writeFileSync(args.file, Buffer.from(await res.arrayBuffer()))
    await closeDialog()
    return { bytes: fs.statSync(args.file).size, href }
  })

  await step('import', async () => {
    await page.click(await menu(args.under, 'Import here…'))
    await page.waitFor('.portable')
    await page.screenshot('05-import-choose')
    const { root } = await page.cdp('DOM.getDocument', { depth: 0 })
    const { nodeId } = await page.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '.portable-file input[type="file"]' })
    await page.cdp('DOM.setFileInputFiles', { nodeId, files: [args.file] })
    await page.waitFor('.portable-plan', { timeout: 60000 })
    said.plan = await text('.portable-plan')
    said.facts = await text('.portable-facts')
    await page.screenshot('06-import-plan-clamped')
    // the other strategy, as the dialog offers it
    const changed = await page.eval(() => {
      const select = document.querySelector('.portable-strategy select')
      if (!select) return null
      const next = [...select.options].find((o) => !o.selected)
      const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      set.call(select, next.value)
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
      return next.value
    })
    if (changed) {
      await page.sleep(1500)
      said.planOther = await text('.portable-plan')
      await page.screenshot('07-import-plan-other-strategy')
    }
    await page.click(button('Import'))
    await page.waitFor('.portable-done', { timeout: 120000 })
    said.imported = await text('.portable-done')
    await page.screenshot('08-import-done')
    await closeDialog()
    await page.sleep(1500)
    await page.screenshot('09-canvas-after-import')
    return { strategy: changed }
  })

  await step('duplicate', async () => {
    await page.click(await menu(args.copy, 'Duplicate…'))
    await page.waitFor('.portable-plan', { timeout: 60000 })
    said.copyPlan = await text('.portable-plan')
    await page.screenshot('10-duplicate-plan')
    await page.click(button('Duplicate'))
    await page.waitFor('.portable-done', { timeout: 120000 })
    said.copied = await text('.portable-done')
    await page.screenshot('11-duplicate-done')
    await closeDialog()
    await page.sleep(1500)
    await page.screenshot('12-canvas-after-duplicate')
  })

  await step('settings', async () => {
    await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
    await page.sleep(1500)
    await page.click({ selector: '[role="tab"]', text: '^Runtime$', regex: true })
    await page.sleep(1500)
    const row = await page.locate({ text: 'Strip secrets from exports', scroll: true })
    await page.sleep(600)
    await page.screenshot('13-settings-export-and-import')
    await page.press('Escape')
    await page.sleep(500)
    return !!row
  })

  return { steps, said }
}
