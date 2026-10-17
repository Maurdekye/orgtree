module.exports = async (page, { org, args }) => {
  await page.waitFor(`[data-copy-agent-name="${args.agent}"]`)
  await page.rightClick(`[data-copy-agent-name="${args.agent}"]`)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.msgs')
  await page.sleep(600)
  await page.cdp('Performance.enable')
  const before = await page.cdp('Performance.getMetrics')
  await page.eval(() => {
    const p = window.__streamProbe = { wire: [], ingest: [], publish: [], paint: [], mutations: 0, frames: 0, stop: false, longTasks: [] }
    const host = document.querySelector('.msgs')
    p.observer = new MutationObserver(records => { p.mutations += records.length })
    p.observer.observe(host, { childList: true, subtree: true, characterData: true })
    p.tasks = new PerformanceObserver(list => p.longTasks.push(...list.getEntries().map(e => ({at:e.startTime,ms:e.duration}))))
    p.tasks.observe({ type: 'longtask', buffered: false })
    let last = ''
    const frame = () => {
      p.frames++
      const text = [...host.querySelectorAll('.draft,.thoughtbody.live')].map(e => e.textContent).join('|')
      if (text !== last) { p.paint.push({at:Date.now(),size:text.length,text}); last = text }
      if (!p.stop) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  const started = Date.now()
  await Promise.all((args.agents || [args.agent]).map(agent => page.api('POST', `/api/orgs/${org}/nodes/${agent}/message`, { text: 'CADENCE-PROOF' })))
  await page.waitFor(() => document.querySelector('.draft')?.textContent.includes('CADENCE_'))
  await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.sleep(60)
  await page.screenshot('streaming')
  await page.waitFor(() => document.querySelector('.msgs')?.textContent.includes('CADENCE_END'))
  await page.waitFor(() => !document.querySelector('.draft') && !document.querySelector('.thoughtbody.live'))
  await page.sleep(300)
  const after = await page.cdp('Performance.getMetrics')
  const result = await page.eval(() => {
    const p = window.__streamProbe; p.stop = true; p.observer.disconnect(); p.tasks.disconnect()
    const { observer, tasks, ...data } = p
    return { ...data, final: document.querySelector('.msgs').textContent }
  })
  await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.sleep(60)
  await page.screenshot('completed')
  return { started, ended: Date.now(), before, after, ...result }
}
