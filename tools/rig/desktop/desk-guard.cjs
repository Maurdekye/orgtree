// tools/rig/desktop/desk-guard.cjs: the harness's guards as the page sees
// them (proofs/desk-guard.mjs). Never touches the real clipboard: every
// probe below goes to the stub, the permission layer, or a refusal.
'use strict'
module.exports = async (page) => {
  const facts = await page.eval(async () => {
    const q = async name => { try { return (await navigator.permissions.query({ name })).state } catch (e) { return 'error: ' + e.message } }
    await navigator.clipboard.writeText('rig-desk-guard')
    const audio = new Audio()
    return {
      clipboardRead: await q('clipboard-read'),
      clipboardWrite: await q('clipboard-write'),
      stub: window.__rigClipboardGuard?.installed === true,
      readBack: await navigator.clipboard.readText(),
      stubLast: window.__rigClipboardGuard?.last(),
      execCopy: document.execCommand('copy'),
      execPaste: document.execCommand('paste'),
      audioElementMuted: audio.muted,
    }
  })
  const refused = async fn => { try { await fn(); return false } catch (e) { return /refused/.test(e.message) } }
  facts.pasteKeyRefused = await refused(() => page.press('v', { modifiers: 2 }))
  facts.copyKeyRefused = await refused(() => page.press('c', { modifiers: 2 }))
  facts.grantRefused = await refused(() => page.cdp('Browser.grantPermissions', { permissions: ['clipboardReadWrite'] }))
  facts.plainKeyAllowed = !(await refused(() => page.press('Escape')))
  return facts
}
