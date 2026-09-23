// composerparity.test.tsx — the two composer inconsistencies the user raised
// on 2026-09-17:
//
//   1. the file-attachment control drew a DIFFERENT glyph depending on which
//      composer you were in, so the same action looked like a different
//      feature;
//   2. the notice-send toggle existed in the desk composer and nowhere else,
//      so every other message box could only send ordinary waking mail.
//
// ⚠ WHAT THIS FILE CAN AND CANNOT PROVE. Everything here is jsdom: it reads
// the real components and the real stylesheet TEXT, so it pins structure,
// wire shape and the presence of a CSS rule. It cannot measure a rendered
// pixel — jsdom has no layout and no cascade. "The toggle sits ABOVE the
// attach button" is asserted here as DOM ORDER INSIDE THE COLUMN, which is
// necessary but not sufficient. The geometry and the computed border colour
// in both themes are measured in a real browser by
// `composer_parity_probe.py`, which is the actual evidence for the visual
// half of this ticket. Read that file's header before trusting this one.
//
// Run:  node apps/desktop/renderer/tests/run.mjs composerparity
import './harness'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MailList, MailReplyBox } from '../src/canvas/mail'
import { DeskChat } from '../src/canvas/desk'
import { resetNoticeStore, setNoticeArmed } from '../src/noticestore'
import { resetConvos } from '../src/convo'
import type { CanvasNode, MailEntry } from '../src/types'

declare const __SRC_DIR__: string

const src = (rel: string) =>
  readFileSync(path.join(__SRC_DIR__, rel), 'utf8')

/** the MUI icon component actually rendered inside `el`, by the data-testid
 *  every `@mui/icons-material` export carries (`AttachFileIcon`, …). Reading
 *  the glyph rather than the import is the point: an import can be present
 *  and unused, and it is the drawn glyph the user is complaining about. */
const glyphOf = (el: Element | null): string | null =>
  el?.querySelector('svg')?.getAttribute('data-testid') ?? null

/** THE unified glyph (docket decision #1): MUI `AttachFile`, the paperclip.
 *  The main composer used to be the only control drawing
 *  `InsertDriveFileOutlined`, so it is the one that moved. */
const ATTACH_GLYPH = 'AttachFileIcon'

// ---------------------------------------------------------------- §1 icons

test('§1 EVERY attach control in the app draws the one agreed glyph — checked '
  + 'at the source, so a NEW composer cannot quietly add a fifth variant',
  () => {
  // The invariant is expressed over the thing that MAKES a button an
  // attachment control — it opens the hidden file input — rather than over a
  // class name, because two of the four controls do not share a class and one
  // of them has no class of its own at all. Any future attach button will
  // match this scan the moment it is written.
  const files = ['canvas/desk.tsx', 'canvas/docket.tsx', 'canvas/mail.tsx']
  const sites: { file: string; line: number; glyph: string | null }[] = []
  for (const f of files) {
    const lines = src(f).split('\n')
    lines.forEach((ln, i) => {
      if (!ln.includes('fileRef.current?.click()')) return
      // the glyph rides the button's own children, which follow the onClick
      // within a couple of lines in every one of these call sites
      const near = lines.slice(i, i + 4).join('\n')
      const m = near.match(/<([A-Za-z]+Icon)\b/)
      sites.push({ file: f, line: i + 1, glyph: m ? m[1]! : null })
    })
  }
  assert.equal(sites.length, 4,
    'positive control: the four known attach controls are all still found — '
    + 'if this number changed, the new site must be judged, not skipped. '
    + `found: ${JSON.stringify(sites)}`)
  for (const s of sites) {
    assert.equal(s.glyph, 'AttachIcon',
      `${s.file}:${s.line} draws ${s.glyph} — every attachment control must `
      + 'draw AttachIcon (the paperclip). See docket decision #1.')
  }
  // and `AttachIcon` is that one glyph, not a second alias for the old one
  assert.match(src('icons.ts'),
    /export \{ default as AttachIcon \} from '@mui\/icons-material\/AttachFile'/)
})

