// muse-ui-logins.mjs's desktop stages: what the hire and settings surfaces
// offer a Muse seat, by the login it runs on (independent review 2026-10-13,
// round 2). Reports what it saw; the proof decides what passes.
// args: { org, stage: 'hire' | 'settings', theme?,
//   hire:     { tier, name } — Hire a subordinate under boss from the context
//             menu, name the draft and hire it (the menu's items reported);
//   settings: { agent, model? } — the agent's settings, Model tab: the effort
//             bar's levels, the account choices and the Muse note, after
//             choosing `model` in the model select when given }
module.exports = async (page, { args }) => {
  await page.cdp('Page.enable')
  if (args.theme) await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('orgtree-contrast-theme', ${JSON.stringify(args.theme)}) } catch {}` })
  await page.goto(`/o/${args.org}`)
  await page.waitFor('[data-copy-agent-name="boss"]', { timeout: 40000 })
  await page.sleep(1500)
  const out = { stage: args.stage }
  if (args.stage === 'hire') {
    await page.rightClick('[data-copy-agent-name="boss"]')
    await page.waitFor('.ctxmenu[role="menu"]')
    await page.hover({ selector: 'button.ctxmenu-item', text: '^Hire a subordinate( ▸)?$', regex: true })
    await page.sleep(500)
    out.items = await page.eval(() => [...document.querySelectorAll('.ctxmenu button.ctxmenu-item')]
      .map((b) => ({ text: (b.innerText || '').trim(), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' })))
    await page.screenshot(`hire-menu-${args.tier}`)
    await page.click({ selector: '.ctxmenu button.ctxmenu-item', text: `^${args.tier}$`, regex: true })
    await page.waitFor('.sq.draft', { timeout: 10000 })
    await page.sleep(800)
    await page.click('.sq.draft input.df-name')
    await page.type(args.name)
    await page.sleep(300)
    await page.screenshot(`hire-draft-${args.tier}`)
    await page.click({ selector: '.sq.draft button.primary', text: 'hire' })
    try {
      await page.waitFor(`[data-copy-agent-name="${args.name}"]`, { timeout: 20000 })
      out.hired = true
    } catch (e) {
      out.hired = false
      out.toasts = await page.eval(() => [...document.querySelectorAll('.toast, .toasts *')].map((t) => t.innerText).slice(0, 6))
    }
    await page.screenshot(`hire-done-${args.tier}`)
    return out
  }
  // settings: open the agent's desk, its settings, the Model tab
  await page.rightClick(`[data-copy-agent-name="${args.agent}"]`)
  await page.waitFor('.ctxmenu[role="menu"]')
  await page.hover({ selector: 'button.ctxmenu-item', text: '^Open( ▸)?$', regex: true })
  await page.sleep(300)
  const items = await page.eval(() => [...document.querySelectorAll('.ctxmenu[role="menu"] button.ctxmenu-item')].map((b) => (b.innerText || '').trim()))
  const desk = items.find((t) => /desk/i.test(t))
  if (desk) await page.click({ selector: 'button.ctxmenu-item', text: `^${desk.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c)}$`, regex: true })
  await page.waitFor(`button[aria-label="settings for ${args.agent}"]`, { timeout: 30000 })
  // the desk's own effort control first: its levels
  try {
    await page.click('.cc-eff')
    await page.waitFor('.eff-pop .effort-bar-track', { timeout: 10000 })
    await page.sleep(400)
    out.desk = await page.eval(() => [...document.querySelectorAll('.eff-pop .effort-bar-dot')].map((d) => d.getAttribute('data-level')))
    await page.screenshot(`${args.agent}-desk-effort`)
    await page.press('Escape')
    await page.sleep(300)
  } catch (e) { out.desk = String(e.message).slice(0, 120) }
  await page.click(`button[aria-label="settings for ${args.agent}"]`)
  await page.waitFor('[role="tab"]', { timeout: 20000 })
  await page.click({ selector: '[role="tab"]', text: '^Model$', regex: true })
  await page.sleep(800)
  if (args.model) {
    await page.eval((t) => {
      const sel = document.querySelector('select.model-switch')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, t)
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }, args.model)
    await page.sleep(800)
  }
  const read = await page.eval(() => {
    const cfg = [...document.querySelectorAll('.cfg')].pop() ?? document
    const bar = [...cfg.querySelectorAll('.effort-bar')].pop()
    const acct = cfg.querySelector('select[aria-label="Account"]')
    const model = cfg.querySelector('select.model-switch')
    return {
      model: model?.value ?? null,
      modelOptions: [...(model?.options ?? [])].filter((o) => /wonder|spark/.test(o.value)).map((o) => ({ value: o.value, disabled: o.disabled })),
      levels: bar ? [...bar.querySelectorAll('.effort-bar-dot')].map((d) => d.getAttribute('data-level')) : null,
      account: acct ? { value: acct.value, options: [...acct.options].map((o) => ({ value: o.value, text: o.innerText, disabled: o.disabled })) } : null,
      note: cfg.querySelector('.muse-unoffered')?.innerText ?? null,
    }
  })
  Object.assign(out, read)
  await page.eval(() => [...document.querySelectorAll('.cfg .effort-bar')].pop()?.scrollIntoView({ block: 'center' }))
  await page.screenshot(`${args.agent}-settings${args.model ? '-' + args.model : ''}`)
  await page.press('Escape')
  return out
}
