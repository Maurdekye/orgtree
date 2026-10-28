import fs from 'node:fs'
import path from 'node:path'
import type { AppScenarioContext, AppWindow } from './app-composition.probe'

/** Real creation/hire/chat handlers against isolated canned HTTP. No tutorial
 * state is set by the driver: only user actions through the shipping App. */
export async function runFirstUseScenarios(ctx: AppScenarioContext) {
  let slug = 'first-use'
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

    // Dismissing the guide. USER 2026-10-28 me1fad212bab7: "allow the user to dismiss the initial intro 4-step
    // intro tutorial". Each case creates its own organization through the real Create window, presses the
    // note's Dismiss with a real mouse click (element.click() would ignore the guide's pointer-events: none),
    // and then reloads and reopens the organization: a dismissed guide must not return.
    const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
    // The note follows its target while the canvas is still gliding: shoot and press only once the button holds still.
    const still = async (r: AppWindow, selector: string) => {
      let previous = '', same = 0
      await ctx.until(async () => {
        const box = await ctx.eval<string>(r, `JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect())`)
        same = box === previous ? same + 1 : 0; previous = box
        return same
      }, n => n >= 5)
    }
    // A Session 0 offscreen window can paint one state behind its DOM, so a first capture warms the frame up.
    const settledShot = async (r: AppWindow, name: string) => { await pause(500); await shot(r, 'tutorial-dismiss-warmup'); await pause(300); await shot(r, name) }
    const press = async (r: AppWindow, selector: string) => {
      await still(r, selector)
      const at = await ctx.eval<{ x: number; y: number; hit: boolean } | null>(r, `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect(),x=Math.round(b.left+b.width/2),y=Math.round(b.top+b.height/2);return {x,y,hit:document.elementFromPoint(x,y)===e}})()`)
      if (!at?.hit) return { ok: false, events: [] as string[] }
      // a real pointer sequence: move onto the control, press, release (the page records what actually arrives)
      await ctx.eval(r, `window.__mouse = []; for (const t of ['mousemove','mousedown','mouseup','click']) document.addEventListener(t, e => window.__mouse.push(t + ':' + (e.target.className || e.target.tagName)), { capture: true }); true`)
      const wc = r.window.webContents
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
      await pause(80)
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await pause(80)
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await pause(200)
      return { ok: true, events: await ctx.eval<string[]>(r, 'window.__mouse') }
    }
    const guide = (r: AppWindow, org: string) => ctx.eval<{ step: string | null; ring: boolean; saved: string | null }>(r, `({step:document.querySelector("[data-tutorial-step]")?.getAttribute("data-tutorial-step")??null,ring:!!document.querySelector(".first-use-ring"),saved:JSON.parse(localStorage.getItem("orgtree-first-use:${org}")??"null")?.step??null})`)
    const gone = (g: { step: string | null; ring: boolean; saved: string | null }) => g.step === null && !g.ring && g.saved === 'done'
    const goneCheck = async (id: string, r: AppWindow, org: string, note: string) => { const g = await guide(r, org); ctx.check(id, gone(g), note, g) }
    const reload = async (r: AppWindow) => {
      await ctx.eval(r, 'window.__beforeReload = true; true')
      r.window.webContents.reload()
      await ctx.until(() => ctx.eval<boolean>(r, 'window.__beforeReload === undefined && !!document.querySelector(".sq.user")'), Boolean)
      await pause(1500)
    }
    const startOrg = async (next: string) => {
      slug = next; roots = []; revision++; rejectCreate = false; rejectHire = false
      const before = new Set(ctx.records.keys())
      await click(home, '.shell-create-btn')
      const win = await ctx.until(async () => [...ctx.records.values()].find(r => !before.has(r.id)), Boolean)
      if (!win) throw Error('tutorial: Create did not open a native window for ' + next)
      opened.push(win)
      await ctx.until(() => ctx.eval<boolean>(win, '!!document.querySelector("#shell-create-name")'), Boolean)
      await input(win, '#shell-create-name', next)
      await click(win, '.shell-create-actions button[type="submit"]')
      await waitStep(win, 'token')
      return win
    }
    const offered = (r: AppWindow) => ctx.eval<any>(r, `(() => {const b=document.querySelector('.first-use-dismiss'),card=document.querySelector('.first-use-card');if(!b||!card)return null;const x=b.getBoundingClientRect(),c=card.getBoundingClientRect();return {text:b.textContent,label:b.getAttribute('aria-label'),hit:document.elementFromPoint(x.left+x.width/2,x.top+x.height/2)===b,inCard:x.left>=c.left&&x.right<=c.right&&x.top>=c.top&&x.bottom<=c.bottom,inViewport:c.left>=0&&c.top>=0&&c.right<=innerWidth&&c.bottom<=innerHeight}})()`)
    const reopen = async (id: string, org: string) => {
      const r = await ctx.create(id, org); opened.push(r)
      await ctx.until(() => ctx.eval<boolean>(r, '!!document.querySelector(".sq.user")'), Boolean)
      await pause(1500)
      return r
    }

    // Step 1 of 4: the hire token.
    const atToken = await startOrg('dismiss-token')
    const tokenOffer = await offered(atToken)
    ctx.check('TU13-dismiss-offered-step1', !!tokenOffer && tokenOffer.text === 'Dismiss' && /dismiss/i.test(tokenOffer.label ?? '') && tokenOffer.hit && tokenOffer.inCard && tokenOffer.inViewport, 'the first note has a Dismiss button that is inside the note and is what a click at its centre reaches', tokenOffer)
    await still(atToken, '.first-use-dismiss')
    await settledShot(atToken, 'tutorial-dismiss-step1-before')
    const tokenPress = await press(atToken, '.first-use-dismiss')
    ctx.check('TU13b-pressed', tokenPress.ok && tokenPress.events.includes('click:first-use-dismiss'), 'a real mouse click reaches the Dismiss button through the guide overlay', tokenPress)
    await waitStep(atToken, null)
    await goneCheck('TU13c-dismissed-step1', atToken, 'dismiss-token', 'dismissing at step 1 removes the note and ring and stores the guide as done')
    await settledShot(atToken, 'tutorial-dismiss-step1-after')
    await reload(atToken)
    await goneCheck('TU13d-reload-step1', atToken, 'dismiss-token', 'reloading the window does not bring a dismissed step-1 guide back')
    ctx.close(atToken)
    const tokenAgain = await reopen('tutorial-dismiss-step1-reopened', 'dismiss-token')
    await goneCheck('TU13e-reopen-step1', tokenAgain, 'dismiss-token', 'a new native window opening the organization does not bring it back either')

    // Step 3 of 4: the Hire button, with a name already typed.
    const atHire = await startOrg('dismiss-hire')
    await click(atHire, '[data-first-use="token"]:not(:disabled)')
    await ctx.until(() => ctx.eval<boolean>(atHire, '!!document.querySelector(".df-name")'), Boolean)
    await input(atHire, '.df-name', 'second-agent')
    await waitStep(atHire, 'hire')
    const hireOffer = await offered(atHire)
    ctx.check('TU14-dismiss-offered-step3', !!hireOffer && hireOffer.text === 'Dismiss' && hireOffer.hit && hireOffer.inCard && hireOffer.inViewport && await ctx.eval(atHire, 'document.querySelector(".first-use-card")?.textContent.includes("3 of 4")') === true, 'the third note has the same Dismiss button', hireOffer)
    await still(atHire, '.first-use-dismiss')
    await settledShot(atHire, 'tutorial-dismiss-step3-before')
    const hirePress = await press(atHire, '.first-use-dismiss')
    ctx.check('TU14b-pressed', hirePress.ok && hirePress.events.includes('click:first-use-dismiss'), 'a real mouse click reaches the Dismiss button on the Hire step', hirePress)
    await waitStep(atHire, null)
    await goneCheck('TU14c-dismissed-step3', atHire, 'dismiss-hire', 'dismissing at step 3 removes the note and ring and stores the guide as done')
    await settledShot(atHire, 'tutorial-dismiss-step3-after')
    ctx.check('TU14d-draft-kept', await ctx.eval(atHire, 'document.querySelector(".sq.draft .df-name")?.value') === 'second-agent', 'the draft hire is untouched by dismissing')
    const hiresBefore = hires.length
    await click(atHire, '.sq.draft .df-foot .primary')
    await ctx.until(async () => hires.length, n => n === hiresBefore + 1)
    await ctx.until(() => ctx.eval<boolean>(atHire, '!!document.querySelector("[data-first-use-agent=second-agent]")'), Boolean)
    await pause(1500)
    const hireState = await guide(atHire, 'dismiss-hire')
    ctx.check('TU14e-hire-works', hires.at(-1)?.name === 'second-agent' && gone(hireState), 'the real Hire still hires, and the finished hire does not start the message step of a dismissed guide', { hire: hires.at(-1), guide: hireState })
    await reload(atHire)
    await goneCheck('TU14f-reload-step3', atHire, 'dismiss-hire', 'reloading after the hire leaves the dismissed guide away')
    ctx.close(atHire)
    const hireAgain = await reopen('tutorial-dismiss-step3-reopened', 'dismiss-hire')
    await goneCheck('TU14g-reopen-step3', hireAgain, 'dismiss-hire', 'a new native window opening the organization does not bring it back')
  } finally {
    for (const r of opened) ctx.close(r)
    stop()
  }
}
