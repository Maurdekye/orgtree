// Page script for netblocks-visual.mjs (tools/rig/desktop driver): the org
// mailbox's blocking states on the synthetic probe (netblocks-probe.tsx).
// Returns what it saw; the runner asserts. No assertions here.
const W=1000,H=760
module.exports=async(page)=>{
  const paint=()=>page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,150))})
  const park=async()=>{await page.mouse('mouseMoved',W-4,H-4);await paint()}
  const servers=async()=>{await page.waitFor('.adv-tab');await page.eval(()=>[...document.querySelectorAll('.adv-tab')].find(b=>/mailservers/.test(b.textContent)).click());await page.waitFor('.oi-net');await paint()}
  // contacts by address (the chips show @net:<address>); the button on a contact's roster line (hub A) or in the blocked contacts list
  const button=(name,where)=>page.eval(([name,where])=>{
    const lines=where==='list'?[...document.querySelectorAll('.oi-net .oi-hub')].filter(h=>/blocked contacts/.test(h.textContent)).flatMap(h=>[...h.querySelectorAll('.oi-peer')])
      :[...document.querySelectorAll('.oi-net .oi-hub')][0]?.querySelectorAll('.oi-peer > span, .oi-peer')??[]
    const line=[...lines].find(l=>l.textContent.includes(name));const b=line&&[...line.querySelectorAll('button.link')].pop()
    return b?b.textContent:null},[name,where])
  const press=(name)=>page.eval(name=>{const hub=[...document.querySelectorAll('.oi-net .oi-hub')][0]
    const line=[...hub.querySelectorAll('.oi-peer > span, .oi-peer')].find(l=>l.textContent.includes(name));[...line.querySelectorAll('button.link')].pop().click()},name)
  const state=()=>page.eval(()=>{
    const hubs=[...document.querySelectorAll('.oi-net .oi-hub')]
    const sign=name=>{const l=[...(hubs[0]?.querySelectorAll('.oi-peer > span, .oi-peer')??[])].find(x=>x.textContent.includes(name));const s=l?.querySelector('.oi-blocked');
      return s?{label:s.getAttribute('aria-label'),color:getComputedStyle(s).color,w:s.getBoundingClientRect().width}:null}
    const list=hubs.find(h=>/blocked contacts/.test(h.textContent))
    return {hubText:hubs.map(h=>h.textContent),alice:sign('alice.fixture'),cy:sign('cy.fixture'),bob:sign('bob.fixture'),
      list:list?[...list.querySelectorAll('.oi-peer')].map(p=>p.textContent):null,
      update:[...document.querySelectorAll('.oi-net .pad-s')].map(e=>e.textContent),err:document.querySelector('.oi-net .oi-stuck')?.textContent??null}
  })
  await page.resize(`${W}x${H}`)
  const r={}
  await servers();await park()
  r.initial={...await state(),aliceButton:await button('alice.fixture'),cyButton:await button('cy.fixture')}
  await page.screenshot('1-servers-blocked-by-and-old-hub')
  await press('alice.fixture');await paint();await park()
  r.asking={...await state(),aliceButton:await button('alice.fixture')}
  await page.screenshot('2-block-sure')
  await press('alice.fixture');await page.waitFor('.oi-net .oi-blocked[aria-label="blocked"]');await paint();await park()
  r.blocked={...await state(),aliceButton:await button('alice.fixture'),listButton:await button('alice.fixture','list')}
  await page.screenshot('3-blocked-sign-unblock-and-list')
  await page.eval(()=>window.__blocks.show('o1'));await page.waitFor('.net-state.stuck');await paint();await park()
  r.refused=await page.eval(()=>{const s=document.querySelector('.net-state.stuck');const row=s.closest('[class*="row"]')||s.parentElement
    return {label:s.getAttribute('aria-label'),title:s.getAttribute('title'),color:getComputedStyle(s).color,svg:!!s.querySelector('svg'),row:row?.textContent}})
  await page.screenshot('4-refused-message')
  await page.eval(()=>window.__blocks.show(null));await servers()
  await press('alice.fixture');await page.waitFor('.oi-net .oi-blocked[aria-label="blocked"]',{gone:true});await paint();await park()
  r.unblocked={...await state(),aliceButton:await button('alice.fixture')}
  await page.screenshot('5-unblocked')
  r.calls=await page.eval(()=>window.__blocks.calls.filter(c=>c.url.endsWith('/net/blocks')))
  return r
}
