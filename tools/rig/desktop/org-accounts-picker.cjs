// org-accounts.mjs's picker stage: Org settings › Hire defaults, the "account
// for NEW agents" row, read with the org's default sign-in unticked. Reports
// the select's options (value, text, disabled) and what it shows; the proof
// decides what passes. args: { org }
module.exports = async (page, { args }) => {
  await page.goto(`/o/${args.org}`)
  await page.waitFor('.sq.user', { timeout: 60000 })
  await page.rightClick('.sq.user')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Org settings' })
  await page.waitFor('#org-settings-tab-hiredefaults')
  await page.click('#org-settings-tab-hiredefaults')
  const SEL = 'select[aria-label="default provider account for new hires"]'
  await page.waitFor(SEL)
  // the org's account list arrives after the panel opens
  await page.sleep(2500)
  const out = await page.eval((sel) => {
    const select = document.querySelector(sel)
    select?.closest('.set-row')?.scrollIntoView({ block: 'center' })
    return {
      options: [...(select?.options ?? [])].map((o) => ({ value: o.value, text: o.innerText, disabled: o.disabled })),
      value: select?.value ?? null,
      shown: select?.selectedOptions[0]?.innerText ?? null,
      title: select?.title ?? null,
    }
  }, SEL)
  await page.screenshot('picker')
  out.consoleErrors = page.consoleErrors
  return out
}
