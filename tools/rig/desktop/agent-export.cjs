// Export, Import here and Duplicate driven as a user drives them, against a rig run's real
// engine, with a capture of each step (docs/rust-engine/agent-export.md).
// args: { node, plain, under, copy, file, plainFile } - the node to export with its team (its
// folder holds secrets), a node with nothing secret, the node the file is imported under, the
// node to duplicate, and where the two exported zips are saved.
// Each step is its own try: a step that fails is named in the result and the rest go on.
//
// A finished export starts a download by itself. In the app the main process opens the Save
// dialog in Downloads (apps/desktop/main/remote-downloads.ts, with its own root test); this
// harness has no such dialog to answer, so it gives each download its place beforehand.
const fs = require('node:fs')
const { webContents } = require('electron')

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)

module.exports = async (page, { args }) => {
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
  const toast = () => page.eval(() => [...document.querySelectorAll('.toasts .toast')].map((el) => (el.innerText || '').trim()).filter(Boolean).pop() ?? '')

  // every download of this run is saved where the next export said, with no dialog
  let saveTo = null
  const downloads = []
  const sessions = new Set(webContents.getAllWebContents().map((contents) => contents.session))
  for (const session of sessions) {
    session.on('will-download', (_event, item) => {
      const entry = { name: item.getFilename(), url: item.getURL(), path: saveTo, state: 'started' }
      downloads.push(entry)
      if (saveTo) item.setSavePath(saveTo)
      item.once('done', (_e, state) => { entry.state = state })
    })
  }
  const saved = async (path) => {
    for (let i = 0; i < 300; i++) {
      const entry = downloads.find((d) => d.path === path)
      if (entry && entry.state !== 'started') return entry
      await page.sleep(100)
    }
    throw new Error(`no download ended at ${path}: ${JSON.stringify(downloads)}`)
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
    saveTo = args.file
    await page.click(button('Export'))
    await page.waitFor('.portable-found', { timeout: 60000 })
    said.found = await text('.portable-found')
    await page.screenshot('03-export-secrets-found')
    await page.click(button('Keep them'))
    // no dialog after it: the download starts by itself and the canvas is back
    await page.waitFor('.portable', { gone: true, timeout: 30000 })
    const download = await saved(args.file)
    said.exported = await toast()
    await page.screenshot('04-export-saving-toast')
    return { bytes: fs.statSync(args.file).size, download }
  })

  await step('exportPlain', async () => {
    await page.click(await menu(args.plain, 'Export…'))
    await page.waitFor('.portable')
    await page.waitFor(() => /agent/.test(document.querySelector('.portable-estimate')?.textContent ?? ''), { timeout: 30000 })
    await page.screenshot('05-export-nothing-secret-choose')
    saveTo = args.plainFile
    await page.click(button('Export'))
    // nothing secret in it: no question, no "ready" dialog; the download starts and the canvas is back
    await page.waitFor('.portable', { gone: true, timeout: 60000 })
    const download = await saved(args.plainFile)
    said.exportedPlain = await toast()
    said.foundPlain = await page.eval(() => !!document.querySelector('.portable-found'))
    await page.screenshot('06-export-nothing-secret-saving-toast')
    return { bytes: fs.statSync(args.plainFile).size, download }
  })

  await step('import', async () => {
    saveTo = null
    await page.click(await menu(args.under, 'Import here…'))
    await page.waitFor('.portable')
    await page.screenshot('07-import-choose')
    const { root } = await page.cdp('DOM.getDocument', { depth: 0 })
    const { nodeId } = await page.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '.portable-file input[type="file"]' })
    await page.cdp('DOM.setFileInputFiles', { nodeId, files: [args.file] })
    await page.waitFor('.portable-plan', { timeout: 60000 })
    said.plan = await text('.portable-plan')
    said.importDialog = await text('.portable')
    said.importSelects = await page.eval(() => document.querySelectorAll('.portable select').length)
    await page.screenshot('08-import-plan')
    await page.click(button('Import'))
    // no dialog after it: straight back to the canvas, with the toast and its Undo
    await page.waitFor('.portable', { gone: true, timeout: 120000 })
    await page.sleep(1500)
    said.imported = await toast()
    await page.screenshot('09-canvas-after-import')
  })

  await step('duplicate', async () => {
    // nobody under it and a plan that fits: no dialog at all, the copy and its toast
    await page.click(await menu(args.copy, 'Duplicate…'))
    await page.waitFor(card(`${args.copy}-2`), { timeout: 120000 })
    await page.sleep(1500)
    said.copyDialogSeen = await page.eval(() => !!document.querySelector('.portable'))
    said.copied = await toast()
    await page.screenshot('10-canvas-after-duplicate')
  })

  await step('duplicateTeam', async () => {
    // a node with a team under it: how much of it is the one thing to choose
    await page.click(await menu(args.node, 'Duplicate…'))
    await page.waitFor('.portable-plan', { timeout: 60000 })
    said.copyDialog = await text('.portable')
    await page.screenshot('11-duplicate-team-plan')
    await page.click({ selector: '.portable .ls-actions button', text: '^Cancel$', regex: true })
    await page.waitFor('.portable', { gone: true })
  })

  await step('settings', async () => {
    await page.eval(() => window.dispatchEvent(new window.CustomEvent('orgtree:open-app-settings', { detail: { tab: 'providers' } })))
    await page.sleep(1500)
    await page.click({ selector: '[role="tab"]', text: '^Runtime$', regex: true })
    await page.sleep(1500)
    const row = await page.locate({ text: 'Strip secrets from exports', scroll: true })
    await page.sleep(600)
    await page.screenshot('12-settings-export-and-import')
    await page.press('Escape')
    await page.sleep(500)
    return !!row
  })

  return { steps, said, downloads }
}
