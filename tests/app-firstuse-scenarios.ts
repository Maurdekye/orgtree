import fs from 'node:fs'
import path from 'node:path'
import type { AppScenarioContext, AppWindow } from './app-composition.probe'

/** Real creation/hire/chat handlers against isolated canned HTTP. No tutorial
 * state is set by the driver: only user actions through the shipping App. */
export async function runFirstUseScenarios(ctx: AppScenarioContext) {
  const slug = 'first-use'
  const initial = await (await fetch(ctx.origin + '/api/orgs/studio')).json() as any
  const initialOrgs = await (await fetch(ctx.origin + '/api/orgs')).json() as any[]
  let created = false, rejectCreate = true, rejectHire = true, rejectSend = true
  let roots: any[] = [], revision = 1
  const hires: any[] = [], messages: any[] = []
  const stop = ctx.routeApi(async (req, res, url) => {
    const p = url.pathname
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); return true }
    const body = async () => { let data = ''; for await (const part of req) data += part; return JSON.parse(data) }
    if (p === '/api/orgs' && req.method === 'POST') {
      await body()
      if (rejectCreate) return json({ detail: 'Tutorial fixture creation rejected' }, 409)
      created = true; return json({ slug })
    }
    if (p === '/api/orgs') return json([...initialOrgs, ...(created ? [{ slug, name: 'First organization', live: roots.length, working: 0, seats: roots.length }] : [])])
    if (p === '/api/orgs/' + slug || p === '/api/orgs/old-empty') return json({ ...initial, slug: p.endsWith('old-empty') ? 'old-empty' : slug, name: 'First organization', roots: p.endsWith('old-empty') ? [] : roots, epoch: revision, rev: revision })
    if (p === `/api/orgs/${slug}/ops` && req.method === 'POST') {
      const request = await body(); hires.push(request)
      if (rejectHire) return json({ detail: 'Tutorial fixture hire rejected' }, 409)
      roots = [{ ...initial.roots[0], id: request.name, title: request.name }]; revision++
      return json({ node: request.name })
    }
    if (p === `/api/orgs/${slug}/nodes/first-agent/message` && req.method === 'POST') {
      const request = await body(); messages.push(request)
      if (rejectSend) return json({ detail: 'Tutorial fixture message rejected' }, 409)
      return json({ ok: true, id: 'tutorial-message', queued: false })
    }
    if (p === '/api/charters') return json({ charters: [] })
    return false
  })
  const opened: AppWindow[] = []
  const click = (r: AppWindow, selector: string) => ctx.eval(r, `document.querySelector(${JSON.stringify(selector)}).click();true`)
  const input = (r: AppWindow, selector: string, value: string, textarea = false) => ctx.eval(r, `(() => {const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${textarea ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  const step = (r: AppWindow) => ctx.eval<string | null>(r, 'document.querySelector("[data-tutorial-step]")?.getAttribute("data-tutorial-step") ?? null')
  const waitStep = (r: AppWindow, want: string | null) => ctx.until(() => step(r), s => s === want)
  const shot = async (r: AppWindow, name: string) => {
    // An offscreen native window can retain an older composited frame even
    // after the DOM has settled. Request a paint before recording its pixels.
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); r.window.webContents.removeListener('paint', finish); resolve() }
      const timer = setTimeout(finish, 1000)
      r.window.webContents.once('paint', finish); r.window.webContents.invalidate()
    })
    fs.writeFileSync(path.join(process.env.PROBE_ROOT!, name + '.png'), (await r.window.webContents.capturePage()).toPNG())
  }
  try {
    const old = await ctx.create('tutorial-old', 'old-empty'); opened.push(old)
    await ctx.until(() => ctx.eval<boolean>(old, '!!document.querySelector(".sq.user")'), Boolean)
    ctx.check('TU1-existing-empty', await step(old) === null, 'an existing empty organization does not acquire a tutorial from being opened')
    ctx.close(old)
    const home = await ctx.create('tutorial-home'); opened.push(home)
    const before = new Set(ctx.records.keys())
    await click(home, '.shell-create-btn')
    const create = await ctx.until(async () => [...ctx.records.values()].find(r => !before.has(r.id)), Boolean)
    if (!create) throw Error('tutorial: real Create did not open a native window')
    opened.push(create)
    await ctx.until(() => ctx.eval<boolean>(create, '!!document.querySelector("#shell-create-name")'), Boolean)
    await input(create, '#shell-create-name', 'First organization')
    await click(create, '.shell-create-actions button[type="submit"]')
    await ctx.until(() => ctx.eval<boolean>(create, '!!document.querySelector(".shell-create-error")'), Boolean)
    ctx.check('TU2-create-failure', !created && await ctx.eval(create, 'localStorage.getItem("orgtree-first-use:first-use")') === null, 'failed creation does not start or persist a tutorial')
    rejectCreate = false
    await click(create, '.shell-create-actions button[type="submit"]')
    const token = await waitStep(create, 'token')
    const geometry = await ctx.eval<any>(create, `(() => { const e=document.querySelector('[data-first-use="token"]:not(:disabled)'),ring=document.querySelector('.first-use-ring'),card=document.querySelector('.first-use-card');if(!e||!ring||!card)return null;const a=e.getBoundingClientRect(),b=ring.getBoundingClientRect();return {described:e.getAttribute('aria-describedby')===card.id,opacity:getComputedStyle(e.closest('.hsof')).opacity,aligned:Math.abs(a.left-4-b.left)<1&&Math.abs(a.top-4-b.top)<1,hit:document.elementFromPoint(a.left+a.width/2,a.top+a.height/2)?.closest('button')===e,text:card.textContent}})()`)
    ctx.check('TU3-real-token', token === 'token' && geometry?.aligned && geometry.described && geometry.opacity === '1' && geometry.hit, 'first real create opens an unobstructed enabled hire token with aligned ring and accessible description', geometry)
    await shot(create, 'tutorial-token')
    await click(create, '[data-first-use="token"]:not(:disabled)')
    ctx.check('TU4-name', await waitStep(create, 'name') === 'name' && await ctx.eval(create, 'document.activeElement === document.querySelector(".df-name")'), 'clicking actual token advances to the focused name input')
    await input(create, '.df-name', 'first-agent')
    ctx.check('TU5-hire', await waitStep(create, 'hire') === 'hire', 'entering a name directs user to the real Hire control')
    await input(create, '.df-name', '')
    ctx.check('TU6-empty-name', await waitStep(create, 'name') === 'name', 'clearing name restores name instruction rather than advancing a blank hire')
    await click(create, '.sq.draft .df-foot button:not(.primary)')
    ctx.check('TU7-cancel', await waitStep(create, 'token') === 'token', 'canceling the real draft returns to the token instruction')
    await click(create, '[data-first-use="token"]:not(:disabled)')
    await ctx.until(() => ctx.eval<boolean>(create, '!!document.querySelector(".df-name")'), Boolean)
    create.window.webContents.reload()
    ctx.check('TU7b-reload-draft', await waitStep(create, 'token') === 'token', 'reloading an unfinished draft resumes at a real hire token, without a phantom name form')
    await click(create, '[data-first-use="token"]:not(:disabled)')
    await ctx.until(() => ctx.eval<boolean>(create, '!!document.querySelector(".df-name")'), Boolean)
    await input(create, '.df-name', 'first-agent')
    await waitStep(create, 'hire')
    await click(create, '.sq.draft .df-foot .primary')
    await ctx.until(async () => hires.length, n => n === 1)
    ctx.check('TU8-hire-failure', roots.length === 0 && await step(create) === 'hire' && hires[0]?.op === 'hire' && hires[0]?.name === 'first-agent', 'failed actual hire keeps the Hire instruction and does not invent an agent', hires)
    rejectHire = false
    await click(create, '.sq.draft .df-foot .primary')
    await waitStep(create, 'message')
    // Follow whichever real surface the tutorial points at. The ordinary
    // canvas hire may still be at card scale after its camera transition.
    if (!await ctx.eval<boolean>(create, '!!document.querySelector("[data-first-use-chat=first-agent]")')) {
      const point = await ctx.eval<{ x: number; y: number }>(create, `(() => {const r=document.querySelector('[data-first-use-agent=first-agent]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      create.window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      create.window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }
    const chat = await ctx.until(() => ctx.eval<boolean>(create, '!!document.querySelector("[data-first-use-chat=first-agent]")'), Boolean)
    const afterHire = await ctx.eval(create, '({step:localStorage.getItem("orgtree-first-use:first-use"),text:document.querySelector(".first-use-card")?.textContent,errors:window.__APP_PROBE_ERRORS})')
    ctx.check('TU9-chat', chat && await waitStep(create, 'message') === 'message' && roots.length === 1 && await ctx.eval(create, 'document.querySelectorAll("[data-first-use-chat=first-agent]").length') === 1, 'successful real hire directs user into the canonical new agent chat and advances to message instruction', { hires, afterHire })
    await shot(create, 'tutorial-after-hire')
    if (!chat) throw Error('tutorial: successful hire did not open canonical chat')
    let previous = '', stable = 0
    const composerTarget = await ctx.until(async () => {
      const view = await ctx.eval<any>(create, '({ready:document.querySelector(".first-use-card")?.textContent.includes("a message here") === true,position:JSON.stringify(document.querySelector("[data-first-use-chat=first-agent]")?.getBoundingClientRect().toJSON())})')
      stable = view.ready && view.position === previous ? stable + 1 : 0
      previous = view.position
      return stable >= 5
    }, Boolean)
    ctx.check('TU9b-composer-target', composerTarget, 'message prompt moves to the usable canonical composer after its camera transition')
    await shot(create, 'tutorial-chat')
    ctx.check('TU9c-composer-visible', await ctx.eval(create, `(() => {const e=document.querySelector('[data-first-use-chat=first-agent]');const r=e.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e})()`), 'the message composer itself is a real pointer target', await ctx.eval(create, `(() => {const e=document.querySelector('[data-first-use-chat=first-agent]'),r=e.getBoundingClientRect();let p=e,parents=[];while(p){parents.push({tag:p.tagName,cls:p.className,opacity:getComputedStyle(p).opacity});p=p.parentElement}return {text:document.querySelector('.first-use-card')?.textContent,rect:r.toJSON(),hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.outerHTML.slice(0,300),parents}})()`))
    await input(create, '[data-first-use-chat=first-agent]', 'Hello from the tutorial', true)
    await click(create, '.cc-send')
    await ctx.until(async () => messages.length, n => n === 1)
    ctx.check('TU10-send-failure', await step(create) === 'message', 'a rejected real message does not complete the tutorial')
    rejectSend = false
    await input(create, '[data-first-use-chat=first-agent]', 'Hello again', true)
    await click(create, '.cc-send')
    await ctx.until(async () => messages.length, n => n === 2)
    ctx.check('TU11-complete', await waitStep(create, null) === null && await ctx.eval(create, 'JSON.parse(localStorage.getItem("orgtree-first-use:first-use")).step') === 'done' && messages[1]?.text === 'Hello again', 'accepted actual message completes and removes the tutorial', messages)
    ctx.close(create)
    const reopened = await ctx.create('tutorial-reopened', slug); opened.push(reopened)
    await ctx.until(() => ctx.eval<boolean>(reopened, '!!document.querySelector(".sq.user")'), Boolean)
    ctx.check('TU12-reopen', await step(reopened) === null && await ctx.eval(reopened, 'JSON.parse(localStorage.getItem("orgtree-first-use:first-use")).step') === 'done', 'new native window opening the completed org does not restart tutorial')
  } finally {
    for (const r of opened) ctx.close(r)
    stop()
  }
}
