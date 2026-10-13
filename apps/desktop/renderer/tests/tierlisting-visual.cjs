// Runs inside the rig's offscreen Electron (tierlisting-visual.mjs starts it): photographs the real hire sheet and
// the OpenRouter favourites row, and returns the order of every list it found so the picture can be checked.
module.exports = async page => {
  const results = {}
  await page.resize('900x900')
  await page.goto('/?view=hire')
  await page.waitFor('.hs-tiers')
  results.hire = await page.eval(() => ({
    rows: [...document.querySelectorAll('.hs-tiers')].map(r => [...r.querySelectorAll('.hs-tier')].map(b => (b.className.match(/\bt-([\w-]+)/) || [])[1])),
    labels: [...document.querySelectorAll('.hs-tiers')].map(r => [...r.querySelectorAll('.hs-tier')].map(b => b.innerText.replace(/\s+/g, ' ').trim())),
    preselected: [...document.querySelectorAll('.hs-tier.on')].map(b => (b.className.match(/\bt-([\w-]+)/) || [])[1]),
  }))
  await page.screenshot('hire-sheet')
  await page.goto('/?view=openrouter')
  await page.waitFor('.orr-favs .orr-tog')
  results.openrouter = await page.eval(() => ({
    chips: [...document.querySelectorAll('.orr-favs .orr-tog')].map(c => c.querySelector('.orr-sel-name')?.textContent || c.getAttribute('aria-label')),
  }))
  await page.screenshot('openrouter-favourites')
  return results
}
