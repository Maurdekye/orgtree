// alice's desk after she ran orgtree_work calls: ticket links beside the calls, a click opens the ticket.
module.exports = async (page) => {
  const r = {}
  await page.waitFor('[data-first-use-agent="alice"]', { timeout: 60000 })
  await page.rightClick('[data-first-use-agent="alice"]')
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.tchip .tline', { timeout: 60000 })
  await page.waitFor(() => /^done\./m.test(document.body.innerText) && document.querySelectorAll('.tchip .tline').length >= 5, { timeout: 90000 })
  await page.sleep(2500)
  const rows = () => page.eval(() => [...document.querySelectorAll('.tchip .tline')].map(e => ({
    text: (e.innerText || '').replace(/\s+/g, ' ').trim(),
    chips: [...e.querySelectorAll('.tool-refs .tool-ticket')].map(c => c.textContent.trim()),
    plain: [...e.querySelectorAll('.tool-refs .tool-ticket-plain')].map(c => c.textContent.trim()),
  })))
  const all = await rows()
  r.detail = { rows: all }
  const work = all.filter(x => /orgtree_work/.test(x.text))
  r.getLinked = work.some(x => /rig-smoke-item/.test(x.chips.join()))
  r.createLinked = work.some(x => /create/.test(x.text) && x.chips.includes('proof-ticket'))
  r.updateLinked = work.some(x => /update|proof-ticket/.test(x.text) && x.chips.filter(c => c === 'proof-ticket').length === 1 && !/create/.test(x.text))
  r.listNone = work.some(x => /list/.test(x.text) && !x.chips.length && !x.plain.length)
  // an unknown slug fails the call: the row shows the error text and no link
  r.unknownNoLink = work.some(x => /no-such-ticket-zz/.test(x.text) && !x.chips.length)
  await page.screenshot('1-rows')
  await page.click({ selector: '.tool-refs .tool-ticket', text: 'rig-smoke-item' })
  await page.waitFor(() => /Rig smoke item/.test(document.body.innerText) && !!document.querySelector('.docket-modal'), { timeout: 20000 })
  await page.sleep(800)
  r.clickOpensTicket = true
  await page.screenshot('2-ticket-open')
  return r
}
