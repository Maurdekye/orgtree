// A person's preferred language (Mail hub 2.4.0 puts it on their roster
// entry; docket mail-hub-hubchat-automatic-translation-between-u, USER
// 2026-11-01 16:13Z m839bcf1a8f34: "this is something that ought to be
// exposed to the end user when looking at a person's profile"). Orgtree's
// view of a network person is the hover of every link to them: it carries a
// "Language: <its own name>" line, as Hubchat's Contact info carries a
// Language row with the same name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { hubAddressTitle, resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import type { NetBlock, NetPeer } from '../src/types'

const NL = String.fromCharCode(10)
const hub = (roster: NetPeer[]): NetBlock['hubs'][number] =>
  ({ id: 'local', address: 'http://127.0.0.1:7370', name: 'local', version: '2.4.0', enabled: true, connected: true, queued: 0, roster })

test("a person's hover names the language they read in, in its own name; none when they chose none or for an org", () => {
  setHubchatInstalled(false)
  setNetRoster('acme', { slug: 'acme.home.a1b2c3', hubs: [hub([
    { slug: 'dana.he.77aa01', username: 'Dana', kind: 'person', online: true, language: 'he' } as NetPeer,
    { slug: 'pia.p.5e1f02', username: 'Pia', kind: 'person', online: true },
    { slug: 'zed.p.5e1f03', username: 'Zed', kind: 'person', online: false, language: 'tlh' } as NetPeer,
    { slug: 'beta.o.5e1f01', org_name: 'Beta Works', kind: 'org', online: true, language: 'fr' } as NetPeer,
  ])] })
  try {
    const action = "Hubchat isn't installed"
    assert.equal(hubAddressTitle('@net:dana.he.77aa01'), ['Online · person', 'Dana', 'Language: עברית', '@net:dana.he.77aa01', action].join(NL))
    assert.equal(hubAddressTitle('@net:pia.p.5e1f02'), ['Online · person', 'Pia', '@net:pia.p.5e1f02', action].join(NL))
    assert.equal(hubAddressTitle('@net:zed.p.5e1f03'), ['Offline · person', 'Zed', 'Language: tlh', '@net:zed.p.5e1f03', action].join(NL),
      'a language without a name shows its tag')
    assert.equal(hubAddressTitle('@net:beta.o.5e1f01'), ['Online · org', 'Beta Works', '@net:beta.o.5e1f01', action].join(NL))
  } finally {
    resetNetMentions()
  }
})
