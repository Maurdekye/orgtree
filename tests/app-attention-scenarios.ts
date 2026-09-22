/** User-visible composition checks. All state changes go through the shipping
 * App's controls; the fixture only supplies canned HTTP and native windows.
 * DOM references distinguish retained canonical desks from recreated copies. */
import type { AppScenarioContext } from './app-composition.probe'

export async function runAttentionScenarios(ctx: AppScenarioContext): Promise<void> {
  const r = await ctx.create('attention', 'studio')
  const js = <T = any>(source: string) => ctx.eval<T>(r, source)
  const ready = async (source: string) => {
    const value = await ctx.until(() => js<boolean>(source), Boolean, 10000)
    if (!value) throw new Error('Attention scenario prerequisite failed: ' + source)
  }
  const click = async (selector: string) => {
    await ready(`!!document.querySelector(${JSON.stringify(selector)})`)
    await js(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  }
  const mode = async (label: string) => {
    await js(`Array.from(document.querySelectorAll('.shell-mode')).find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})).click(); true`)
    await ready(`document.querySelector('.shell-mode[aria-checked="true"]').textContent.trim().startsWith(${JSON.stringify(label)})`)
  }
  const menu = async (label: string) => {
    await js(`document.querySelector('[data-attn-agent="beta"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:300,clientY:180})); true`)
    await ready(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(e => e.textContent.trim() === ${JSON.stringify(label)})`)
    await js(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e => e.textContent.trim() === ${JSON.stringify(label)}).click(); true`)
  }
  try {
    await ready(`document.querySelectorAll('.shell-mode').length === 2`)
    await mode('Attention')
    await ready(`!!document.querySelector('.attn-desk textarea')`)
    const initial = await js(`(() => {
      const stage = document.querySelector('.attn-stage');
      const world = document.querySelector('.canvas-world-hidden');
      return {active: stage?.dataset.attentionActive, hidden: world && getComputedStyle(world).visibility,
        selected: document.querySelector('[data-attn-agent][aria-selected="true"]')?.dataset.attnAgent,
        composer: document.querySelector('.attn-desk textarea')?.placeholder,
        queue: !!document.querySelector('.attn-panel-queue'),
        collapsed: !document.querySelector('.attn-agents-wrap')?.classList.contains('list-open')};
    })()`)
    ctx.check('AT1', initial.active === 'yes' && initial.hidden === 'hidden' && initial.queue,
      'The real App presents Attention and hides embedded Canvas content', initial)
    ctx.check('AT2', initial.selected === 'agent' && initial.composer?.startsWith('message agent'),
      'The leftmost root agent supplies the real default Desk', initial)
    ctx.check('AT3', initial.collapsed, 'The agents list starts collapsed', initial)

    const splitBefore = await js<number>(`document.querySelector('.attn-slot-queue').getBoundingClientRect().width`)
    await js(`document.querySelector('.attn-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); true`)
    await ready(`document.querySelector('.attn-slot-queue').getBoundingClientRect().width > ${splitBefore}`)
    const splitAfter = await js<number>(`document.querySelector('.attn-slot-queue').getBoundingClientRect().width`)
    ctx.check('AT4', splitAfter > splitBefore, 'Keyboard divider resize changes actual layout width', {splitBefore, splitAfter})

    const widthBefore = await js<number>(`document.querySelector('.attn-desk').getBoundingClientRect().width`)
    await click('.attn-agents-toggle')
    const widthAfter = await js<number>(`document.querySelector('.attn-desk').getBoundingClientRect().width`)
    ctx.check('AT5', Math.abs(widthBefore - widthAfter) < 1,
      'Expanding the agents list overlays the Desk without reducing its width', {widthBefore, widthAfter})
    await click('[data-attn-agent="beta"]')
    await ready(`document.querySelector('.attn-desk textarea')?.placeholder.startsWith('message beta')`)
    await js(`(() => { const t = document.querySelector('.attn-desk textarea');
      window.__proofDesk = t;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'draft survives every surface');
      t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`)
    await menu('Pin desk as a window')
    await ready(`!!document.querySelector('.pinwin[data-id="beta"] textarea')`)
    const pinned = await js(`({same:document.querySelector('.pinwin[data-id="beta"] textarea') === window.__proofDesk,
      draft:document.querySelector('.pinwin[data-id="beta"] textarea')?.value,
      elsewhere:document.querySelector('.attn-desk')?.textContent.includes('open elsewhere')})`)
    ctx.check('AT6', pinned.same && pinned.draft === 'draft survives every surface' && pinned.elsewhere,
      'A visible Canvas pin keeps the canonical Desk and Attention shows open-elsewhere controls', pinned)

    await mode('Canvas')
    await ready(`document.querySelector('.attn-stage')?.dataset.attentionActive === 'no'`)
    ctx.check('AT7', await js(`document.querySelector('.pinwin[data-id="beta"] textarea') === window.__proofDesk`),
      'Switching to Canvas retains the same pinned Desk and composer')
    await mode('Attention')
    await ready(`document.querySelector('[data-attn-agent="beta"]')?.getAttribute('aria-selected') === 'true'`)

    // Pop out the other panel: independently placed Attention and Canvas
    // surfaces must coexist across both directions of the mode switch.
    await click('.attn-panel-queue .popout-button')
    const child = await ctx.until(async () => [...r.popouts.values()].find(w => !w.isDestroyed()), Boolean, 10000)
    if (!child) throw new Error('Attention queue did not create a native window')
    const childId = child.id
    await ctx.until(() => child.webContents.executeJavaScript(`!!document.querySelector('.attn-panel-queue')`), Boolean, 10000)
    await mode('Canvas')
    const retained = await child.webContents.executeJavaScript(`!!document.querySelector('.attn-panel-queue')`)
    ctx.check('AT8', !child.isDestroyed() && child.id === childId && retained,
      'A real Attention popout survives returning to Canvas alongside its existing Desk pin', {childId, retained})
    await mode('Attention')
    ctx.check('AT9', !child.isDestroyed() && child.id === childId,
      'Returning to Attention retains that same native window')

    const beforeBorrow = await js(`(() => {
      const p=document.querySelector('.pinwin[data-id="beta"]'); const b=p.getBoundingClientRect();
      window.__proofPin=p;
      return {pins:localStorage.getItem('orgtree-pins-studio'), transform:document.querySelector('.canvas-world .space')?.getAttribute('style'),
        rect:[b.x,b.y,b.width,b.height]};
    })()`)
    const windowsBefore = [...r.popouts.values()].filter(w => !w.isDestroyed()).length
    await menu('Open desk temporarily')
    await ready(`!!document.querySelector('.tempdesk-panel textarea')`)
    const borrowed = await js(`({same:document.querySelector('.tempdesk-panel textarea') === window.__proofDesk,
      draft:document.querySelector('.tempdesk-panel textarea')?.value,
      pinHasComposer:!!document.querySelector('.pinwin[data-id="beta"] textarea'),
      pins:localStorage.getItem('orgtree-pins-studio'),
      transform:document.querySelector('.canvas-world .space')?.getAttribute('style')})`)
    ctx.check('TD1', borrowed.same && borrowed.draft === 'draft survives every surface' && !borrowed.pinHasComposer,
      'The temporary modal borrows the same canonical composer and draft from the Canvas pin', borrowed)
    ctx.check('TD2', !!beforeBorrow.transform && borrowed.pins === beforeBorrow.pins && borrowed.transform === beforeBorrow.transform
      && [...r.popouts.values()].filter(w => !w.isDestroyed()).length === windowsBefore,
      'Temporary opening leaves persisted pins, Canvas camera and native window count unchanged', {beforeBorrow, borrowed})
    // Drive Chromium's keyboard input: aria-modal alone does not contain Tab.
    await js(`document.querySelector('.tempdesk-close').focus(); true`)
    r.window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']})
    r.window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']})
    const wrappedBack = await ctx.until(() => js<boolean>(`document.querySelector('.tempdesk-panel').contains(document.activeElement) && document.activeElement !== document.querySelector('.tempdesk-close')`), Boolean, 3000)
    r.window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'})
    r.window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'})
    const wrappedForward = await ctx.until(() => js<boolean>(`document.activeElement === document.querySelector('.tempdesk-close')`), Boolean, 3000)
    ctx.check('TD4', !!wrappedBack && !!wrappedForward,
      'Native Shift+Tab and Tab wrap between the first and last visible temporary Desk controls', {wrappedBack, wrappedForward})
    await click('.tempdesk-close')
    await ready(`!document.querySelector('.tempdesk-panel') && !!document.querySelector('.pinwin[data-id="beta"] textarea')`)
    const returned = await js(`(() => {
      const p=document.querySelector('.pinwin[data-id="beta"]'); const b=p.getBoundingClientRect();
      return {samePin:p===window.__proofPin, sameDesk:p.querySelector('textarea')===window.__proofDesk,
        draft:p.querySelector('textarea')?.value,rect:[b.x,b.y,b.width,b.height],pins:localStorage.getItem('orgtree-pins-studio')};
    })()`)
    ctx.check('TD3', returned.samePin && returned.sameDesk && returned.draft === 'draft survives every surface'
      && JSON.stringify(returned.rect) === JSON.stringify(beforeBorrow.rect) && returned.pins === beforeBorrow.pins,
      'Dismissal returns the same Desk to the same pin with its exact placement and draft', {beforeBorrow, returned})
  } finally { ctx.close(r) }
}
