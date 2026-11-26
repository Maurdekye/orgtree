// Page script for netblocks-visual.mjs (tools/rig/desktop driver): the org
// mailbox's blocking states on the synthetic probe (netblocks-probe.tsx).
// Returns what it saw; the runner asserts. No assertions here.
const W=1000,H=760
module.exports=async(page)=>{
  const paint=()=>page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,150))})
  const park=async()=>{await page.mouse('mouseMoved',W-4,H-4);await paint()}
  const servers=async()=>{await page.waitFor('.adv-tab');await page.eval(()=>[...document.querySelectorAll('.adv-tab')].find(b=>/mailservers/.test(b.textContent)).click());await page.waitFor('.oi-net');await paint()}
  // contacts by address (the chips show @net:<address>); the control on a contact's row in hub A's list (the shared
  // ConnectionList: the red × or unblock) or in the blocked contacts list
  const button=(name,where)=>page.eval(([name,where])=>{
    const lines=where==='list'?[...document.querySelectorAll('.oi-net .oi-hub')].filter(h=>/blocked contacts/.test(h.textContent)).flatMap(h=>[...h.querySelectorAll('.oi-peer')])
      :[...document.querySelectorAll('.oi-net > .oi-hub')][0]?.querySelectorAll('.conn-row')??[]
    const line=[...lines].find(l=>l.textContent.includes(name));const b=line&&[...line.querySelectorAll('button.link, button.conn-x')].pop()
    return b?(b.querySelector('svg[data-testid="BlockIcon"].oi-blocked')?'blocked sign':b.textContent):null},[name,where])
  const press=(name)=>page.eval(name=>{const hub=[...document.querySelectorAll('.oi-net > .oi-hub')][0]
    const line=[...hub.querySelectorAll('.conn-row')].find(l=>l.textContent.includes(name));[...line.querySelectorAll('button.link, button.conn-x')].pop().click()},name)
  const xLook=(name)=>page.eval(name=>{const hub=[...document.querySelectorAll('.oi-net > .oi-hub')][0]
    const x=[...hub.querySelectorAll('.conn-row')].find(l=>l.textContent.includes(name))?.querySelector('button.conn-x');if(!x)return null
    const r=x.getBoundingClientRect(),row=x.closest('.conn-row').getBoundingClientRect()
    const i=x.querySelector('svg')?.getBoundingClientRect()
    return {title:x.title,color:getComputedStyle(x).color,w:r.width,h:r.height,rightGap:row.right-r.right,iconW:i?.width??0,iconH:i?.height??0,iconColor:x.querySelector('svg')?getComputedStyle(x.querySelector('svg')).color:null}},name)
  const state=()=>page.eval(()=>{
    const hubs=[...document.querySelectorAll('.oi-net > .oi-hub')]
    const sign=name=>{const l=[...(hubs[0]?.querySelectorAll('.conn-row')??[])].find(x=>x.textContent.includes(name));const s=l?.querySelector('.oi-blocked[role="img"]');
      return s?{label:s.getAttribute('aria-label'),color:getComputedStyle(s).color,w:s.getBoundingClientRect().width,h:s.getBoundingClientRect().height}:null}
    const list=hubs.find(h=>/blocked contacts/.test(h.textContent))
    return {hubText:hubs.map(h=>h.textContent),alice:sign('alice.fixture'),cy:sign('cy.fixture'),bob:sign('bob.fixture'),
      list:list?[...list.querySelectorAll('.oi-peer')].map(p=>p.textContent):null,
      update:[...document.querySelectorAll('.oi-net .pad-s')].map(e=>e.textContent),err:document.querySelector('.oi-net .oi-stuck')?.textContent??null}
  })
  await page.resize(`${W}x${H}`)
  const r={}
  await servers();await park()
  r.initial={...await state(),aliceButton:await button('alice.fixture'),cyButton:await button('cy.fixture'),aliceX:await xLook('alice.fixture')}
  await page.screenshot('1-servers-blocked-by-and-old-hub')
  await page.eval(()=>{const hub=[...document.querySelectorAll('.oi-net > .oi-hub')][0];const row=[...hub.querySelectorAll('.conn-row')].find(l=>l.textContent.includes('alice.fixture'));row.scrollIntoView({block:'center'})})
  const xr=await page.eval(()=>{const hub=[...document.querySelectorAll('.oi-net > .oi-hub')][0];const x=[...hub.querySelectorAll('.conn-row')].find(l=>l.textContent.includes('alice.fixture')).querySelector('.conn-x').getBoundingClientRect();return [x.left+x.width/2,x.top+x.height/2]})
  await page.mouse('mouseMoved',xr[0],xr[1]);await paint()
  r.hoverX=await xLook('alice.fixture')
  await page.screenshot('2-block-x-hover')
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
  // the lockdown list (LIST UX REDESIGN, USER 2026-11-25 21:48-21:51Z): the shared list under its hub, × takes off, Add searches
  const lock=()=>page.eval(()=>{const l=document.querySelector('.oi-lockdown .oi-lock-list');if(!l)return null
    l.scrollIntoView({block:'start'})
    return {rows:[...l.querySelectorAll('.conn-row')].map(r=>({address:r.querySelector('[data-hub-address]')?.getAttribute('data-hub-address'),
      x:r.querySelector('button.conn-x')?.title??null,blocked:!!r.querySelector('.oi-blocked[role="img"]')})),
      sharedList:!!l.querySelector('.conn-rows[role="list"]'),addressBox:!!document.querySelector('.oi-lockdown input[aria-label="Address to allow"]'),
      allowLinks:[...document.querySelectorAll('.oi-net button')].filter(b=>/^(allow|unlist)$/.test(b.textContent)).length}})
  r.lockList=await lock();await paint();await park()
  await page.screenshot('6-lockdown-list')
  await page.eval(()=>[...document.querySelectorAll('.oi-lockdown button')].find(b=>b.textContent==='Add').click());await page.waitFor('.oi-lock-add');await paint()
  const options=()=>page.eval(()=>[...document.querySelectorAll('.oi-lock-add [role="option"]')].map(o=>o.dataset.address))
  r.addAll=await options()
  await page.screenshot('7-lockdown-add-dropdown')
  await page.eval(()=>{const i=document.querySelector('.oi-lock-add input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set
    i.focus();set.call(i,'ali');i.dispatchEvent(new Event('input',{bubbles:true}))});await paint()
  r.addSearch=await options()
  await page.screenshot('8-lockdown-add-search')
  await page.eval(()=>document.querySelector('.oi-lock-add [role="option"]').click());await page.waitFor('.oi-lock-add',{gone:true})
  await page.waitFor('.oi-lock-list [data-hub-address="@net:alice.fixture.aa0011"]');await paint();await park()
  r.lockAdded=await lock()
  await page.screenshot('9-lockdown-added')
  await page.eval(()=>[...document.querySelectorAll('.oi-lock-list .conn-row')].find(r=>r.textContent.includes('gone.fixture')).querySelector('button.conn-x').click())
  await page.waitFor('.oi-lock-list [data-hub-address="@net:gone.fixture.ee0055"]',{gone:true});await paint();await park()
  r.lockRemoved=await lock()
  await page.screenshot('10-lockdown-removed')
  r.lockCalls=await page.eval(()=>window.__blocks.calls.filter(c=>c.url.endsWith('/net/lockdown')&&c.method==='POST').map(c=>c.body))
  r.calls=await page.eval(()=>window.__blocks.calls.filter(c=>c.url.endsWith('/net/blocks')))
  // point 13 (USER 2026-11-26 md10751788f2e "this ui is ugly, clean it up") on both surfaces, point 10 (the list under
  // the settings Lockdown dropdown): lockdown on with 0 and with 3 listed, set-aside on with mail
  const section=()=>page.eval(()=>{const s=document.querySelector('.oi-lockdown');if(!s)return null
    s.scrollIntoView({block:'start'});const box=s.getBoundingClientRect()
    return {chip:s.querySelector('.lk-head .lk-chip')?.textContent??null,headButtons:[...s.querySelectorAll('.lk-head button')].map(b=>b.textContent),
      hubs:[...s.querySelectorAll('.lk-hub')].map(h=>h.textContent),listHead:s.querySelector('.oi-lock-list-head')?.textContent??null,
      empty:s.querySelector('.lk-frame .lk-empty')?.textContent??null,rows:[...s.querySelectorAll('.oi-lock-list .conn-row [data-hub-address]')].map(c=>c.getAttribute('data-hub-address')),
      toggle:s.querySelector('input[role="switch"]')?.getAttribute('aria-label')??null,toggleOn:!!s.querySelector('input[role="switch"]')?.checked,
      setAsideButton:[...s.querySelectorAll('button')].map(b=>b.textContent).find(t=>/set-aside mail/i.test(t))??null,
      underDropdown:!!s.closest('.org-lockdown-list'),w:box.width,h:box.height}})
  const servers2=async()=>{await page.eval(()=>window.__blocks.show(null));await servers();await park()}
  await page.eval(()=>{window.__blocks.lock({allow:[],pending:true,set_aside:false});window.__blocks.letters(0)});await servers2()
  r.secEmpty=await section();await page.screenshot('11-section-on-empty')
  await page.eval(()=>{window.__blocks.lock({allow:[window.__blocks.ALICE,window.__blocks.DEE,window.__blocks.GONE],pending:false,set_aside:true});window.__blocks.letters(2)});await servers2()
  r.secThree=await section();await page.screenshot('12-section-three-setaside')
  await page.eval(()=>[...document.querySelectorAll('.oi-lockdown button')].find(b=>/^Show set-aside mail/.test(b.textContent)).click());await paint()
  r.setAsideShown=await page.eval(()=>[...document.querySelectorAll('.oi-lockdown .oi-peer')].map(p=>p.textContent))
  await page.screenshot('13-section-setaside-shown')
  // settings: Org decides with the org off shows no list; On shows it at once
  const settings=async()=>{await page.eval(()=>window.__blocks.show('settings'));await page.waitFor('select[aria-label="Org mailbox lockdown"]');await paint();await park()}
  await page.eval(()=>{window.__blocks.lock({setting:'org',org_on:false,allow:[],set_aside:false});window.__blocks.letters(0)});await settings()
  r.setOff=await section();await page.screenshot('14-settings-org-decides-off')
  await page.eval(()=>{const s=document.querySelector('select[aria-label="Org mailbox lockdown"]');const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set
    set.call(s,'on');s.dispatchEvent(new Event('change',{bubbles:true}))});await page.waitFor('.org-lockdown-list .oi-lockdown');await paint();await park()
  r.setOnEmpty=await section();await page.screenshot('15-settings-on-empty')
  await page.eval(()=>window.__blocks.lock({allow:[window.__blocks.ALICE,window.__blocks.DEE,window.__blocks.GONE]}));await settings()
  r.setThree=await section();await page.screenshot('16-settings-on-three')
  await page.eval(()=>[...document.querySelectorAll('.org-lockdown-list button')].find(b=>b.textContent==='Add').click());await page.waitFor('.org-lockdown-list .oi-lock-add');await paint()
  r.setAdd=await page.eval(()=>[...document.querySelectorAll('.org-lockdown-list .oi-lock-add [role="option"]')].map(o=>o.dataset.address))
  await page.screenshot('17-settings-add-dropdown')
  return r
}
