import { flush, inAct, mountView } from './harness'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { hubAddressTitle, resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import { CONTACT_NET, ContactLists, type ContactSurface } from './net-contact-lists.fixture'

// USER ma0d0dc5004a4 / m18abccdbff95: both roster lists use the real net link.
export async function checkContactList(surface: ContactSurface, t: TestContext) {
    const oldFetch = globalThis.fetch, oldOpen = window.open, opened: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).endsWith('/api/desktop/phone') ? { hubchat_pc: true } : { entries: [], total: 0, transfers: [] }),
      { headers: { 'Content-Type': 'application/json' } })) as typeof fetch
    window.open = ((url: string | URL | undefined) => { opened.push(String(url)); return null }) as typeof window.open
    setNetRoster('contact-fixture', CONTACT_NET); setHubchatInstalled(true)
    let bubbled = 0
    const view = await mountView(<div onClick={() => { bubbled++ }}><ContactLists surface={surface} /></div>, el => el)
    t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; window.open = oldOpen; resetNetMentions(); setHubchatInstalled(false) })
    await inAct(async () => {
      await flush(5)
      if (surface === 'mailservers') [...view.el.querySelectorAll<HTMLButtonElement>('.adv-tab')].find(b => b.textContent === 'mailservers')!.click()
      await flush(3)
    })
    const scopes = [...view.el.querySelectorAll(surface === 'mailservers' ? '.oi-hub' : '.connection-row')]
    assert.equal(scopes.length, 2)
    assert.equal(scopes[1]!.querySelectorAll('[data-hub-address="@net:helper.fixture.bb0022"]').length, 1, 'a contact on two hubs renders twice')
    const scope = scopes[0]!
    const chips = [...scope.querySelectorAll<HTMLButtonElement>('button.ref-hub[data-hub-address]')]
    assert.equal(chips.length, 4, 'all four roster entries are the shared contact buttons')
    for (const [i, peer] of CONTACT_NET.hubs[0]!.roster.entries()) {
      const address = '@net:' + peer.slug, chip = chips.find(b => b.dataset.hubAddress === address)!, row = chip.parentElement!
      assert.equal(chip.dataset.hubAddress, address)
      assert.equal(chip.textContent, address, 'only the chip carries the written address; old plain name/fingerprint removed')
      assert.equal(chip.title, hubAddressTitle(address))
      assert.equal(chip.dataset.netKind, peer.kind)
      assert.equal(!!chip.querySelector('.net-mark'), true)
      assert.equal(chip.querySelector('.net-name')?.getAttribute('data-net-name') ?? null, peer.org_name ?? null)
      const after = [...row.childNodes].slice([...row.childNodes].indexOf(chip) + 1).map(n => n.textContent).join('')
      assert.equal(after, surface === 'mailservers' ? ' net' : ` · ${peer.online ? 'Online' : 'Offline'}${peer.blurb ? ' · ' + peer.blurb : ''}`)
      if (surface === 'mailservers') {
        assert.equal(row.firstElementChild?.classList.contains('ok'), peer.online)
        assert.match(row.title, /reachable via: net/)
      }
      bubbled = 0
      await inAct(() => chip.click())
      assert.equal(bubbled, 0, 'the contact action stops parent click propagation')
      assert.equal(opened.length, i + 1, 'offline/unlinked state alone never changes the shared resolver')
      assert.match(decodeURIComponent(opened[i]!), new RegExp(peer.slug.replaceAll('.', '\\.')))
      await inAct(() => chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
      const menu = document.querySelector('[role="menu"]')!
      assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map(n => n.textContent), ['Open in Hubchat', 'Copy identity'])
      assert.equal(menu.querySelectorAll('button:disabled').length, 0)
      await inAct(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    }
    await inAct(async () => { setHubchatInstalled(false); await flush(3) })
    for (const chip of chips) {
      assert.equal(chip.getAttribute('aria-disabled'), 'true')
      assert.equal(chip.classList.contains('inert'), true)
      await inAct(() => chip.click())
    }
    assert.equal(opened.length, 4, 'inert buttons never invoke a hub action')
    await inAct(() => chips[3]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    assert.equal(document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.disabled, true, 'inert contacts keep their hub menu')
    if (surface === 'mailservers') assert.equal(view.el.querySelector('.oi-net > .dim')?.querySelectorAll('button').length, 0, 'own address stays plain')
}
