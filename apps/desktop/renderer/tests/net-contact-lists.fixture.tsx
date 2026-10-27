import { ConnectionsPanel } from '../src/canvas/connections'
import { OrgInboxModal } from '../src/canvas/mail'
import type { NetBlock, TreePayload } from '../src/types'

export const CONTACT_NET: NetBlock = {
  slug: 'home.fixture.123abc',
  hubs: [{ id: 'local', address: 'http://hub.example:7370', name: 'Fixture hub', version: '2.2.0',
    enabled: true, connected: true, queued: 0, roster: [
      { slug: 'alice.fixture.aa0011', org_name: 'Alice', kind: 'person', online: true },
      { slug: 'helper.fixture.bb0022', org_name: 'Offline helper', kind: 'chat', online: false, blurb: 'Independent agent session' },
      { slug: 'unnamed.fixture.cc0033', kind: 'org', online: true },
      { slug: 'link.19356f', org_name: 'Penelope', kind: 'chat', online: false, blurb: 'Waiting to be linked to a Hubchat identity' },
    ] },
    { id: 'second', address: 'https://second.example', name: 'Second hub', enabled: true, connected: true, queued: 0,
      roster: [{ slug: 'helper.fixture.bb0022', org_name: 'Offline helper', kind: 'chat', online: false, blurb: 'Independent agent session' }] },
  ],
}
export type ContactSurface = 'mailservers' | 'connections'
export function ContactLists({ surface }: { surface: ContactSurface }) {
  return surface === 'mailservers'
    ? <OrgInboxModal slug="contact-fixture" net={CONTACT_NET} map={new Map()} toast={() => {}} close={() => {}}
        inbox={{ entries: [], total: 0, unread: 0, holders: [], visible: true, multi_holder_enabled: false }} />
    : <ConnectionsPanel tree={{ slug: 'contact-fixture', net: CONTACT_NET } as TreePayload} toast={() => {}} close={() => {}} />
}
