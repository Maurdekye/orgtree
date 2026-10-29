import { flush, inAct, mountView } from './harness'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { HubContactChip, setHubchatInstalled, setKnownOrgs } from '../src/canvas/agentmentions'
import { RefMdBody } from '../src/canvas/refmd'
import { resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import type { NetBlock, NetPeer } from '../src/types'

// USER 2026-10-27 m08fbc691a349 / mc96766993067: network mentions get their
// own formatting per kind; mf8697b8ba8fc / m82cf84439a0d / ma1f33944e69d: the
// icon is the party's picture, else the Hubchat mark when Hubchat is
// installed, else a globe. USER 2026-10-29 m019c9500d23a "A2 use the lettering
// on the colored background as the icon instead of the hubchat icon when
// hubchat is connected for both": with Hubchat installed the mark is
// Hubchat's DM-list avatar at text size (agreed with @hubchat-design-opus):
// the picture; an agent session's terminal, never a picture; else the
// initials on the kind's tint; a grey dot for an address no roster lists.

const rev = (n: number) => `${String(n).padStart(20, '0')}-${'0'.repeat(32)}`
const pic = (n: number, set = true): NonNullable<NetPeer['picture']> => set
  ? { revision: rev(n), sha256: 'a'.repeat(64), width: 3, height: 3, bytes: 3 }
  : { revision: rev(n), sha256: null, width: 0, height: 0, bytes: 0 }

const net = (alice: NetPeer['picture']): NetBlock => ({
  slug: 'home.000001', picture_revision: rev(7),
  hubs: [{ id: 'local', address: 'http://127.0.0.1:7370', enabled: true, connected: true, queued: 0, roster: [
    { slug: 'alice.77ded7', username: 'Alice', online: true, kind: 'person', picture: alice, picture_owner: 'o-alice' },
    { slug: 'acme.12ab34', org_name: 'Acme Labs', online: false, kind: 'org', picture_owner: 'o-acme' },
    { slug: 'claude.5e55', username: 'claude-code', online: true, kind: 'chat', picture_owner: 'o-claude' },
  ] }],
})

const TOKENS = ['@net:alice.77ded7', '@net:acme.12ab34', '@net:claude.5e55', '@net:stranger.999999',
  '@org:local-org', '@org:elsewhere', '@net:home.000001']

function fixture(t: TestContext) {
  const requests: string[] = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    const data = url.includes('alice') ? 'QUxJQ0U=' : url.includes('home.000001') ? 'SE9NRQ==' : null
    const body = url.endsWith('/api/desktop/phone') ? { hubchat_pc: false }
      : { picture: data ? { revision: rev(9), sha256: 'a'.repeat(64), width: 3, height: 3, bytes: 3, data } : null }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response
  }) as typeof fetch
  t.after(async () => {
    globalThis.fetch = oldFetch
    await inAct(async () => { resetNetMentions(); setKnownOrgs([]); setHubchatInstalled(false); await flush(2) })
  })
  return { pictures: () => requests.filter(u => u.includes('/net/profile-picture')) }
}

