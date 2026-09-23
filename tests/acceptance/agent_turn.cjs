// Electron-side driver for the real one-agent-turn acceptance check (VER-01).
// Loads the actual built entrypoint exactly as application.cjs does: no
// replacement engine, renderer, or preload, and the real app creates its own
// window(s). Once mounted, drives the REAL DOM to create an organization,
// hire one tool-restricted Haiku agent, send it a deterministic task through
// the real chat composer, and observe the pass criteria run_claude.py already
// proved (arithmetic result + exactly one read-only orgtree_chart call) —
// through the app's own chat-transcript API, not an engine-internal
// monkeypatch, since the real app always spawns the unmodified engine/launch.py.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { app, BrowserWindow, dialog } = require('electron')
const { createOrganization } = require('./organization_flow.cjs')

const root = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT)
const target = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
const data = fs.realpathSync.native(path.join(root, 'data'))
assert.equal(fs.realpathSync.native(process.env.ORGTREE_DATA), fs.realpathSync.native(path.join(root, 'inherited-v1')))
assert.equal(fs.realpathSync.native(process.env.ORGTREE_V2_DATA), data)
app.setPath('userData', path.join(root, 'profile'))
app.setAppPath(target)

const ORG = 'v2-agent-turn-acceptance'
const NODE = 'probe'
const CHARTER = 'You are a bounded acceptance test. Perform only the requested arithmetic and one read-only orgtree_chart call. Never call status, send mail, modify files, hire agents, or perform any other tool action. Return the requested result and stop.'
const TASK_MESSAGE = `This is the entire one-turn acceptance task. Compute 6 times 7 mentally. Call orgtree_chart exactly once, read-only, and confirm the returned chart contains your own probe node in ${ORG}. Then return one final line starting V2_ACCEPTANCE_RESULT with the arithmetic answer and the observed organization/node names. No other tool calls, status reports, file changes, mail or actions are authorized. Stop after the final line.`

const rows = []
let finishing = false
const deadline = setTimeout(() => finish({ status: 'FAIL', reason: 'Acceptance timed out before the real agent turn completed' }), 270000)

// Never print raw provider stdout/stderr to console; only the structured
// report below is published (matches run.mjs's existing convention).
async function check(name, action) {
  try { await action(); rows.push({ name, status: 'PASS' }); return true }
  catch (error) {
    fs.appendFileSync(path.join(root, 'private-errors.log'), name + '\n' + (error.stack || String(error)) + '\n')
    rows.push({ name, status: 'FAIL', reason: error instanceof assert.AssertionError ? error.message : 'Runtime operation failed (' + error.name + ')' })
    return false
  }
}

function finish(extra = {}) {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  const status = extra.status || (rows.length && rows.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL')
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ status, checks: rows, ...extra }, null, 2))
  app.quit()
}

dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })

let ready = false
app.on('browser-window-created', (_event, main) => {
  main.webContents.once('did-finish-load', async () => {
    if (ready || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(main.webContents.getURL())) return
    ready = true
    const evaluate = code => main.webContents.executeJavaScript(code, true)
    const waitFor = condition => evaluate(`new Promise(resolve => { const start = Date.now(); const timer = setInterval(() => { if (${condition}) { clearInterval(timer); resolve(true) } else if (Date.now() - start > 20000) { clearInterval(timer); resolve(false) } }, 100) })`)

    await check('real-renderer-mounted', async () => {
      const mounted = await evaluate(`new Promise(resolve => { const start = Date.now(); const timer = setInterval(() => { if (document.getElementById('root')?.children.length && document.body.innerText.trim().length > 20) { clearInterval(timer); resolve(true) } else if (Date.now() - start > 15000) { clearInterval(timer); resolve(false) } }, 100) })`)
      assert.equal(mounted, true, 'Real renderer must mount before any DOM interaction')
    })
    if (rows.at(-1).status !== 'PASS') { finish(); return }

    await check('organization-created-through-real-form', () => createOrganization({ evaluate, waitFor, name: ORG, slug: ORG }))
    if (rows.at(-1).status !== 'PASS') { finish(); return }

    let hired = null
    await check('agent-hired-through-real-backend', async () => {
      hired = await evaluate(`fetch(${JSON.stringify('/api/orgs/' + ORG + '/ops')}, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'hire', name: ${JSON.stringify(NODE)}, tier: 'haiku', grant: 0,
          charter: ${JSON.stringify(CHARTER)}, tools: { bash: false, edit: false, web: false, subagents: false, mcp: [] },
          org_visibility: 'full', effort: 'low', prefer_reserve: true }) }).then(r => r.json())`)
      assert.equal(hired && hired.node, NODE, 'Hire must return the real probe node')
    })
    if (rows.at(-1).status !== 'PASS') { finish(); return }

    await check('task-sent-through-real-chat-composer', async () => {
      assert.equal(await waitFor(`[...document.querySelectorAll('.sq')].some(e => e.querySelector('.name')?.textContent === ${JSON.stringify(NODE)})`), true,
        'Hired probe agent must appear on the real canvas')
      // Real open path proven by application.cjs: right-click the card, then
      // the real context menu's "Open desk" — not a synthetic shortcut.
      assert.equal(await evaluate(`(() => { const card = [...document.querySelectorAll('.sq')].find(e => e.querySelector('.name')?.textContent === ${JSON.stringify(NODE)}); if (!card) return false; const r = card.getBoundingClientRect(); card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 30, clientY: r.y + 30 })); return true })()`), true)
      assert.equal(await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Open desk')`), true)
      assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Open desk'); if (!b) return false; b.click(); return true })()`), true)
      assert.equal(await waitFor(`document.querySelector('.cc-composer textarea')`), true, 'Probe desk composer must mount')
      await evaluate(`(() => { const t = document.querySelector('.cc-composer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(TASK_MESSAGE)});
        t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      assert.equal(await waitFor(`document.querySelector('.cc-composer .cc-send') && !document.querySelector('.cc-composer .cc-send').disabled`), true)
      await evaluate(`document.querySelector('.cc-composer .cc-send').click(); true`)
    })
    if (rows.at(-1).status !== 'PASS') { finish(); return }

    let assistantResult = null, chartObserved = false, chartCallCount = 0
    await check('real-agent-response-observed-in-chat-pane', async () => {
      const start = Date.now()
      while (Date.now() - start < 240000) {
        const chat = await evaluate(`fetch(${JSON.stringify('/api/orgs/' + ORG + '/nodes/' + NODE + '/chat?last=80')}).then(r => r.json())`)
        const assistant = (chat.messages || []).filter(message => message.role === 'assistant')
        const found = assistant.find(message => typeof message.text === 'string' && message.text.includes('V2_ACCEPTANCE_RESULT')
          && message.text.includes('42') && message.text.includes(ORG) && message.text.includes(NODE))
        const calls = assistant.flatMap(message => Array.isArray(message.tools) ? message.tools : [])
          .filter(tool => (typeof tool === 'string' ? tool : tool?.name) === 'orgtree_chart')
        chartCallCount = calls.length
        chartObserved = chartCallCount > 0
        if (found && chartObserved) { assistantResult = found.text; return }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      throw new assert.AssertionError({ message: 'No matching assistant result and orgtree_chart call within the bounded run' })
    })

    finish({
      evidence: 'real-application-real-provider-through-dom',
      org: ORG, node: NODE,
      chartObserved, arithmeticObserved: Boolean(assistantResult), chartCallCount,
      assistantResult,
    })
  })
})

require(path.join(target, 'dist/main/index.cjs'))
