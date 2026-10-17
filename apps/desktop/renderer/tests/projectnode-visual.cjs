module.exports = async (page) => {
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.sq.project.mini', { timeout: 5000 })
  const details = await page.eval(async () => {
    // two frames and a beat before the capture (team notes, round 439)
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    const mini = document.querySelector('.sq.project.mini')
    const icon = mini && mini.querySelector('.project-mini')
    const stripe = mini ? getComputedStyle(mini, '::before') : null
    return {
      stripeDisplay: stripe ? stripe.display : null,
      stripeWidth: stripe ? stripe.width : null,
      iconFontSize: icon ? getComputedStyle(icon).fontSize : null,
    }
  })
  const screenshot = await page.screenshot(process.env.PROJECTNODE_VISUAL_NAME || 'projectnode-1000x700')
  return { details, screenshots: [screenshot] }
}
