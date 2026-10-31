// mentionfaint.test.tsx — mail that mentions the user wears a FAINT theme tint, nothing that reads as a selection.
//
// USER 2026-10-31 08:48:40Z mf2fd4eb092b4, verbatim: "also change the blue
// background from mention mail, it's distracting and makes it look like it's
// selected when it isnt"; 08:48:56Z ma9c2e2bbee12: "the theme highlighted
// background i mean"; 08:49:29Z m3403be06a732: "it can still be the theme
// color, just not as bright so it doesnt look like its selected". A mention row
// kept its 12% accent tint, a step from the selected row's 13%, so an unread
// mention looked selected in every theme. The tint stays the theme's accent but
// is a fraction of the selection fill, and NOTHING new marks the row (no badge,
// no bar): only the strength changes. Docket
// mail-that-mentions-the-user-remove-the-blue-back.
//
// Mention mail is `mailbox_attention` mail: the engine marks it without forging
// `urgent`, so its row wears `.urgent` and NOT `.urgent-mail` (the orange,
// genuinely urgent kind, which keeps its tint). The first suite pins that class
// split and that the row gained no element, the second reads the stylesheets.
import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MailRowView } from '../src/canvas/mail'
import { MentionRowView } from '../src/attention/mentionrow'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'

declare const __SRC_DIR__: string

const mail = (extra: Record<string, unknown>) => ({ id: 'm1', from: 'lead', kind: 'message', at: '2026-10-31T08:00:00Z',
  body: 'Release update', ...extra }) as never
const row = (extra: Record<string, unknown>, selected = false) =>
  <MailRowView m={mail(extra)} view={null} selected={selected} party="lead" onClick={() => {}} />
const classes = (el: HTMLElement) => [...(el.querySelector('.mailrow')?.classList ?? [])]

test('§1 a mention mail row is .urgent without .urgent-mail; plain mail wears neither; urgent mail wears both', async t => {
  const mention = await mountView(row({ mailbox_attention: true }), el => el)
  const plain = await mountView(row({}), el => el)
  const urgent = await mountView(row({ urgent: true, urgent_reason: 'build is down' }), el => el)
  t.after(async () => { await mention.unmount(); await plain.unmount(); await urgent.unmount() })
  assert.equal(classes(plain.el).includes('mailrow'), true, 'positive control: the row rendered')
  assert.deepEqual(classes(mention.el).filter(c => c.startsWith('urgent')), ['urgent'])
  assert.deepEqual(classes(plain.el).filter(c => c.startsWith('urgent')), [])
  assert.deepEqual(classes(urgent.el).filter(c => c.startsWith('urgent')).sort(), ['urgent', 'urgent-mail'])
})

test('§1 a mention row adds no badge or element of its own: same elements as plain mail', async t => {
  const mention = await mountView(row({ mailbox_attention: true }), el => el)
  const plain = await mountView(row({}), el => el)
  t.after(async () => { await mention.unmount(); await plain.unmount() })
  const shape = (el: HTMLElement) => [...el.querySelectorAll('.mailrow, .mailrow *')]
    .map(e => e.tagName + '.' + [...e.classList].filter(c => c !== 'urgent').join('.'))
  assert.ok(shape(plain.el).length > 3, 'positive control: the row has its lines')
  assert.deepEqual(shape(mention.el), shape(plain.el))
})

test('§1 the Attention list\'s mention row wears the same .urgent row, selected or not', async t => {
  const v = await mountView(<MentionRowView mention={{ id: '1:0', blurb: 'see @user here', at: '2026-10-31T08:00:00Z' }}
    party="worker-a" selected={false} onClick={() => {}} />, el => el)
  t.after(() => v.unmount())
  assert.deepEqual(classes(v.el).filter(c => c.startsWith('urgent')), ['urgent'])
})

test('§1 a transcript message with @user wears .mention-highlight, a plain one does not', async t => {
  const m = (text: string) => ({ role: 'assistant', text, tools: [] } as unknown as ChatMessage)
  const v = await mountView(<><Msg m={m('Please review @user.')} slug="o" nid="w" /><Msg m={m('Nothing to see.')} slug="o" nid="w" /></>, el => el)
  t.after(() => v.unmount())
  const msgs = [...v.el.querySelectorAll('.msg.assistant')]
  assert.equal(msgs.length, 2, 'positive control: both rendered')
  assert.deepEqual(msgs.map(x => x.classList.contains('mention-highlight')), [true, false])
})