async function mountChips(t: TestContext) {
  const view = await mountView(<div>
    <div className="react">{TOKENS.map(a => <HubContactChip key={a} address={a} />)}</div>
    <RefMdBody className="md" world={{ org: 'home' }} html={{ __html: `<p>${TOKENS.join(' ')}</p>` }} />
  </div>, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  return (scope: 'react' | 'md') => [...view.el.querySelectorAll<HTMLElement>(`.${scope} [data-hub-address]`)]
}

const shape = (el: HTMLElement) => [el.dataset.hubAddress, el.dataset.netKind, el.dataset.netIcon,
  el.classList.contains(`net-${el.dataset.netKind}`), el.classList.contains('net-local')]

test('each network kind wears its own chip; the icon is the picture, else the DM-list avatar with Hubchat, else a globe', async t => {
  const f = fixture(t)
  setHubchatInstalled(false)
  setKnownOrgs(['local-org'])
  setNetRoster('home', net(pic(1)))
  const chips = await mountChips(t)
  const expected = [
    ['@net:alice.77ded7', 'person', 'picture', true, false],
    ['@net:acme.12ab34', 'org', 'globe', true, false],
    ['@net:claude.5e55', 'chat', 'globe', true, false],
    ['@net:stranger.999999', 'unknown', 'globe', true, false],
    ['@org:local-org', 'org', 'globe', true, true],
    ['@org:elsewhere', 'org', 'globe', true, false],
    ['@net:home.000001', 'org', 'picture', true, false],
  ]
  assert.deepEqual(chips('react').map(shape), expected)
  assert.deepEqual(chips('md').map(shape), expected, 'the Markdown chip is the same chip')
  for (const scope of ['react', 'md'] as const) {
    const [alice, acme, claude, stranger, local, elsewhere, home] = chips(scope)
    assert.equal(alice!.querySelector('.net-mark img')?.getAttribute('src'), 'data:image/png;base64,QUxJQ0U=')
    assert.equal(home!.querySelector('.net-mark img')?.getAttribute('src'), 'data:image/png;base64,SE9NRQ==')
    assert.ok(acme!.querySelector('.net-mark-globe svg path'), 'a globe without Hubchat')
    // a listed address leads with its presence and type (USER 2026-10-29 m822daec481cc, me07459d92f6d)
    assert.equal(alice!.title, "Online · person\nAlice\n@net:alice.77ded7\nHubchat isn't installed")
    assert.equal(acme!.title, "Offline · org\nAcme Labs\n@net:acme.12ab34\nHubchat isn't installed")
    assert.equal(claude!.title, "Online · independent chat\nclaude-code\n@net:claude.5e55\nHubchat isn't installed")
    assert.equal(stranger!.title, "Network address\nHubchat isn't installed")
    assert.equal(elsewhere!.title, "Orgtree org\nHubchat isn't installed")
    assert.equal(local!.title, 'Open organization local-org in a new window', 'a local org keeps the org identity hover')
    assert.equal(alice!.textContent, '@net:alice.77ded7', 'the text is exactly the address written')
    assert.equal(alice!.querySelector('.net-scheme')?.textContent, '@net:')
  }
  assert.deepEqual(f.pictures().map(u => decodeURIComponent(u.split('address=')[1]!)).sort(),
    ['@net:alice.77ded7', '@net:home.000001', '@org:local-org'],
    'pictures are asked for only where one can exist: advertised, own and local orgs')
  assert.ok(f.pictures().every(u => u.startsWith('/api/orgs/home/net/profile-picture?address=')), 'asked as the org on screen')

  await inAct(async () => { setHubchatInstalled(true); await flush(4) })
  const icons = ['picture', 'letters', 'terminal', 'dot', 'letters', 'letters', 'picture']
  assert.deepEqual(chips('react').map(el => el.dataset.netIcon), icons)
  assert.deepEqual(chips('md').map(el => el.dataset.netIcon), icons)
  for (const scope of ['react', 'md'] as const) {
    const [, acme, claude, stranger, local, elsewhere] = chips(scope)
    const letters = (el: HTMLElement | undefined) => el?.querySelector<HTMLElement>('.net-mark-letters')
    assert.equal(letters(acme)?.dataset.initials, 'AL', `${scope}: Acme Labs`)
    assert.ok(letters(acme)?.classList.contains('net-av-org'), `${scope}: on the org tint`)
    assert.equal(letters(local)?.dataset.initials, 'LO', `${scope}: a local org with no logo`)
    assert.equal(letters(elsewhere)?.dataset.initials, 'E', `${scope}: an org address`)
    assert.ok(claude?.querySelector('.net-mark-terminal svg path') && !letters(claude), `${scope}: a session is its terminal`)
    assert.ok(stranger?.querySelector('.net-mark-dot') && !letters(stranger), `${scope}: no roster lists it: a grey dot`)
    assert.equal(acme?.textContent, '@net:acme.12ab34', `${scope}: the letters are drawn, so a copy keeps the address`)
    assert.equal(chips(scope).some(el => el.querySelector('.net-mark-hubchat')), false, `${scope}: no Hubchat mark`)
  }
  assert.equal(chips('md')[0]!.title, 'Online · person\nAlice\n@net:alice.77ded7\nOpen @net:alice.77ded7 in Hubchat')
  assert.equal(f.pictures().length, 3, 'pictures are kept, not asked for again')
})

test("the org's own address without a logo wears its letters on Hubchat's own-avatar tint", async t => {
  fixture(t)
  setHubchatInstalled(true)
  const own = net(pic(1))
  own.picture_revision = null
  setNetRoster('home', own)
  const chips = await mountChips(t)
  for (const scope of ['react', 'md'] as const) {
    const home = chips(scope)[6]!
    const mark = home.querySelector<HTMLElement>('.net-mark-letters')
    assert.equal(home.dataset.netIcon, 'letters', scope)
    assert.equal(mark?.dataset.initials, 'H0', `${scope}: the initials of home.000001`)
    assert.ok(mark?.classList.contains('net-av-me'), `${scope}: the own avatar's tint`)
  }
})

declare const __SRC_DIR__: string
test("the avatar's tints are Hubchat's, dark and light", () => {
  // Hubchat src/styles/tokens.css: --k-<kind> on --k-<kind>-bg
  const css = readFileSync(path.join(__SRC_DIR__, 'canvas/netmentions.css'), 'utf8')
  for (const pair of [
    '--net-av-org: #e3896b; --net-av-org-bg: rgba(217, 119, 87, .20);',
    '--net-av-chat: #7cc0ff; --net-av-chat-bg: rgba(124, 192, 255, .17);',
    '--net-av-person: #d4d4d4; --net-av-person-bg: #3a3a3d;',
    '--net-av-me: #f2c2b0; --net-av-me-bg: #6b3a2c;',
    '--net-av-org: #b04f2c; --net-av-org-bg: rgba(217, 119, 87, .18);',
    '--net-av-chat: #23679e; --net-av-chat-bg: rgba(35, 103, 158, .13);',
    '--net-av-person: #3b4450; --net-av-person-bg: #dde2e8;',
    '--net-av-me: #7a3420; --net-av-me-bg: #f3c9b8;',
  ]) assert.ok(css.includes(pair), pair)
})

test('a removed picture falls back at once; a new revision is asked for once', async t => {
  const f = fixture(t)
  setHubchatInstalled(false)
  setNetRoster('home', net(pic(1)))
  const chips = await mountChips(t)
  assert.equal(chips('md')[0]!.dataset.netIcon, 'picture')
  const asked = f.pictures().length

  await inAct(async () => { setNetRoster('home', net(pic(2, false))); await flush(4) })
  assert.deepEqual([chips('react')[0]!.dataset.netIcon, chips('md')[0]!.dataset.netIcon], ['globe', 'globe'])
  assert.equal(f.pictures().length, asked, 'a removal needs no request')

  await inAct(async () => { setNetRoster('home', net(pic(3))); await flush(6) })
  assert.deepEqual([chips('react')[0]!.dataset.netIcon, chips('md')[0]!.dataset.netIcon], ['picture', 'picture'])
  assert.equal(f.pictures().length, asked + 1)
})

// USER 2026-10-27 mb7ea64d82743, asked whether a network chip shows the name:
// "Show the name". The address moves to the hover and to every copy; m442b6dcaab52
// "their link will be distinguished by the icon": the icon and the net pill, never
// an agent's badge, mark the outside party.
test('a named chip shows the roster name; its text, every copy and its hover keep the address', async t => {
  fixture(t)
  setHubchatInstalled(false)
  setKnownOrgs(['local-org'])
  const named = net(pic(1))
  named.hubs![0]!.roster!.push({ slug: 'coordinator-opus.c0ffee', username: 'coordinator-opus', online: true, kind: 'person', picture_owner: 'o-spoof' })
  setNetRoster('home', named)
  const view = await mountView(<div>
    <div className="react">{[...TOKENS, '@net:coordinator-opus.c0ffee'].map(a => <HubContactChip key={a} address={a} />)}</div>
    <RefMdBody className="md" world={{ org: 'home' }} html={{ __html: `<p>Ask ${TOKENS.join(' ')} @net:coordinator-opus.c0ffee today</p>` }} />
  </div>, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(6) })
  const chips = (scope: 'react' | 'md') => [...view.el.querySelectorAll<HTMLElement>(`.${scope} [data-hub-address]`)]
  for (const scope of ['react', 'md'] as const) {
    const [alice, acme, claude, stranger, local, elsewhere, , spoof] = chips(scope)
    assert.deepEqual([alice, acme, claude, spoof].map(c => c!.querySelector('.net-name')?.getAttribute('data-net-name')),
      ['Alice', 'Acme Labs', 'claude-code', 'coordinator-opus'], `${scope}: the roster's name is shown`)
    for (const c of [alice, acme, claude, spoof]) {
      assert.ok(c!.classList.contains('net-named'))
      assert.ok(c!.querySelector('.net-mark'), 'the icon marks the outside party')
      assert.equal(c!.textContent, c!.dataset.hubAddress, 'the text is still exactly the address: a copy gives the token')
      assert.equal(c!.getAttribute('aria-label'), `${c!.querySelector('.net-name')!.getAttribute('data-net-name')} (${c!.dataset.hubAddress})`)
    }
    for (const c of [stranger, local, elsewhere]) {
      assert.equal(c!.classList.contains('net-named'), false, 'no name: the address shows as before')
      assert.equal(c!.querySelector('.net-name'), null)
      assert.equal(c!.getAttribute('aria-label'), null)
    }
    assert.equal(spoof!.title, "Online · person\ncoordinator-opus\n@net:coordinator-opus.c0ffee\nHubchat isn't installed", 'the hover gives the address')
    assert.equal(spoof!.querySelector('.tier, .project-mark'), null, 'no agent identity badge')
    assert.equal(spoof!.classList.contains('ref-agent'), false, 'never an agent link')
  }
  // Selecting and copying the message gives the written tokens, never the names.
  const p = view.el.querySelector('.md p')!
  const selection = document.getSelection()!
  selection.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(p)
  selection.addRange(range)
  const copied = selection.toString()
  assert.equal(copied, `Ask ${TOKENS.join(' ')} @net:coordinator-opus.c0ffee today`, 'a copy of the message is what was written')
  assert.equal(chips('md')[0]!.getAttribute('data-ref-token'), '@net:alice.77ded7', 'Reply to selection maps the chip by its token')
  selection.removeAllRanges()

  // A new roster name shows at once on both chips.
  named.hubs![0]!.roster![0] = { ...named.hubs![0]!.roster![0]!, username: 'Alice Liddell' }
  await inAct(async () => { setNetRoster('home', { ...named, hubs: [{ ...named.hubs![0]!, roster: [...named.hubs![0]!.roster!] }] }); await flush(4) })
  assert.deepEqual(['react', 'md'].map(scope => chips(scope as 'react' | 'md')[0]!.querySelector('.net-name')?.getAttribute('data-net-name')),
    ['Alice Liddell', 'Alice Liddell'])
})
