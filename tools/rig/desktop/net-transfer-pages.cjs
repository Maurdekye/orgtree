module.exports = async page => {
  await page.waitFor('.sq.orginbox')
  await page.click('.sq.orginbox')
  await page.waitFor('.transfer-card')
  const ids=()=>page.eval(()=>[...document.querySelectorAll('.transfer-card')].map(n=>n.dataset.transferId))
  const first=await ids()
  if(first.length!==100) throw Error('first page not bounded to 100')
  await page.click({selector:'.mail-transfers button',text:'More transfers',scroll:true})
  await page.waitFor(()=>document.querySelector('.mail-transfers')?.textContent.includes('Page 2,'))
  await page.waitFor(`[data-transfer-id="${first[0]}"]`,{gone:true})
  const second=await ids()
  if(second.length!==100 || second.some(id=>first.includes(id))) throw Error('page did not advance')
  await page.screenshot('transfer-second-page')
  await page.click({selector:'.mail-transfers button',text:'Previous transfers',scroll:true})
  await page.waitFor(()=>document.querySelector('.mail-transfers')?.textContent.includes('Page 1,'))
  // Cursor changes update the footer before the request completes.
  await page.waitFor(`[data-transfer-id="${first[0]}"]`)
  return {first:first.length,second:second.length}
}
