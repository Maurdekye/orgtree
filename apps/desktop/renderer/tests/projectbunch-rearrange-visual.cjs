module.exports = async page => {
  await page.resize('1000x700')
  const screenshots = [], details = {}
  const settle = () => page.eval(async () => {
    await new Promise(resolve => requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, 300))))
  })
  const capture = async name => { await settle(); screenshots.push(await page.screenshot(name)) }
  await page.goto('/?scene=settings')
  await page.waitFor('input[aria-label="Rearrange projects in a bunch"]')
  details.settings = await page.eval(() => {
    const on = document.querySelector('input[aria-label="Bunch consecutive projects"]')
    const reorder = document.querySelector('input[aria-label="Rearrange projects in a bunch"]')
    reorder.scrollIntoView({ block: 'center' })
    return { bunching: on.checked, rearranging: reorder.checked }
  })
  if (!details.settings.bunching || details.settings.rearranging) throw new Error('Wrong default settings')
  await capture('bunch-rearrange-setting-default')
  await page.eval(() => document.querySelector('input[aria-label="Rearrange projects in a bunch"]').click())
  details.optIn = await page.eval(() => localStorage.getItem('orgtree-project-bunch-rearrange'))
  if (details.optIn !== '1') throw new Error('App setting did not persist opt-in')
  await capture('bunch-rearrange-setting-on')
  for (const enabled of [false, true]) {
    const scene = enabled ? 'rearrange-on' : 'rearrange-off'
    await page.goto('/?scene=' + scene)
    await page.waitFor('.sq.project')
    await page.eval(async () => { await new Promise(resolve => setTimeout(resolve, 1500)) })
    await page.eval(() => {
      const card = document.querySelector('[data-copy-agent-name="project-1"]')
      const start = card.getBoundingClientRect()
      const end = document.querySelector('[data-copy-agent-name="project-3"]').getBoundingClientRect()
      const previous = document.querySelector('[data-copy-agent-name="project-2"]').getBoundingClientRect()
      const dx = end.x - previous.x, dy = end.y - previous.y
      const scale = end.width * .32 / Math.max(Math.abs(dx), Math.abs(dy))
      const x = end.x + end.width / 2 + dx * scale, y = end.y + end.height / 2 + dy * scale
      card.setPointerCapture = () => {}
      const fire = (type, px, py) => card.dispatchEvent(new PointerEvent(type, {
        bubbles: true, button: 0, pointerId: 7, clientX: px, clientY: py,
      }))
      window.finishBunchDrag = () => fire('pointerup', x, y)
      fire('pointerdown', start.x + start.width / 2, start.y + start.height / 2)
      fire('pointermove', x, y)
    })
    await settle()
    details[scene] = await page.eval(() => ({
      insertion: !!document.querySelector('[data-project-bunch-insert]'),
      lines: document.querySelectorAll('.project-bunch-edge').length,
    }))
    if (details[scene].insertion !== enabled || details[scene].lines !== 2)
      throw new Error('Wrong insertion marker or changed bunch layout')
    await capture('bunch-' + scene + '-drag')
    await page.eval(async () => {
      window.finishBunchDrag()
      await new Promise(resolve => setTimeout(resolve, 1200))
    })
    details[scene].result = await page.eval(() => window.bunchReceipt)
    const result = details[scene].result, parents = new Map(result.parents)
    if (enabled) {
      if (result.steps.length !== 1 || parents.get('project-1') !== 'project-3' || parents.get('project-2') !== null)
        throw new Error('Opt-in drag did not rotate the bunch')
      await capture('bunch-rearrange-on-result')
    } else if (result.steps.length || parents.get('project-1') !== null || parents.get('project-3') !== 'project-2') {
      throw new Error('Default-off drag changed the project chain')
    }
  }
  return { details, screenshots }
}
