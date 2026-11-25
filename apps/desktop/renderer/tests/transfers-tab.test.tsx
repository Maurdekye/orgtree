// transfers-tab.test.tsx — Transfers is its own tab in every mailbox that
// shows it (USER 2026-11-25 09:31:19Z m7202711b8122 "make transfers in every
// mailbox it appears in a separate tab"; docket
// mailboxes-transfers-becomes-its-own-tab-in-every).
//
// Placement (USER 09:34Z m1a3bfa49d5b8 "make it a tab next to inbox and
// sent"): inbox · sent · transfers, in every mailbox with that row. Surfaces
// (every TransferPanel mount): the org mailbox and InboxView, which is the
// agent mailbox window, the agent desk's mail tab and the project desk's mail.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs transfers-tab

import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { InboxView, OrgInboxModal } from '../src/canvas/mail'
import type { MailTransfer } from '../src/api'

const sample = (state = 'uploading'): MailTransfer => ({ id:'local-fixture', direction:'upload',
  peer:'@net:fixture', message_id:'mail-fixture', state, attempt:1,
  files:[{id:'file-fixture',name:'retained.txt',total:100,confirmed:40,processed:60}] })

function transport(t: TestContext, rows: MailTransfer[]) {
  const original = globalThis.fetch
  globalThis.fetch = (async input => {
    const url = String(input)
    return new Response(JSON.stringify(url.includes('/transfers') ? {transfers:rows,next_cursor:null}
      : url.includes('/org_inbox') ? {entries:[],total:0,unread:0}
      : {pending:[],delivered:[],sent:[]}), {headers:{'X-Orgtree-Instance':'transfers-fixture'}})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
}

const shown = (el: Element | null) => !!el && !el.closest('[hidden]')
const tabNamed = (el: HTMLElement, sel: string, name: RegExp) =>
  [...el.querySelectorAll<HTMLButtonElement>(sel)].find(b => name.test(b.textContent ?? '')) ?? null

const org = () => <OrgInboxModal slug="fixture" map={new Map()} close={()=>{}} toast={()=>{}}
  inbox={{entries:[],total:0,unread:0,visible:true,holders:[]}}/>
const desk = () => <InboxView slug="fixture" nid="agent-fixture"/>
const SURFACES: [string, () => JSX.Element, string][] = [
  ['org mailbox', org, '.mail-folders button'],
  ['agent / project mailbox (InboxView)', desk, '.mail-folders button'],
]

for (const [name, surface, tabSel] of SURFACES) {
  test(`${name}: Transfers is a "transfers" tab, not a section of the mail view`, async t => {
    transport(t, [sample()])
    const v = await mountView(surface(), el => el); t.after(() => v.unmount()); await flush(); await flush()
    const tab = tabNamed(v.el, tabSel, /^transfers/)
    assert.ok(tab, 'a "transfers" tab beside the existing tabs')
    assert.equal(tab!.querySelector('.tab-count')?.textContent, '1', 'its badge counts the unfinished transfer')
    // the mail view (default) no longer shows the section
    assert.equal([...v.el.querySelectorAll('.mail-transfers')].filter(shown).length, 0, 'the mail view has no Transfers section')
    assert.equal(v.el.querySelector('.mail-transfers .linkish'), null, 'no "▸ Transfers" disclosure anywhere')
    await inAct(() => tab!.click()); await flush()
    assert.ok(tab!.classList.contains('on'), 'the tab is selected')
    const cards = [...v.el.querySelectorAll('.transfer-card')].filter(shown)
    assert.equal(cards.length, 1, 'the tab lists the transfers at once, with no extra click')
    assert.equal(v.el.querySelector<HTMLProgressElement>('.transfer-card progress')!.value, 40)
    const history = [...v.el.querySelectorAll<HTMLLabelElement>('.mail-transfers label')].find(l => /recent history/.test(l.textContent ?? ''))
    assert.ok(shown(history ?? null), 'the "recent history" toggle moved with it')
    assert.ok(tabNamed(v.el, tabSel, /Cancel transfer/) === null && shown(tabNamed(v.el, '.transfer-actions button', /Cancel transfer/)),
      'its actions moved with it')
    assert.equal([...v.el.querySelectorAll('.mailpane')].filter(shown).length, 0, 'the mail lists are hidden')
    assert.equal(tabNamed(v.el, '.adv-tabs .adv-tab', /transfers/), null, 'never in the mail / mailservers row')
    const row = [...tab!.parentElement!.querySelectorAll('button')].map(b => b.textContent?.replace(/\d+$/, '').trim())
    assert.deepEqual(row.slice(0, 3), ['inbox', 'sent', 'transfers'], 'inbox · sent · transfers')
    // and back
    const mailTab = tabNamed(v.el, tabSel, /^inbox/)!
    await inAct(() => mailTab.click()); await flush()
    assert.equal([...v.el.querySelectorAll('.transfer-card')].filter(shown).length, 0, 'back on mail, no transfers')
  })

  test(`${name}: no transfers, no tab`, async t => {
    transport(t, [])
    const v = await mountView(surface(), el => el); t.after(() => v.unmount()); await flush(); await flush()
    assert.equal(tabNamed(v.el, tabSel, /^transfers/), null, 'a mailbox without transfers gets no tab')
    if (name === 'org mailbox') assert.equal(v.el.querySelector('.adv-tabs'), null, 'and no tab row when hubs are hidden too')
  })
}

test('only finished transfers: the tab shows without a badge', async t => {
  transport(t, [sample('complete')])
  const v = await mountView(desk(), el => el); t.after(() => v.unmount()); await flush(); await flush()
  const tab = tabNamed(v.el, '.mail-folders button', /^transfers/)
  assert.ok(tab, 'recent transfers keep their tab')
  assert.equal(tab!.querySelector('.tab-count'), null, 'nothing unfinished, no count')
})