test('§1b the desk composer renders the paperclip — the control that changed',
  async () => {
  localStorage.clear()
  resetConvos()
  resetNoticeStore()
  installFetch(new FakeServer())
  const node: CanvasNode = {
    id: 'agent-a', generation: 1, state: 'live', tier: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  }
  const view = await mountView(
    <DeskChat node={node} map={new Map([[node.id, node]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  try {
    const attach = view.el.querySelector('.cc-composer .cc-attach')
    assert.ok(attach, 'positive control: the composer has an attach button')
    assert.equal(glyphOf(attach), ATTACH_GLYPH,
      'the desk composer used to draw InsertDriveFileOutlinedIcon here')
    // the STAGED-ATTACHMENT CHIP is a listing, not a control, and is
    // deliberately NOT part of the unification — pinned so a later sweep
    // does not "finish the job" by changing it too
    assert.match(src('canvas/desk.tsx'), /<FileIcon fontSize="inherit" \/> \{a\.name\}/)
  } finally { await view.unmount() }
})

test('§1c the reply composer renders the SAME paperclip — compared as DRAWN '
  + 'path data, because "the same name" is not the same picture', async () => {
  localStorage.clear()
  resetConvos()
  resetNoticeStore()
  installFetch(new FakeServer())
  const node: CanvasNode = {
    id: 'agent-a', generation: 1, state: 'live', tier: 'haiku', children: [],
    seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] },
  }
  const desk = await mountView(
    <DeskChat node={node} map={new Map([[node.id, node]])} slug="org"
      op={async () => ({})} toast={() => {}} pub={false} bare />, el => el)
  const reply = await mountView(
    <MailReplyBox target="agent-b" slug="org" onSend={() => {}} />, el => el)
  try {
    const a = desk.el.querySelector('.cc-composer .cc-attach svg')
    const b = reply.el.querySelector('.mail-reply .cc-attach svg')
    assert.ok(a && b, 'positive control: both composers drew an icon at all')
    assert.equal(glyphOf(reply.el.querySelector('.mail-reply .cc-attach')), ATTACH_GLYPH)
    // the actual vector, not the component name: two different exports can
    // share a testid prefix, and only the path is what a user sees
    const d = (svg: Element) => [...svg.querySelectorAll('path')]
      .map(p => p.getAttribute('d')).join('|')
    assert.ok(d(a).length > 20, 'positive control: the path data is real')
    assert.equal(d(a), d(b),
      'the desk composer and the reply composer draw the identical glyph — '
      + 'this is the user\'s complaint, stated as an assertion')
  } finally { await reply.unmount(); await desk.unmount() }
})

// -------------------------------------------------------- §2 notice toggle

/** mount a reply box and hand back the pieces every test below pokes at */
async function replyBox(props: Parameters<typeof MailReplyBox>[0] = { onSend: () => {} }) {
  const view = await mountView(<MailReplyBox {...props} />, el => el)
  const box = () => view.el.querySelector('.mail-reply') as HTMLElement
  return {
    view,
    box,
    stack: () => view.el.querySelector('.mail-reply .cc-btnstack') as HTMLElement,
    toggle: () => view.el.querySelector('.mail-reply .cc-notice-toggle') as HTMLButtonElement,
    attach: () => view.el.querySelector('.mail-reply .cc-attach') as HTMLButtonElement,
    textarea: () => view.el.querySelector('.mail-reply textarea') as HTMLTextAreaElement,
    send: () => view.el.querySelector('.mail-reply-send') as HTMLButtonElement,
    type: async (t: string) => {
      const ta = view.el.querySelector('.mail-reply textarea') as HTMLTextAreaElement
      await inAct(() => {
        const set = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value')?.set
        set?.call(ta, t)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await flush()
    },
  }
}

test('§2 the reply composer stacks the notice toggle ABOVE the attach button, '
  + 'in the same column the desk composer uses', async () => {
  const r = await replyBox({ target: 'agent-b', slug: 'org', onSend: () => {} })
  try {
    assert.ok(r.stack(), 'the reply box has a .cc-btnstack column')
    assert.equal(r.toggle().parentElement, r.stack())
    assert.equal(r.attach().parentElement, r.stack())
    assert.equal(r.toggle().nextElementSibling, r.attach(),
      'toggle first, attach second — in a column that is "above"')
    assert.deepEqual([...r.stack().children].map(c => c.className.split(' ')[0]),
      ['cc-notice-toggle', 'cc-attach'],
      'exactly those two controls, in that order — same as .cc-composer')
  } finally { await r.view.unmount() }
})

test('§2b it starts OFF, arms on click, and the composer wears the armed edge',
  async () => {
  const r = await replyBox({ target: 'agent-b', slug: 'org', onSend: () => {} })
  try {
    assert.equal(r.toggle().classList.contains('armed'), false, 'default is OFF')
    assert.equal(r.box().classList.contains('notice-armed'), false)
    await inAct(() => r.toggle().click())
    await flush()
    assert.equal(r.toggle().classList.contains('armed'), true)
    assert.equal(r.box().classList.contains('notice-armed'), true,
      'the composer itself says it is armed — the dotted edge hangs off this class')
    await inAct(() => r.toggle().click())
    await flush()
    assert.equal(r.toggle().classList.contains('armed'), false, 'and it turns back off')
    assert.equal(r.box().classList.contains('notice-armed'), false)
  } finally { await r.view.unmount() }
})

test('§2c Alt+N in the draft toggles it, and does not send', async () => {
  let sends = 0
  const r = await replyBox({ target: 'agent-b', slug: 'org', onSend: () => { sends++ } })
  try {
    await r.type('a reply with text in it')
    await inAct(() => {
      r.textarea().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'n', altKey: true, bubbles: true }))
    })
    await flush()
    assert.equal(r.toggle().classList.contains('armed'), true, 'Alt+n armed it')
    assert.equal(sends, 0, 'Alt+N is not a send')
    // the capital is the same chord with shift held — the desk accepts both
    await inAct(() => {
      r.textarea().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'N', altKey: true, bubbles: true }))
    })
    await flush()
    assert.equal(r.toggle().classList.contains('armed'), false, 'Alt+N disarmed it')
    // CONTROL: a bare `n` types a letter, it does not toggle anything
    await inAct(() => {
      r.textarea().dispatchEvent(new KeyboardEvent('keydown',
        { key: 'n', bubbles: true }))
    })
    await flush()
    assert.equal(r.toggle().classList.contains('armed'), false,
      'control: `n` without Alt is just a letter')
  } finally { await r.view.unmount() }
})

