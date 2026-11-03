// usernomark.test.tsx — THE @user MENTION CARRIES NO MAIL ICON
// (USER 2026-11-03 21:09:07Z m2ba1f3a2299a "remove the mail icon on user mentions"; 21:12:54Z m2157b88ea18e
// "its literally attached to the user mention"). @user resolves as a `mail` ref (box user, id @user), and the markdown
// chip path drew the kind's envelope mark on every ready chip, so a message that starts "@user ..." wore a ✉ before it.
// The @user chip is a plain identity link (UserIdentityLink draws none on the React path); the mail mark stays on
// real @mail: links.
//
// Run:  node apps/desktop/renderer/tests/run.mjs usernomark
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'
import { linkifyRefs } from '../src/canvas/refmd'
import { md } from '../src/canvas/shared'
import type { RefWorld } from '../src/canvas/reflinks'

declare const __SRC_DIR__: string
const world: RefWorld = { org: 'org', agents: new Map([['worker', 'worker']]), tierOf: () => 'haiku' }

function chips(markdown: string) {
  const host = document.createElement('div')
  host.innerHTML = md(markdown).__html
  linkifyRefs(host, world)
  return host
}

test('a message that starts with @user draws no envelope on the @user chip (live and static)', () => {
  for (const text of ['@user Done — Novapup now has a Quest variant.', 'Heads up @user — build finished', '> quoted\n\n**@user** hi']) {
    const host = chips(text)
    const user = host.querySelector<HTMLElement>('.ref-chip[data-ref-token="@user"]')
    assert.ok(user, '@user is a chip: ' + text)
    assert.equal(user!.querySelector('svg, .ref-mark'), null, 'no mark inside the @user chip: ' + text)
    assert.equal(user!.textContent, '@user')
    assert.equal(host.querySelector('.ref-mark-mail'), null, 'and no mail mark attached beside it')
  }
})

test('the mail mark itself stays for real mail links', () => {
  const refmd = readFileSync(joinPath(__SRC_DIR__, 'canvas/refmd.tsx'), 'utf8')
  assert.match(refmd, /createRefMarkEl\(doc, r\.ref\.kind\)/, 'other kinds keep their mark in DOM chips')
  const marks = readFileSync(joinPath(__SRC_DIR__, 'canvas/refmarks.tsx'), 'utf8')
  assert.match(marks, /mail: 'M22 6c0-1\.1/, 'the @mail: link mark is unchanged')
})
