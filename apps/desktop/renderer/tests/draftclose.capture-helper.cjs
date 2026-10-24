const assert = require('node:assert/strict')

/** Actual Chromium pointer input, never dispatchEvent/.click on an invisible bar. */
module.exports = async function closeDraftSettings(win, selector, settle) {
  const target = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector(${JSON.stringify(selector + ' .modalpin-bar .modalpin-x')});
    if (!button) throw new Error('Draft header close button missing');
    const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    const style = getComputedStyle(button);
    window.__draftCloseTrusted = null;
    button.addEventListener('click', event => { window.__draftCloseTrusted = event.isTrusted }, {once:true});
    return {x,y,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,
      viewport:{width:innerWidth,height:innerHeight},hit:button.contains(document.elementFromPoint(x,y)),
      visible:style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0};
  })()`)
  assert(target.width > 0 && target.height > 0 && target.visible, 'visible nonzero close target')
  assert(target.left >= 0 && target.top >= 0 && target.right <= target.viewport.width && target.bottom <= target.viewport.height, 'close target stays on screen')
  assert(target.hit, 'close target wins hit-testing')
  const debug = win.webContents.debugger
  const attach = !debug.isAttached()
  if (attach) debug.attach('1.3')
  try {
    await debug.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',x:target.x,y:target.y})
    await debug.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1})
    await debug.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1})
  } finally { if (attach) debug.detach() }
  await win.webContents.executeJavaScript(settle)
  const trusted = await win.webContents.executeJavaScript('window.__draftCloseTrusted')
  assert.equal(trusted, true, 'close received a trusted pointer click')
  return {...target,input:'CDP Input.dispatchMouseEvent',trusted}
}
