/** User-visible composition checks. All state changes go through the shipping
 * App's controls; the fixture only supplies canned HTTP and native windows.
 * DOM references distinguish retained canonical desks from recreated copies. */
import type { AppScenarioContext } from './app-composition.probe'

export async function runAttentionScenarios(ctx: AppScenarioContext): Promise<void> {
  const originalTree = await (await fetch(ctx.origin + '/api/orgs/studio')).json()
  const at = '2026-09-22T07:00:00Z'
  const ask = { id:'proof-question', node:'agent', kind:'question', status:'open', at, rev:3,
    question:'Which fixture option?', options:[{label:'Keep the draft'},{label:'Discard'}] }
  const item = { slug:'proof-ticket', title:'Fixture attention ticket', rev:7, kind:'code',
    status:'in_progress', objective:'Fixture resolution request.', owner:{node:'agent',generation:2},
    owner_current:true, owner_state:'live', at, updated_at:at, participants:[], questions:[],
    acceptance:[], dependencies:[], evidence:[], history:[], done_so_far:[], working_on_next:[],
    effective_attention:true, attention_sources:['manual'],
    manual_attention:{by:{node:'agent',generation:2},at,reason:'Check this fixture row',set_rev:7} }
  const urgent = {id:'proof-urgent',from:'agent',kind:'message',at,body:'Fixture urgent message body',urgent:true,urgent_reason:'Fixture urgent request'}
  const otherMail = {...urgent,id:'proof-other',urgent_reason:'Leave this unresolved'}
  let flagged = true, unanswered = true, unread = true
  const posts: {path:string;body:any}[] = []
  const stopApi = ctx.routeApi(async (req, res, url) => {
    const p = url.pathname
    if (!p.startsWith('/api/orgs/studio')) return false
    const json = (body: unknown, status = 200) => {
      res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'})
      res.end(JSON.stringify(body)); return true
    }
    if (req.method === 'GET' && p === '/api/orgs/studio') return json({...originalTree,
      rev:unanswered ? 10 : 11,
      roots:originalTree.roots.map((n: any) => n.id === 'agent' ? {...n,ask:unanswered ? ask : null} : n)})
    if (req.method === 'GET' && p === '/api/orgs/studio/work-items') return json({items:flagged ? [item] : [],archived:[],backlogged:[],counts:{active:1,attention:flagged ? 1 : 0,archived:0,backlogged:0}})
    if (req.method === 'GET' && p === '/api/orgs/studio/inbox') return json({pending:unread ? [urgent,otherMail] : [otherMail],delivered:unread ? [] : [urgent],sent:[]})
    if (req.method !== 'POST' || ![
      '/api/orgs/studio/work-items/proof-ticket/dismiss-attention',
      '/api/orgs/studio/inbox/read','/api/orgs/studio/asks/proof-question/answer',
    ].includes(p)) return false
    let raw = ''; for await (const chunk of req) raw += String(chunk)
    const body = JSON.parse(raw); posts.push({path:p,body})
    if (p.endsWith('/dismiss-attention')) {
      if (body.set_rev !== 7) return json({detail:'Wrong attention revision'},409)
      flagged = false; return json({dismissed:item.slug})
    }
    if (p.endsWith('/inbox/read')) {
      if (JSON.stringify(body.ids) !== JSON.stringify([urgent.id])) return json({detail:'Wrong mail id'},400)
      unread = false; return json({read:1})
    }
    if (body.rev !== 3 || body.selected?.[0] !== 'Keep the draft') return json({detail:'Wrong question answer/revision'},409)
    unanswered = false; return json({answered:ask.id,node:'agent'})
  })
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

    await ready(`document.querySelectorAll('[data-attn-row]').length === 4`)
    const rowKinds = await js<string[]>(`Array.from(document.querySelectorAll('[data-attn-row]')).map(e=>e.dataset.attnKind).sort()`)
    ctx.check('AQ1', JSON.stringify(rowKinds) === JSON.stringify(['mail','mail','question','ticket']),
      'The real App combines ticket, urgent mail and question reads in one queue',rowKinds)
    await click('[data-attn-row="ticket:proof-ticket"]')
    await js(`Array.from(document.querySelectorAll('.attn-detail-actions button')).find(e=>e.textContent==='Dismiss attention').click(); true`)
    await ready(`!document.querySelector('[data-attn-row="ticket:proof-ticket"]')`)
    ctx.check('AQ2', !flagged && posts.some(p=>p.path.endsWith('/dismiss-attention') && p.body.set_rev===7)
      && await js<boolean>(`document.querySelectorAll('[data-attn-row]').length === 3`),
      'Dismissing uses the displayed attention revision and removes only its ticket',posts)
    await click('[data-attn-row="mail:proof-urgent"]')
    await ready(`!!document.querySelector('[data-attn-row="mail:proof-urgent"].attn-resolved')`)
    ctx.check('AQ3', !unread && await js<boolean>(`document.querySelector('[data-attn-row="mail:proof-urgent"]').getAttribute('aria-selected')==='true' && document.querySelectorAll('[data-attn-row]').length===3`),
      'Read urgent mail remains visible while selected; unrelated urgent mail stays unread')
    await click('[data-attn-row="question:proof-question"]')
    await ready(`!document.querySelector('[data-attn-row="mail:proof-urgent"]')`)
    ctx.check('AQ4', await js<boolean>(`document.querySelectorAll('[data-attn-row]').length===2 && !!document.querySelector('[data-attn-row="mail:proof-other"]')`),
      'Deselecting the read mail removes that row while preserving the question and other mail')
    await click('.attn-detail-question .ask-row')
    await ready(`!document.querySelector('.attn-detail-question .ask-submit').disabled`)
    await click('.attn-detail-question .ask-submit')
    await ready(`!document.querySelector('[data-attn-row="question:proof-question"]')`)
    ctx.check('AQ5', !unanswered && posts.some(p=>p.path.endsWith('/proof-question/answer') && p.body.rev===3)
      && await js<boolean>(`document.querySelectorAll('[data-attn-row]').length===1 && !!document.querySelector('[data-attn-row="mail:proof-other"]')`),
      'The canonical question posts its revision and choice; only the answered question leaves',posts)

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
  } finally { stopApi(); ctx.close(r) }
}