// ---- the stylesheets --------------------------------------------------------

type Rule = { file: string; sel: string[]; body: string }
const SRC = __SRC_DIR__
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? cssFiles(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : [])
}
/** every `selector-list { declarations }` of the renderer's stylesheets, comments gone, at-rule headers dropped */
const RULES: Rule[] = cssFiles(SRC).flatMap(file => {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    file: path.relative(SRC, file).replace(/\\/g, '/'),
    sel: (m[1] ?? '').split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean),
    body: m[2] ?? '',
  }))
})
const rulesFor = (re: RegExp) => RULES.filter(r => r.sel.some(s => re.test(s)))
const show = (rs: Rule[]) => rs.map(r => `${r.file}: ${r.sel.join(', ')} { ${r.body.trim().replace(/\s+/g, ' ')} }`).join('\n')
/** the accent's share, in percent, of a rule's `background: color-mix(in srgb, <accent> N%, …)` (NaN: no such background) */
const tint = (r: Rule | undefined, accent = 'var\\(--accent\\)') =>
  r ? Number(new RegExp(`(?:^|[;\\s])background:\\s*color-mix\\(in srgb,\\s*${accent}\\s+(\\d+(?:\\.\\d+)?)%`).exec(r.body)?.[1] ?? NaN) : NaN
const one = (re: RegExp) => { const rs = rulesFor(re); assert.equal(rs.length, 1, `exactly one rule for ${re}:\n${show(rs)}`); return rs[0]! }

const SELECTED = () => tint(one(/^\.mailrow\.on$/))
/** FAINT: at most this share of the accent, and under half the plain selection fill */
const MAX_TINT = 6
const faint = (n: number, what: string) => {
  assert.ok(Number.isFinite(n) && n > 0, `${what} stays the theme's accent tint (got ${n})`)
  assert.ok(n <= MAX_TINT, `${what} is faint: ${n}% accent must be at most ${MAX_TINT}%`)
  assert.ok(n * 2 < SELECTED(), `${what} is clearly lighter than the selection fill: ${n}% vs ${SELECTED()}%`)
}

test('§2 the selection fill is the yardstick: a themed tint well above the faint ceiling', () => {
  assert.ok(SELECTED() >= 12, 'positive control: .mailrow.on is ' + SELECTED() + '%')
})

test('§2 a .mailrow.urgent row (mention mail) rests on a faint accent tint, and hovers on the same faint one', () => {
  faint(tint(one(/^\.mailrow\.urgent$/)), 'the resting mention row')
  faint(tint(one(/^\.mailrow\.urgent:hover$/)), 'the hovered mention row')
})

test('§2 a selected mention row keeps the selected look: at least the plain selection fill', () => {
  assert.ok(tint(one(/^\.mailrow\.urgent\.on$/)) >= SELECTED(), 'selection is never fainter than a plain row\'s')
})

test('§2 a .msg.mention-highlight transcript message wears a faint accent tint and keeps its inset edge', () => {
  const r = one(/^\.msg\.mention-highlight$/)
  faint(tint(r), 'the mention message')
  assert.match(r.body, /box-shadow:\s*inset 2px 0 0 color-mix\(in srgb, var\(--accent\)/, 'the existing edge is untouched')
})

test('§2 nothing new marks a mention: no pseudo-element, badge or extra rule for these rows', () => {
  assert.equal(rulesFor(/\.mailrow\.urgent(?![\w-]).*::(before|after)|\.mention-highlight.*::(before|after)/).length, 0)
  const mentionRules = rulesFor(/attn-mention-row|\.mention-highlight|^\.mailrow\.urgent(?![\w-])/)
  assert.deepEqual(mentionRules.map(r => r.sel.join(', ')).sort(), [
    '.mailrow.urgent', '.mailrow.urgent.notice', '.mailrow.urgent.on', '.mailrow.urgent:hover', '.msg.mention-highlight'])
})

test('§2 control: genuinely urgent mail (.urgent-mail) keeps its orange tint', () => {
  assert.equal(tint(one(/^\.mailrow\.urgent-mail$/), '#ff4500'), 12)
})
