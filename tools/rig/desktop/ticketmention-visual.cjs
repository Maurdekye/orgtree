// Ticket Mention captures (mention-entry-on-ticket-cards-in-transcripts-ins):
// in an agent desk, the transcript's ticket chip right-clicked (the shared
// ticket menu, Mention first), the message box after Mention, and the @ list
// with tickets beside agents. Dark and light. Offscreen does not select Session 0;
// the window inherits the launching turn's session. Run only in Session 0 or on a
// never-switched private desktop, with isolated/empty clipboard, clipboard
// permissions denied and owned-window CDP/PostMessage only (no OS input). Record
// child window SessionId and clipboard-denial state in every capture receipt.
// Wait two animation frames and a pause before every capture.
// The menu is opened with the events the renderer reads (pointerdown on the
// right button, then contextmenu), at the chip's centre.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 660, height: 580, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (test, what) => js(`new Promise((resolve,reject)=>{
    const found=()=>{try{return (${test})()}catch{return false}};
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe missing: '+${JSON.stringify(what)}))},8000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async (name) => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const DESK = '[data-fixture="agent-desk"]'
  const CHIP = `${DESK} [data-transcript-row] [data-object-nav="ticket"]`
  const BOX = `${DESK} fieldset.desk-control-scope textarea`
  /** the top menu's own items, as drawn */
  const menuLabels = `(()=>{const m=document.querySelector('.ctxmenu:not(.ctxmenu-submenu)');if(!m)return [];
    return [...m.querySelectorAll('[role="menuitem"]')].filter(b=>b.closest('[role="menu"]')===m)
      .map(b=>b.textContent.replace('▸','').trim())})()`
  const setBox = (value, focus) => js(`(()=>{const box=document.querySelector(${JSON.stringify(BOX)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,${JSON.stringify(value)});
    box.dispatchEvent(new Event('input',{bubbles:true}));
    if(${focus}){box.focus();box.setSelectionRange(box.value.length,box.value.length);box.dispatchEvent(new Event('select',{bubbles:true}))}
    else box.blur();return box.value})()`)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait(`()=>document.querySelector(${JSON.stringify(CHIP)})`, 'transcript ticket chip')
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await js(`window.ticketMentionVisual.contrast(${light})`)
      await setBox('', false)
      await settle()
      // 1. the shared ticket menu on the transcript chip
      await js(`(()=>{const chip=document.querySelector(${JSON.stringify(CHIP)});const r=chip.getBoundingClientRect();
        const at={bubbles:true,cancelable:true,button:2,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2)};
        chip.dispatchEvent(new PointerEvent('pointerdown',at));chip.dispatchEvent(new MouseEvent('mousedown',at));
        chip.dispatchEvent(new MouseEvent('contextmenu',at))})()`)
      await wait(`()=>${menuLabels}.includes('Open details')`, 'resolved ticket menu')
      const menu = await js(menuLabels)
      await shot(`${theme}-ticket-menu`)
      // 2. Mention puts the reference in this desk's message box
      await js(`(()=>{const m=document.querySelector('.ctxmenu:not(.ctxmenu-submenu)');
        const b=[...m.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent.trim()==='Mention');
        b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));b.click()})()`)
      await wait(`()=>!document.querySelector('.ctxmenu')`, 'menu closed')
      const inserted = await js(`document.querySelector(${JSON.stringify(BOX)}).value`)
      const focused = await js(`document.activeElement===document.querySelector(${JSON.stringify(BOX)})`)
      await shot(`${theme}-mention-inserted`)
      // 3. the @ list: tickets arrive from the docket's search and join the agents
      await setBox('Please pick up @b', true)
      await wait(`()=>document.querySelectorAll('.agent-mentions .mention-ticket').length>=3`, 'ticket rows in the @ list')
      const list = await js(`[...document.querySelectorAll('.agent-mentions .agent-mention-item')].map(row=>{
        const icon=row.querySelector('.mention-ticket-mark svg, .tier, .project-mark');const r=icon?icon.getBoundingClientRect():null;
        return {name:row.querySelector('.agent-mention-name').textContent,ticket:row.classList.contains('mention-ticket'),
          active:row.getAttribute('aria-selected')==='true',icon:r?Math.round(r.width)+'x'+Math.round(r.height):null,
          tooltip:row.getAttribute('data-object-tooltip-kind')}})`)
      await shot(`${theme}-completion`)
      await js(`document.querySelector(${JSON.stringify(BOX)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
      checks.push({ theme, menu, inserted, focused, list })
    }
    const passed = checks.every(({ menu, inserted, focused, list }) =>
      menu[0] === 'Mention' && menu[1] === 'Reply' && menu[2] === 'Open details'
      && inserted === '@item:org/build-the-docs ' && focused
      // the transcript's ticket sits nearest the box, highlighted; the agents and the other tickets above it
      && list.at(-1)?.name === 'build-the-docs' && list.at(-1)?.active
      && ['@boss', '@bram'].every(name => list.some(row => row.name === name && !row.ticket))
      && ['backlog-cleanup', 'review-the-docs'].every(name => list.some(row => row.name === name && row.ticket))
      && list.filter(row => row.ticket).every(row => row.tooltip === 'ticket' && row.icon && row.icon !== '0x0'))
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    console.log(JSON.stringify({ passed }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
