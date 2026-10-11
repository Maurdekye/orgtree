module.exports = async (page, { org, args }) => {
  await page.waitFor(`[data-copy-agent-name="${args.agent}"]`)
  await page.rightClick(`[data-copy-agent-name="${args.agent}"]`)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.msgs')
  await page.eval(({ thoughtFirst }) => {
    window.orderTokens = thoughtFirst ? ['REASON_FIRST', 'REPLY_SECOND'] : ['REPLY_FIRST', 'REASON_SECOND']
    window.reasonBad = []
    window.reasonSamples = 0
    window.chatRequests = []
    const fetch = window.fetch.bind(window)
    window.fetch = (...args) => {
      if (String(args[0]).includes('/chat?')) window.chatRequests.push({ at: Date.now(), url: String(args[0]) })
      return fetch(...args)
    }
    window.reasonSampling = true
    const tick = () => {
      for (const fold of document.querySelectorAll('.thoughtline[title="read the thought process"]')) fold.click()
      const text = document.querySelector('.msgs')?.textContent || ''
      const [first, second] = window.orderTokens.map(t => text.indexOf(t))
      if (first >= 0 && second >= 0) window.reasonSamples++
      const duplicate = window.orderTokens.some(t => text.split(t).length > 2)
      if (((first >= 0 && second >= 0 && second < first) || duplicate) && window.reasonBad.length < 10) window.reasonBad.push(text)
      if (window.reasonSampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, args)
  await page.api('POST', `/api/orgs/${org}/nodes/${args.agent}/message`, { text: args.thoughtFirst ? 'THOUGHT-FIRST' : 'TEXT-FIRST' })
  await page.waitFor(() => window.orderTokens.every(t => document.querySelector('.msgs')?.textContent.includes(t)), { timeout: 120000 })
  const live = await page.eval(() => ({ thinking: [...document.querySelectorAll('.thoughtbody.live')].map(e=>e.textContent), drafts: [...document.querySelectorAll('.draft,.msg.live.assistant')].map(e=>e.textContent) }))
  await page.screenshot('live')
  // A focus read is a real recovery path even when token streaming needs no HTTP.
  await page.eval(() => window.dispatchEvent(new Event('focus')))
  await page.sleep(6000)
  await page.screenshot('live-after-poll')
  await page.waitFor(() => !document.querySelector('.draft') && !document.querySelector('.thoughtbody.live'), { timeout: 60000 })
  await page.sleep(1500)
  const final = await page.eval(() => {
    const text = document.querySelector('.msgs').textContent
    const [first, second] = window.orderTokens.map(t => text.indexOf(t))
    return { ordered: first >= 0 && second > first, first, second }
  })
  await page.screenshot('final')
  const bad = await page.eval(() => { window.reasonSampling = false; return window.reasonBad })
  return { live, final, bad, samples: await page.eval(() => window.reasonSamples), requests: await page.eval(() => window.chatRequests) }
}
