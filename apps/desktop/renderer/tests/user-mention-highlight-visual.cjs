module.exports = async page => {
  await page.resize('1000x600')
  await page.goto('/')
  await page.waitFor('iframe')
  const panels = await page.eval(async () => {
    const frames = [...document.querySelectorAll('iframe')]
    await Promise.all(frames.map(frame => frame.contentDocument?.readyState === 'complete'
      ? Promise.resolve() : new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))))
    await Promise.all(frames.map(frame => new Promise(resolve => frame.contentWindow.requestAnimationFrame(() => frame.contentWindow.requestAnimationFrame(resolve)))))
    await new Promise(resolve => setTimeout(resolve, 80))
    return frames.map(frame => {
      const doc = frame.contentDocument, win = frame.contentWindow, msg = doc.querySelector('.msg.assistant')
      return { theme: doc.documentElement.classList.contains('contrast-light') ? 'light' : 'dark',
        attention: doc.querySelector('[data-attention]')?.dataset.attention,
        messages: doc.querySelectorAll('.msg.assistant').length,
        layers: doc.querySelectorAll('.mention-highlight').length,
        nested: doc.querySelectorAll('.mention-highlight .mention-highlight, .mention-highlight-line, .ctx-target').length,
        paragraphs: msg?.querySelectorAll('p').length,
        background: msg ? win.getComputedStyle(msg).backgroundColor : null,
        edge: msg ? win.getComputedStyle(msg).boxShadow : null }
    })
  })
  if (panels.length !== 2 || panels.some(p => p.attention !== 'dismissed' || p.messages !== 2 || p.layers !== 1 || p.nested !== 0 || p.paragraphs !== 2 || !p.background || p.background === 'rgba(0, 0, 0, 0)' || p.edge === 'none')) throw new Error('single permanent layer contract '+JSON.stringify(panels))
  await page.screenshot('user-mention-light-dark')
  return panels
}
