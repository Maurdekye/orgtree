module.exports = async function closeDraftSettings(win, selector, settle) {
  await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector + ' .modalpin-bar')}).dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2, clientX:40, clientY:30 }))`)
  await win.webContents.executeJavaScript(settle)
  await win.webContents.executeJavaScript(`(() => { const item=[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].find(el=>el.textContent.trim()==='Close'); if(!item)throw new Error('Frame Close missing'); item.click() })()`)
  await win.webContents.executeJavaScript(settle)
}
