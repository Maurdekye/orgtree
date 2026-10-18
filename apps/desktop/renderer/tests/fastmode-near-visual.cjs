module.exports = async page => {
  await page.resize('1000x700'); await page.goto('/')
  await page.waitFor('[data-fixture="idle-on"] .sq')
  await page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r,80)) })
  const geometry=await page.eval(() => {
    const description=document.querySelector('main > p').getBoundingClientRect()
    const first=document.querySelector('[data-fixture] h3').getBoundingClientRect()
    return { separated:first.top>=description.bottom+12 }
  })
  if(!geometry.separated)throw new Error('Fixture heading overlaps card label')
  const value=await page.eval(() => [...document.querySelectorAll('[data-fixture]')].map(section => {
    const badge=section.querySelector('.badge.fast-mode'), r=badge?.getBoundingClientRect()
    return { id:section.dataset.fixture, count:section.querySelectorAll('.badge.fast-mode').length,
      title:badge?.title, icon:!!badge?.querySelector('svg'), text:badge?.textContent,
      inside:!r || (r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight) }
  }))
  for(const row of value) {
    const expected=['idle-on','running-on'].includes(row.id)
    if(row.count!==(expected?1:0)||!row.inside||(expected&&(row.title!=='fast'||!row.icon||row.text)))
      throw new Error('near fast visual mismatch '+JSON.stringify(row))
  }
  await page.screenshot('near-active-fast-badge')
  return value
}
