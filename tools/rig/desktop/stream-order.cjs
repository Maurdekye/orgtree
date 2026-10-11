module.exports = async (page, { org, args }) => {
  await page.waitFor(`[data-copy-agent-name="${args.agent}"]`)
  await page.rightClick(`[data-copy-agent-name="${args.agent}"]`)
  await page.click({ selector: 'button.ctxmenu-item', text: 'Focus' })
  await page.waitFor('.msgs')
  await page.sleep(600)
  await page.eval(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (String(args[0]).includes('/chat')) await new Promise(resolve => setTimeout(resolve, 2500))
      return response
    }
    window.orderBadFrames = []
    window.orderSampling = true
    let seenFirst = false
    const tick = () => {
      const text = document.querySelector('.msgs')?.innerText || ''
      const first = text.indexOf('ORDER_FIRST_REPLY'), second = text.indexOf('ORDER_SECOND_REPLY'), tool = text.indexOf('ORDER_TOOL')
      const count = token => text.split(token).length - 1
      seenFirst ||= first >= 0
      if (count('ORDER_FIRST_REPLY') > 1 || count('ORDER_SECOND_REPLY') > 1
          || (seenFirst && first < 0 && (tool >= 0 || second >= 0 || text.includes('THOUGHT_ONE')))
          || (first >= 0 && ((tool >= 0 && tool < first) || (second >= 0 && second < first)))) {
        if (window.orderBadFrames.length < 20) window.orderBadFrames.push(text)
      }
      if (window.orderSampling) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.eval(async ({ org }) => {
    window.orderWire = { tokens: 0, commits: 0, badTokens: 0 }
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/orgs/${org}/ws`)
    window.orderSocket = socket
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      if (frame.type !== 'node_stream') return
      if (['delta', 'thinking'].includes(frame.kind)) {
        window.orderWire.tokens++
        if ('convo_rows' in frame || 'draft_clear' in frame || 'thinking_clear' in frame) window.orderWire.badTokens++
      } else if (frame.convo_rows?.length) window.orderWire.commits++
    })
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  }, { org })
  await page.api('POST', `/api/orgs/${org}/nodes/${args.agent}/message`, { text: 'ORDER-PROOF' })
  await page.waitFor(() => document.querySelector('.draft')?.textContent.includes('ORDER_FIRST_REPLY'))
  await page.screenshot('first-live')
  let liveThought = null
  if (!args.direct) {
    await page.waitFor(() => [...document.querySelectorAll('.thoughtbody.live')].some(e => e.textContent.includes('THREE')))
    liveThought = await page.eval(() => {
      const thought = [...document.querySelectorAll('.thoughtbody.live')].find(e => e.textContent.includes('THREE'))
      const first = [...document.querySelectorAll('.msgtext,.draft')].find(e => e.textContent.includes('ORDER_FIRST_REPLY'))
      const style = getComputedStyle(thought)
      return { firstBeforeThought: !!first && !!(first.compareDocumentPosition(thought) & Node.DOCUMENT_POSITION_FOLLOWING),
        metrics: { html: thought.innerHTML, height: thought.offsetHeight, lineHeight: style.lineHeight,
          whiteSpace: style.whiteSpace, paragraphs: [...thought.querySelectorAll('p')].map(p => ({ height: p.offsetHeight, space: getComputedStyle(p).whiteSpace })) } }
    })
    await page.screenshot('thought-live')
  }
  await page.waitFor(() => document.querySelector('.draft')?.textContent.includes('ORDER_SECOND_REPLY'))
  const readOrder = () => {
    const text = document.querySelector('.msgs').innerText
    const first = text.indexOf('ORDER_FIRST_REPLY'), tool = text.indexOf('ORDER_TOOL'), second = text.indexOf('ORDER_SECOND_REPLY')
    return { ordered: first >= 0 && tool > first && second > tool,
      firstCount: text.split('ORDER_FIRST_REPLY').length - 1,
      secondCount: text.split('ORDER_SECOND_REPLY').length - 1, text }
  }
  const liveSecond = await page.eval(readOrder)
  await page.screenshot('tool-and-second-live')
  await page.waitFor(() => !document.querySelector('.draft') && [...document.querySelectorAll('.msgtext')].some(e => e.textContent.includes('ORDER_SECOND_REPLY')))
  await page.sleep(3500)
  const final = await page.eval(readOrder)
  let finalThought = null
  if (!args.direct) {
    await page.click('.thoughtline:not(.sealed)')
    await page.waitFor('.thoughtbody:not(.live)')
    finalThought = await page.eval(() => {
      const thought = [...document.querySelectorAll('.thoughtbody:not(.live)')].find(e => e.textContent.includes('THREE'))
      const style = getComputedStyle(thought)
      return { html: thought.innerHTML, height: thought.offsetHeight, lineHeight: style.lineHeight,
        whiteSpace: style.whiteSpace, paragraphs: [...thought.querySelectorAll('p')].map(p => ({ height: p.offsetHeight, space: getComputedStyle(p).whiteSpace })) }
    })
  }
  await page.screenshot('final')
  const badFrames = await page.eval(() => { window.orderSampling = false; return window.orderBadFrames })
  const wire = await page.eval(() => { window.orderSocket.close(); return window.orderWire })
  return { liveThought, liveSecond, final, finalThought, badFrames, wire }
}