test('§2d an ARMED send passes notice=true and disarms; an unarmed one passes '
  + 'false and the toggle is untouched', async () => {
  const calls: { text: string; attachments?: string[]; notice?: boolean }[] = []
  const r = await replyBox({ target: 'agent-b', slug: 'org',
    onSend: (text, attachments, notice) => { calls.push({ text, attachments, notice }) } })
  try {
    await r.type('first, ordinary')
    await inAct(() => r.send().click())
    await flush()
    assert.deepEqual(calls[0], { text: 'first, ordinary', attachments: undefined, notice: false })
    assert.equal(r.toggle().classList.contains('armed'), false)

    await r.type('second, as a notice')
    await inAct(() => r.toggle().click())
    await flush()
    await inAct(() => r.send().click())
    await flush()
    assert.deepEqual(calls[1], { text: 'second, as a notice', attachments: undefined, notice: true })
    // DISARMS ON SEND ONLY — b38d9d9 §3. The next reply is ordinary again
    // unless the user arms it again, which is the whole safety of the thing.
    assert.equal(r.toggle().classList.contains('armed'), false,
      'sending disarmed it')
    assert.equal(r.box().classList.contains('notice-armed'), false)

    await r.type('third')
    await inAct(() => r.send().click())
    await flush()
    assert.equal(calls[2]!.notice, false, 'and the send after it is ordinary')
  } finally { await r.view.unmount() }
})

test('§2e armed state does NOT leak between composers — it is per box, not a '
  + 'shared singleton like the desk\'s', async () => {
  const view = await mountView(
    <div>
      <div className="one"><MailReplyBox target="a" slug="org" onSend={() => {}} /></div>
      <div className="two"><MailReplyBox target="b" slug="org" onSend={() => {}} /></div>
    </div>, el => el)
  try {
    const t = (sel: string) =>
      view.el.querySelector(`${sel} .cc-notice-toggle`) as HTMLButtonElement
    await inAct(() => t('.one').click())
    await flush()
    assert.equal(t('.one').classList.contains('armed'), true)
    assert.equal(t('.two').classList.contains('armed'), false,
      'the second composer did not inherit the first one\'s armed state')
    // and the DESK\'s global store is not what drives these
    setNoticeArmed('org/a', true)
    await flush()
    assert.equal(t('.two').classList.contains('armed'), false,
      'nor does the desk composer\'s global noticestore reach in here')
    resetNoticeStore()
  } finally { await view.unmount() }
})

test('§2f a composer whose recipient can never take a notice renders no '
  + 'toggle at all, rather than a dead control', async () => {
  const r = await replyBox({ target: 'agent-b', slug: 'org', notice: false,
    onSend: () => {} })
  try {
    assert.equal(r.toggle(), null, 'no toggle')
    assert.ok(r.attach(), 'positive control: the attach button is still there')
    assert.equal(r.stack().children.length, 1)
  } finally { await r.view.unmount() }
})

