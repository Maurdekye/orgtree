module.exports = async page => {
  await page.resize('1000x700')
  const screenshots = [], details = {}
  const settle = () => page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, 300))))
  })
  const inspect = () => page.eval(() => ({
    cards: [...document.querySelectorAll('.sq.project')].map(e => ({
      name: e.getAttribute('data-copy-agent-name'), x: e.getBoundingClientRect().x, y: e.getBoundingClientRect().y,
      w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height,
      mini: !!e.querySelector('.project-mini'),
    })),
    lines: [...document.querySelectorAll('.project-bunch-edge')].map(e => e.getAttribute('d')),
    receipt: window.bunchReceipt,
  }))
  for (const scene of ['two', 'three', 'five', 'eight', 'two-off', 'three-off', 'siblings', 'split',
    'agent-break', 'circular', 'far', 'insert-project', 'insert-agent', 'insert-split', 'reorder', 'settings']) {
    await page.goto('/?scene=' + scene)
    await page.waitFor(scene === 'settings' ? 'input[aria-label="bunch consecutive projects"]' : '.sq.project')
    await page.eval(async () => { await new Promise(resolve => setTimeout(resolve, 1500)) })
    if (scene.startsWith('insert-')) {
      await page.eval(() => document.querySelector('#insert').click())
      await page.eval(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
    }
    if (scene === 'settings') await page.eval(() => document.querySelector('input[aria-label="bunch consecutive projects"]').scrollIntoView({ block: 'center' }))
    if (scene === 'reorder') {
      await page.eval(async () => {
        const card = document.querySelector('[data-copy-agent-name="project-1"]')
        const start = card.getBoundingClientRect()
        const end = document.querySelector('[data-copy-agent-name="project-3"]').getBoundingClientRect()
        // Synthetic pointer capture is unsupported; the events are delivered to
        // the exact pressed card just as capture would deliver real events.
        card.setPointerCapture = () => {}
        const fire = (type, x, y) => card.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, clientX: x, clientY: y }))
        fire('pointerdown', start.x + start.width / 2, start.y + start.height / 2)
        fire('pointermove', end.right - end.width / 5, end.y + end.height / 2)
        await new Promise(resolve => setTimeout(resolve, 40))
        fire('pointerup', end.right - end.width / 5, end.y + end.height / 2)
        await new Promise(resolve => setTimeout(resolve, 1200))
      })
    }
    await settle()
    details[scene] = await inspect()
    const expected = { two: 1, three: 2, five: 4, eight: 7, 'two-off': 0, 'three-off': 0,
      siblings: 0, split: 3, 'agent-break': 2, circular: 4, far: 4,
      'insert-project': 2, 'insert-agent': 2, 'insert-split': 1, reorder: 2 }
    if (scene !== 'settings' && details[scene].lines.length !== expected[scene])
      throw new Error(`${scene}: ${details[scene].lines.length} order lines, want ${expected[scene]}`)
    if (scene === 'reorder') {
      const parents = new Map(details[scene].receipt.parents)
      if (parents.get('project-2') !== null || parents.get('project-1') !== 'project-3')
        throw new Error('Reorder did not rotate the project chain')
    }
    if (scene === 'far' && !details[scene].cards.every(c => c.mini)) throw new Error('Far-zoom scene did not reach mini LOD')
    screenshots.push(await page.screenshot('project-bunch-' + scene))
    if (scene === 'eight') {
      await page.eval(() => document.querySelector('.viewport').dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: 500, clientY: 400, deltaY: -350,
      })))
      await settle()
      details['eight-detail'] = await inspect()
      if (details['eight-detail'].cards.some(c => c.mini)) throw new Error('Eight-project detail remained at mini LOD')
      screenshots.push(await page.screenshot('project-bunch-eight-detail'))
    }
  }
  return { details, screenshots }
}
