// attachenable.test.tsx — the paperclip in the USER'S OWN mail reply box was
// permanently greyed out (user report, 2026-09-17 20:17, against the running
// 2.1.8-beta.3 build).
//
// THE CAUSE, in one line. `MailReplyBox` can only upload once it knows which
// ORG to upload into:
//
//     mail.tsx   const attachable = Boolean(slug && target) && !busy && !sendDisabled
//
// and the reading pane passed that down as `slug={org}` — `org` being an
// OPTIONAL prop of `MailList`. The user's inbox (`App.tsx`, the ONE MailList
// in the whole app that supplies `onReply`, so the only one that renders a
// reply box at all) never passed `org`. It passes `refs` instead, which is
// where the same file already reads the org from everywhere else:
//
//     mail.tsx:628   org={org ?? refs?.world.org ?? ""}
//
// So the value was present the whole time, one line away, and the reply box
// was handed `undefined`. THIS IS PRE-EXISTING, not a regression from
// 99e841a: the identical `attachable` line is at bd4ee60:mail.tsx:763. What
// 99e841a changed is that the dead control became a VISIBLE paperclip instead
// of a text button, which is why it got reported now.
//
// ⚠ WHAT THIS FILE PROVES, AND HOW. §1 and §2 mount the REAL `InboxPanel`
// against a fake server and read the REAL button's `disabled` property — not
// a hand-copied prop list, because the bug WAS the prop list. That is the
// user's actual path and `disabled` is the actual symptom, so unlike the
// geometry tickets this one is measurable in jsdom: there is no pixel in the
// claim. §3 is the negative half — the gate must stay shut when there is
// genuinely nowhere to upload to — and §5 pins the finding about the other
// two composers.
//
// Run:  node apps/desktop/renderer/tests/run.mjs attachenable

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { InboxPanel } from '../src/App'
import { MailReplyBox } from '../src/canvas/mail'
import { resetConvos } from '../src/convo'
import type { TreePayload } from '../src/types'

declare const __SRC_DIR__: string

const src = (rel: string) => readFileSync(path.join(__SRC_DIR__, rel), 'utf8')

const noop = () => {}
// jsdom has no layout; the product's jump handler calls this for real.
window.HTMLElement.prototype.scrollIntoView = noop

const tree = {
  slug: 'mine', roots: [], audiences: [], credit_requests: [], asks: [],
  tiers: {}, fable_lock: null,
} as unknown as TreePayload

const inboxMail = {
  id: 'm1', from: 'alpha', kind: 'message', at: '2026-09-17T10:00:00Z',
  body: 'Could you send me the log?',
}

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  })

/** Mount the user's inbox exactly as the app does and return its reply box.
 *  Nothing here is a fixture reproduction of App.tsx's prop list — it IS
 *  App.tsx's prop list, reached through the exported panel, which is the only
 *  way a test can catch a missing prop at that call site. */
async function userInbox(t: { after: (fn: () => unknown) => void }) {
  resetConvos()
  const saved = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url)
    if (url.endsWith('/inbox')) {
      return response({ pending: [inboxMail], delivered: [], sent: [] })
    }
    return response({})
  }) as typeof fetch
  const view = await mountView(
    <InboxPanel slug="mine" tree={tree} toast={noop} close={noop} jumpTo={null} />,
    (h) => h)
  t.after(async () => {
    await view.unmount(); globalThis.fetch = saved; resetConvos()
  })
  await flush()
  return view
}

const replyBoxIn = (el: HTMLElement) => {
  const box = el.querySelector('.mail-reply') as HTMLElement | null
  assert.ok(box, 'positive control: the user inbox renders a reply box for an '
    + 'ordinary agent mail — if this fails the rest of the file proves nothing')
  return box
}

const attachIn = (box: HTMLElement) => {
  const btn = box.querySelector('.cc-attach') as HTMLButtonElement | null
  assert.ok(btn, 'positive control: the reply box draws an attach button')
  return btn
}

// ------------------------------------------- §1 the user's actual complaint

test('§1 the attach button in the USER\'S mail reply box is clickable — the '
  + 'real InboxPanel, the real button, the real `disabled` property',
  async (t) => {
  const view = await userInbox(t)
  const box = replyBoxIn(view.el)
  const attach = attachIn(box)
  assert.equal(attach.disabled, false,
    'the user can see the paperclip and must be able to click it: a reply to '
    + 'an ordinary agent has both an org and a recipient, so attaching IS '
    + 'possible and the control must say so')
})

test('§2 …and clicking it actually reaches the hidden file input rather than '
  + 'being enabled-but-dead', async (t) => {
  // "Do not weaken the gate to make the button look enabled" (ticket): an
  // enabled control that no-ops on click is worse than a greyed one. The
  // button's whole job is to open the file picker, so that is what is
  // measured — `click()` on the input is what the browser would raise the
  // picker for, and jsdom records it.
  const view = await userInbox(t)
  const box = replyBoxIn(view.el)
  const input = box.querySelector('input[type=file]') as HTMLInputElement
  assert.ok(input, 'the reply box owns a file input')
  let opened = 0
  input.click = () => { opened++ }
  await inAct(() => attachIn(box).click())
  await flush()
  assert.equal(opened, 1, 'the enabled button opens the picker')
})

