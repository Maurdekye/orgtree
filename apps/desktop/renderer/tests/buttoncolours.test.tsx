import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buttonAccent, setButtonAgent, useButtonColours } from '../src/buttoncolours'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const agents = new Map([['claude',{tier:'opus'}],['codex',{tier:'astra'}],['google',{tier:'pro'}],['router',{tier:'or-new'}]])
function Scope({org, nodes=agents}: {org:string;nodes?:typeof agents}) {
  return <div data-scope={org} style={useButtonColours(org,nodes)}><button className="iconbtn">control</button></div>
}

test('global button colour follows current agent, provider changes and neutral fallback independently per org', async t => {
  const view = await mountView(<><Scope org="colours-a"/><Scope org="colours-b"/></>,el=>el)
  t.after(async()=>{await view.unmount();setButtonAgent('colours-a',null);setButtonAgent('colours-b',null)})
  const colour = (org:string) => (view.el.querySelector(`[data-scope="${org}"]`) as HTMLElement).style.getPropertyValue('--button-accent')
  assert.equal(colour('colours-a'),'var(--line-hover)')
  for (const [id,provider] of [['claude','claude'],['codex','openai'],['google','google'],['router','openrouter']]) {
    await inAct(()=>setButtonAgent('colours-a',id!))
    await flush()
    assert.equal(colour('colours-a'),`var(--prov-${provider})`)
    assert.equal(colour('colours-b'),'var(--line-hover)')
  }
  await view.render(<Scope org="colours-a" nodes={new Map([['router',{tier:'astra'}]])}/>)
  assert.equal(colour('colours-a'),'var(--prov-openai)','a model/provider switch updates the focused colour')
  await view.render(<Scope org="colours-a" nodes={new Map()}/>)
  assert.equal(colour('colours-a'),'var(--line-hover)','removed agent has no provider colour')
  await inAct(()=>setButtonAgent('colours-a',null))
  assert.equal(colour('colours-a'),'var(--line-hover)')
  assert.equal(buttonAccent(null),'var(--line-hover)')
})

test('ordinary icon/preset hover and focus use provider tokens, while deliberate danger rules remain red', () => {
  assert.match(css,/\.iconbtn:not\(\.danger\):hover\s*\{[^}]*border-color:\s*var\(--button-accent\)/)
  assert.match(css,/\.preset-card:hover\s*\{[^}]*border-color:\s*var\(--button-accent\)/)
  assert.match(css,/button:not\(\.danger\):not\(\.stop\):not\(\.kill-btn\):not\(\.kill-release\):not\(\.disk-del\):not\(\.org-del\):not\(\.retirebtn\):not\(\.dismissbtn\):not\(\.chip-x\):not\(\.eye-tab-x\):focus-visible\s*\{[^}]*outline-color:\s*var\(--button-accent\)/)
  for (const provider of ['claude','openai','google','openrouter']) {
    assert.ok(css.includes(`.prov-${provider} { --button-accent: var(--prov-${provider}); }`))
  }
  assert.match(css,/button\.danger:hover\s*\{\s*border-color:\s*var\(--bad\)/)
  assert.match(css,/\.cc-send\.stop\s*\{[^}]*border-color:\s*var\(--bad\)/)
  assert.match(css,/\.disk-del\s*\{[^}]*border:\s*1px solid var\(--bad\)/)
})

test('primary and other ordinary accent hover frames follow provider or neutral without changing their fill', () => {
  const primary = css.match(/button\.primary:hover\s*\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(primary.includes('border-color: var(--button-accent)'), 'primary frame follows provider/neutral token')
  assert.ok(primary.includes('background: var(--accent-hover)'), 'primary hover fill remains unchanged')
  for (const selector of ['button.badge.queued:hover', 'button.badge.frozen:hover',
    'button.badge.retired-fold:hover', 'button.badge.audience-fold:hover', '.jumpbottom:hover',
    '.pinuser:hover', '.doc-chip:hover', '.doc-badge:hover', 'button.stackbadge:hover',
    '.cc-attach:hover', '.cc-notice-toggle:hover', '.maillink:hover', '.cc-eff:hover',
    '.docket-detail-toggle:focus-visible', '.reply-preview-jump:focus-visible']) {
    const start = css.indexOf(selector + ' {')
    const rule = css.slice(start, css.indexOf('}', start))
    assert.ok(start >= 0 && rule.includes('var(--button-accent)'), selector)
  }
})
