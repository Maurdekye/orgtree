// The org list as the user sees it on the homepage: every row's text, and the
// lines for orgs a first-start import could not copy. args: { shot: "name" }
module.exports = async (page, { args }) => {
  await page.waitFor('.shell-homepage-list, .org', { timeout: 30000 })
  await page.sleep(1500)
  const rows = await page.eval(() => [...document.querySelectorAll('.org')].map((r) => ({
    text: (r.innerText || '').trim().replace(/\s+/g, ' '),
    importFailed: r.classList.contains('org-import-failed'),
    title: r.querySelector('[role="status"]')?.getAttribute('title') || null,
  })))
  await page.screenshot(args.shot || 'org-list')
  return { rows, failures: rows.filter((r) => r.importFailed) }
}