test('§2b …and the upload it forms is addressed to the RIGHT org and the '
  + 'RIGHT recipient — the whole point of the value that was missing',
  async (t) => {
  // The strongest statement available without a browser: the button being
  // enabled is worthless if the request it builds is `/api/orgs/undefined/…`.
  // `uploadFile(slug, nid, file)` POSTs to
  // `/api/orgs/<slug>/nodes/<nid>/upload?name=…`, so the URL carries both
  // halves of the gate and proves the recovered value is the CORRECT one
  // rather than merely truthy.
  const urls: string[] = []
  const saved = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url)
    if (url.includes('/upload')) {
      urls.push(url)
      return response({ path: 'uploads/note.txt', bytes: 4 })
    }
    if (url.endsWith('/inbox')) {
      return response({ pending: [inboxMail], delivered: [], sent: [] })
    }
    void init
    return response({})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = saved })

  const view = await mountView(
    <InboxPanel slug="mine" tree={tree} toast={noop} close={noop} jumpTo={null} />,
    (h) => h)
  t.after(async () => { await view.unmount(); resetConvos() })
  await flush()

  const box = replyBoxIn(view.el)
  const input = box.querySelector('input[type=file]') as HTMLInputElement
  const file = new File(['abcd'], 'note.txt', { type: 'text/plain' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await inAct(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await flush()

  assert.equal(urls.length, 1, 'choosing a file issues exactly one upload')
  assert.match(urls[0]!, /\/api\/orgs\/mine\/nodes\/alpha\/upload\?name=note\.txt$/,
    `the upload must name the org on screen and the mail's sender; got ${urls[0]}`)
  // and it is really staged on the draft, so the send would carry it. The
  // chip row is a SIBLING of `.mail-reply`, not a child (both sit in the
  // component's fragment), so this reads the whole panel.
  await flush()
  const chip = view.el.querySelector('.attach-row .attach-chip')
  assert.ok(chip, 'the upload result is staged as a chip on the draft')
  assert.match(chip.textContent ?? '', /note\.txt/,
    'and the chip names the file that was attached')
})

// ------------------------------------------------ §3 the gate is NOT widened

test('§3 CONTROL — attach stays disabled when there is genuinely nowhere to '
  + 'upload to', async () => {
  // Both halves of `Boolean(slug && target)` still bite. An upload lands in
  // the RECIPIENT's folder inside a named ORG; missing either one means the
  // request cannot be formed, and the button must keep saying so.
  const cases: [string, { target?: string; slug?: string }][] = [
    ['no org', { target: 'alpha' }],
    ['no recipient', { slug: 'mine' }],
    ['neither', {}],
  ]
  for (const [why, props] of cases) {
    const view = await mountView(
      <MailReplyBox {...props} onSend={noop} />, (h) => h)
    try {
      const btn = attachIn(view.el.querySelector('.mail-reply') as HTMLElement)
      assert.equal(btn.disabled, true,
        `${why}: the upload cannot be addressed, so the control must be dead`)
    } finally { await view.unmount() }
  }

  // and the positive control for the same component, so §3 cannot pass by
  // the button being disabled for some unrelated reason
  const ok = await mountView(
    <MailReplyBox target="alpha" slug="mine" onSend={noop} />, (h) => h)
  try {
    assert.equal(attachIn(ok.el.querySelector('.mail-reply') as HTMLElement)
      .disabled, false, 'given both, it is enabled')
  } finally { await ok.unmount() }
})

// ------------------------------------------------- §4 one resolution, not two

test('§4 the reply box is handed the org by the SAME resolution the rest of '
  + 'mail.tsx already uses, not a second one invented here', () => {
  // The file had exactly one way to answer "which org is on screen" and the
  // reply-box line was the one place that did not use it. A future edit that
  // re-diverges them — a different fallback chain, a hard-coded '' — is the
  // regression this test exists for.
  const text = src('canvas/mail.tsx')
  const line = text.split('\n')
    .find((l) => l.includes('<MailReplyBox') && l.includes('slug='))
  assert.ok(line, 'the reading pane still renders a MailReplyBox with a slug')
  const m = line.match(/slug=\{([^}]*)\}/)
  assert.ok(m, `could not read the slug expression from: ${line.trim()}`)
  const expr = m[1]!.trim()
  assert.ok(/\borg\b/.test(expr) && /refs\?\.world\.org/.test(expr),
    'the reply box must fall back to refs.world.org exactly as the EventCard '
    + `line above it does; got slug={${expr}}`)
})

// ----------------------------------------- §5 the other two composers, stated

test('§5 the ticket-reply and presentation-reply composers cannot have the '
  + 'same hole — their slug is a REQUIRED string, checked at the source',
  () => {
  // The finding, pinned so it stays true. `MailReplyBox.slug` is optional by
  // design (graceful degradation), which is precisely why App.tsx's omission
  // type-checked. The docket and gallery hosts take `slug: string` — NOT
  // `slug?: string` — from a parent that renders them only behind a truthy
  // `slug &&` guard, so under `strict: true` neither undefined nor a
  // compile-time-absent value can reach their reply box.
  for (const [file, fn] of [
    ['canvas/docket.tsx', 'DocketPane'],
    ['canvas/gallery.tsx', 'DocPane'],
  ] as const) {
    const text = src(file)
    const at = text.indexOf(`function ${fn}(`)
    assert.ok(at > 0, `${fn} still exists in ${file}`)
    const props = text.slice(at, at + 1200)
    assert.match(props, /\n\s*slug: string\b/,
      `${fn} must declare slug as a required string, not an optional one`)
    assert.ok(props.includes('slug={slug}')
      || text.slice(at).slice(0, 12000).includes('slug={slug}'),
      `${fn} passes its own slug straight down`)
  }
  // and the guard at the top: the modals do not mount without an org
  const app = src('App.tsx')
  for (const modal of ['DocGalleryModal', 'DocketModal']) {
    const at = app.indexOf(`<${modal} `)
    assert.ok(at > 0, `${modal} is still rendered from App.tsx`)
    const before = app.slice(Math.max(0, at - 200), at)
    assert.match(before, /slug &&/,
      `${modal} must be mounted only when the org slug is known`)
  }
})
