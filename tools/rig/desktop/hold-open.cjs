// Keep a window open (it holds the app feed) for args.ms, doing nothing.
module.exports = async (page, { args }) => {
  await page.waitFor('[data-first-use-agent="rhea"]')
  const end = Date.now() + args.ms
  while (Date.now() < end) await page.sleep(1000)
  return { heldMs: args.ms }
}
