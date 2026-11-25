import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The user's own message in the chats panel: the sent check a darker grey, the read check a brighter
// green, in every theme (USER 2026-11-25 14:24:33Z mb3ad4035c5bb "also make the sent arrow a darker grey
// and the read arrow a brighter green, to distinguish them more";
// @ticket:orgtree/mailbox-dm-panel-darker-grey-sent-arrow-brighter). Both stay readable on the user's
// bubble: WCAG non-text contrast of at least 3:1 with each preset accent. The clock while the engine has
// not taken a send keeps the time's grey (USER 14:25:06Z m75a4ad69ae4c); Hubchat keeps its ticks
// (USER 14:25:40Z m0018065d6e3c). Measured in the real panel by tests/dm-alpha1-visual.mjs, section 23.

declare const __SRC_DIR__: string
const dmCss = readFileSync(path.join(__SRC_DIR__, 'dm', 'dm.css'), 'utf8')
const appCss = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const themesSrc = readFileSync(path.join(__SRC_DIR__, 'themes.tsx'), 'utf8')

/** the declarations of the first rule whose selector is exactly `selector` */
function block(css: string, selector: string): string {
  const at = css.indexOf(selector + ' {')
  assert.ok(at >= 0, `a rule for ${selector}`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}
function decl(css: string, selector: string, prop: string): string | null {
  const m = block(css, selector).match(new RegExp(`(?:^|[;\\s])${prop.replace(/[-]/g, '\\-')}:\\s*([^;]+);`))
  return m ? m[1]!.trim() : null
}

type Rgb = [number, number, number]
const hex = (s: string): Rgb => {
  const m = s.trim().match(/^#([0-9a-f]{6})$/i)
  assert.ok(m, `a six-digit colour: ${s}`)
  return [0, 2, 4].map(i => parseInt(m![1]!.slice(i, i + 2), 16)) as Rgb
}
const mix = (a: Rgb, b: Rgb, p: number): Rgb => a.map((v, i) => v * p + b[i]! * (1 - p)) as Rgb
const lum = (c: Rgb) => {
  const [r, g, b] = c.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q); return (y! + 0.05) / (x! + 0.05) }
const saturation = (c: Rgb) => { const mx = Math.max(...c) / 255, mn = Math.min(...c) / 255, l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)) }

const accents = [...themesSrc.matchAll(/label: '[^']+', accent: '(#[0-9a-f]{6})'/gi)].map(m => m[1]!)
const themes = [
  { name: 'charcoal', root: ':root', dark: true },
  { name: 'obsidian-black', root: ':root.contrast-obsidian-black', dark: true },
  { name: 'light', root: ':root.contrast-light', dark: false },
  { name: 'solarized-light', root: ':root.contrast-solarized-light', dark: false },
]
/** a theme's own value of a root token, else the default theme's */
const rootToken = (root: string, prop: string) => decl(appCss, root, prop) ?? decl(appCss, ':root', prop)!
const okOf = (dark: boolean) => dark ? decl(appCss, ':root', '--ok')! : decl(appCss, ':root:is(.contrast-light, .contrast-solarized-light)', '--ok')!
/** the panel's tick colours in a theme: its own override, else the panel's default */
const tickOf = (t: typeof themes[number], which: 'sent' | 'read') => {
  const prop = `--dm-tick-${which}`
  const own = t.name === 'charcoal' ? null : (() => { try { return decl(dmCss, `${t.root} .dm-panel`, prop) } catch { return null } })()
  const group = t.dark ? null : (() => { try { return decl(dmCss, ':root:is(.contrast-light, .contrast-solarized-light) .dm-panel', prop) } catch { return null } })()
  const v = own ?? group ?? decl(dmCss, '.dm-panel', prop)
  assert.ok(v, `${t.name}: a ${prop}`)
  return v!
}

test('the sent check is a darker grey and the read check a brighter green, in every theme, both at least 3:1 on the user’s bubble', () => {
  assert.equal(accents.length, 4, 'POSITIVE CONTROL: the four preset accents')
  assert.match(dmCss, /\.dm-tick\.t-sent \{ color: var\(--dm-tick-sent\); \}/, 'the sent check reads its token')
  assert.match(dmCss, /\.dm-tick\.t-read \{ color: var\(--dm-tick-read\); \}/, 'the read check reads its token')
  for (const t of themes) {
    const bg = hex(rootToken(t.root, '--bg')), inkStrong = hex(rootToken(t.root, '--ink-strong'))
    const sent = hex(tickOf(t, 'sent')), read = hex(tickOf(t, 'read')), ok = hex(okOf(t.dark))
    assert.ok(sent[0] === sent[1] && sent[1] === sent[2], `${t.name}: the sent check is a neutral grey (${tickOf(t, 'sent')})`)
    assert.ok(read[1] > read[0] + 80 && read[1] > read[2] + 50, `${t.name}: the read check is green (${tickOf(t, 'read')})`)
    assert.ok(lum(read) > lum(ok) && saturation(read) > saturation(ok) + 0.15, `${t.name}: a brighter green than the old read mark, --ok ${okOf(t.dark)}`)
    for (const a of accents) {
      const bubble = mix(hex(a), bg, 0.34)                    // --dm-out: color-mix(in srgb, var(--accent) 34%, var(--bg))
      const was = mix(inkStrong, bubble, 0.7)                 // .dm-msg.out .dm-meta: --dm-out-ink at 70% over the bubble
      assert.ok(lum(sent) < lum(was) * 0.85, `${t.name} ${a}: the sent check is darker than the old one`)
      assert.ok(contrast(sent, bubble) >= 3, `${t.name} ${a}: sent ${contrast(sent, bubble).toFixed(2)}:1 on the bubble`)
      assert.ok(contrast(read, bubble) >= 3, `${t.name} ${a}: read ${contrast(read, bubble).toFixed(2)}:1 on the bubble`)
    }
  }
})

test('the other marks keep their colours: the clock the time’s grey, a refused send the bad red', () => {
  assert.doesNotMatch(dmCss, /\.dm-tick\.t-queued \{[^}]*color/, 'the clock has no colour of its own')
  assert.doesNotMatch(dmCss, /\.dm-tick \{[^}]*color/, 'nor does the mark itself')
  assert.match(dmCss, /\.dm-tick\.t-failed \{ color: var\(--bad\); \}/)
})
