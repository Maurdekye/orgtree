// Org settings → Save as template: the modal, the save, and the download of
// the saved file (the Blob handed to the download anchor is captured).
// args: { shot, name, include?: { accounts?: bool, folders?: bool } }
module.exports = async (page, { args }) => {
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 30000 })
  await page.sleep(1500)
  await page.click('button[title="Settings"]')
  await page.waitFor({ selector: 'button', text: '^save as template…$', regex: true, scroll: true }, { timeout: 20000 })
  await page.sleep(600)
  await page.screenshot(`${args.shot}-settings`)
  await page.click({ selector: 'button', text: '^save as template…$', regex: true, scroll: true })
  await page.waitFor('#save-template-name')
  await page.eval((name) => {
    const el = document.querySelector('#save-template-name')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, name)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, args.name)
  for (const [label, on] of Object.entries(args.include || {})) {
    if (!on) continue
    await page.click({ selector: '.save-template-groups label', text: label === 'accounts' ? 'Account binding' : 'Folder scopes' })
  }
  await page.sleep(600)
  await page.screenshot(`${args.shot}-modal`)
  await page.click({ selector: '.save-template button', text: '^Save template$', regex: true })
  await page.waitFor({ selector: '.save-template button', text: '^Download ' , regex: true }, { timeout: 20000 })
  await page.sleep(600)
  await page.eval(() => {
    window.__rigDownloads = []
    const orig = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      const rec = { size: blob.size, type: blob.type }
      window.__rigDownloads.push(rec)
      blob.text().then((t) => { rec.text = t })
      return orig.call(URL, blob)
    }
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      window.__rigDownloads.push({ anchor: this.download })
      if (!this.download) click.call(this)
    }
  })
  await page.click({ selector: '.save-template button', text: '^Download ', regex: true })
  await page.sleep(1200)
  await page.screenshot(`${args.shot}-saved`)
  return page.eval(() => ({
    text: document.querySelector('.save-template')?.innerText.replace(/\s+/g, ' ').trim(),
    downloads: window.__rigDownloads,
  }))
}
