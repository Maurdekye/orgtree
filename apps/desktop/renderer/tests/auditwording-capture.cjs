module.exports = async page => {
  await page.resize('1100x1100')
  await page.goto('/')
  await page.waitFor('[aria-label="Total limit amount"]', { timeout: 5000 })
  const details = await page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const text = document.body.textContent
    const quick = window.auditQuickChat.items.find(item => item.action === 'Hire a new agent and send')
    return { text, quickNote: quick.note,
      total: document.querySelector('[aria-label="Total limit amount"]').value,
      silence: document.querySelector('[aria-label="Silence limit amount"]').value }
  })
  if (!details.text.includes('Default (high fallback)')
    || !details.text.includes('Changes can affect a running turn at its next timer check')
    || details.text.includes('CLI default (no flag)')
    || details.quickNote !== 'Single-line input; Shift+Enter does not submit'
    || details.total !== '24' || details.silence !== '10') throw new Error(JSON.stringify(details))
  return { details, screenshots: [await page.screenshot('audit-defaults-and-live-turn-limits')] }
}