test('§2g the toggle is NOT greyed out for an unreachable recipient — the '
  + 'server decides, and falls back to ordinary mail silently', async () => {
  // b38d9d9 §4. It follows the draft's own availability (busy / sendDisabled)
  // and nothing else; guessing at deliverability in the renderer is exactly
  // the behaviour the reference implementation refused.
  const live = await replyBox({ target: 'agent-b', slug: 'org', onSend: () => {} })
  try {
    assert.equal(live.toggle().disabled, false)
    assert.equal(live.attach().disabled, false)
  } finally { await live.view.unmount() }

  const off = await replyBox({ target: 'agent-b', slug: 'org', sendDisabled: true,
    onSend: () => {} })
  try {
    assert.equal(off.toggle().disabled, true,
      'a composer that cannot send at all cannot arm either')
  } finally { await off.view.unmount() }

  // no recipient resolved yet: attach needs one (it uploads INTO the
  // recipient's folder), the notice toggle does not — it only sets a flag
  const noTarget = await replyBox({ slug: 'org', onSend: () => {} })
  try {
    assert.equal(noTarget.attach().disabled, true, 'control: attach still needs a target')
    assert.equal(noTarget.toggle().disabled, false)
  } finally { await noTarget.view.unmount() }
})

// ------------------------------------------------------- §3 the mail reply

const mailRow = (o: Partial<MailEntry> = {}): MailEntry => ({
  id: 'm1', from: 'agent-b', at: '2026-09-17T10:00:00.000Z', kind: 'message',
  text: 'a question for you', ...o,
} as MailEntry)

test('§3 the MAIL reply box forwards the armed flag to its host', async () => {
  const seen: unknown[][] = []
  const view = await mountView(
    <MailList delivered={[mailRow()]}
      onReply={(...args: unknown[]) => { seen.push(args) }} />, el => el)
  try {
    await inAct(() => (view.el.querySelector('.mailrow') as HTMLElement).click())
    await flush()
    const box = view.el.querySelector('.mail-reply') as HTMLElement
    assert.ok(box, 'positive control: selecting a mail reveals the reply box')
    const toggle = box.querySelector('.cc-notice-toggle') as HTMLButtonElement
    assert.ok(toggle, 'the mail reply box has the notice toggle')
    const ta = box.querySelector('textarea') as HTMLTextAreaElement
    await inAct(() => {
      const set = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value')?.set
      set?.call(ta, 'noted')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    await inAct(() => toggle.click())
    await flush()
    await inAct(() => (box.querySelector('.mail-reply-send') as HTMLButtonElement).click())
    await flush()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]![3], true,
      'onReply(mail, text, attachments, notice) — the 4th argument is the flag')
  } finally { await view.unmount() }
})

// ----------------------------------------------------------------- §4 CSS

test('§4 the armed reply composer has a real CSS rule, and it is the SHARED '
  + 'notice edge style with the provider colour — not a second hand-written '
  + 'dotted border that can drift', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = css.match(/\.mail-reply\.notice-armed \{([^}]*)\}/)
  assert.ok(rule, '.mail-reply.notice-armed exists')
  assert.match(rule[1]!, /border-style:\s*var\(--notice-edge-style\)/,
    'the STYLE comes from the shared token, exactly as .cc-composer.notice-armed does')
  assert.match(rule[1]!, /border-color:\s*var\(--accent\)/,
    'the COLOUR is the provider accent (user 2026-09-17), never the neutral grey')
  assert.match(css, /\.mail-reply\.notice-armed:focus-within \{ border-color: var\(--accent\); \}/,
    'focusing the draft must not wash the armed colour away')
  // and it stays in step with the desk composer's own rule
  const desk = css.match(/\.cc-composer\.notice-armed \{([^}]*)\}/)
  assert.ok(desk)
  const decls = (s: string) => s.split(';').map(x => x.trim()).filter(Boolean).sort()
  assert.deepEqual(decls(rule[1]!), decls(desk[1]!),
    'the two armed composers wear the identical edge')
})

test('§4b the reply draft is TOP-aligned, for the same measured reason the '
  + 'desk draft is', () => {
  // The button column is now 24 + 4 + 24 = 52px and `.mail-reply` is
  // `align-items: flex-end`, so without this the shorter textarea is pushed
  // to the bottom and the text floats below a band of blank space — the
  // exact complaint that produced `.cc-composer textarea`'s own rule.
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const rule = css.match(/\.mail-reply textarea \{([^}]*)\}/)
  assert.ok(rule)
  assert.match(rule[1]!, /align-self:\s*flex-start/)
  assert.doesNotMatch(rule[1]!, /align-self:\s*stretch/,
    'NOT stretch: nothing here writes an explicit height, but the desk rule '
    + 'rejected stretch for a reason and the two must not diverge')
})
