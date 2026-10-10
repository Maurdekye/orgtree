// alice's desk while she runs: live timer on the long call, then the finished
// times, the missing Input label, the agent link and the watchdog card.
module.exports = async (page) => {
  const r = {}
  await page.waitFor('[data-first-use-agent="alice"]', { timeout: 60000 })
  await page.rightClick('[data-first-use-agent="alice"]')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.tchip .tline', { timeout: 60000 })
  const rows = () => page.eval(() => [...document.querySelectorAll('.tchip .tline')].map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()))
  // the live timer: the 70 s call, once past ten seconds
  await page.waitFor(() => !!document.querySelector('.tool-running'), { timeout: 120000 })
  await page.sleep(1500)
  r.liveTimer = await page.eval(() => /\d+s/.test(document.querySelector('.tool-running')?.textContent ?? ''))
  await page.screenshot('1-live-timer')
  // the call finishes: every row carries its execution time
  await page.waitFor(() => document.querySelectorAll('.tool-exec-time').length >= 4 && !document.querySelector('.tool-running'), { timeout: 150000 })
  await page.sleep(800)
  const all = await rows()
  r.longCallMinutes = all.some(t => /sleep 70/.test(t) && /\b1m 0\ds\b|\b1m 1\ds\b/.test(t))
  r.quickCallShort = all.some(t => /echo quick/.test(t) && /· \d+ ms|· \d\.\ds/.test(t))
  await page.screenshot('2-finished')
  // links and card beside the calls
  r.agentLink = await page.eval(() => [...document.querySelectorAll('.tool-refs .tool-ref-agent')].some(e => /bob/.test(e.textContent)))
  r.dogCard = await page.eval(() => [...document.querySelectorAll('.tool-refs .desk-dog-chip')].some(e => /proof-dog/.test(e.textContent)))
  await page.rightClick('.tool-refs .tool-ref-agent')
  await page.waitFor('.ctxmenu[role="menu"]', { timeout: 10000 })
  r.agentMenu = true
  await page.screenshot('3-agent-menu')
  await page.press('Escape')
  await page.sleep(300)
  // the card opens the watchdog modal
  await page.click('.tool-refs .desk-dog-chip')
  await page.waitFor(() => /watchdog · armed/.test(document.body.innerText), { timeout: 15000 })
  r.dogModal = true
  await page.sleep(500)
  await page.screenshot('4-dog-modal')
  await page.press('Escape')
  await page.sleep(400)
  // the output view carries the time, and the input has no "Input" label
  await page.click({ selector: '.tchip .tline .targ', text: 'echo quick', regex: true })
  await page.waitFor('.toolinput', { timeout: 15000 })
  await page.sleep(500)
  r.noInputLabel = await page.eval(() => ![...document.querySelectorAll('.toolinput > .dim')].some(e => e.textContent.trim() === 'Input'))
  r.execLine = await page.eval(() => /Execution time/.test(document.querySelector('.tool-exec-line')?.textContent ?? ''))
  await page.screenshot('5-expanded')
  r.detail = { rows: all }
  return r
}
