// An external hub save keeps this computer's hub (docket
// mail-servers-adding-an-external-mail-hub-unticks; USER 2026-11-27 18:07:59Z
// medd95d6eea12: "does adding an external mailhub connection for an org
// disable its "connect to this computer's mail hub" checkbox? it shouldnt do
// that"). Real HTTP + PostgreSQL on the synthetic rig: the saves are the ones
// the Connections panel sends (net_hubs without the local entry: Add, the
// Connection enabled switch, Remove); the checkbox is whether GET .../net lists
// the `local` hub. Fails at 2676af2 (the save stored the list as sent).
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('local-hub-kept')
  const slug = (await rig.api('POST', '/api/orgs', { name: 'Local Hub Kept', dirs: [] })).slug
  const net = () => rig.api('GET', `/api/orgs/${slug}/net`)
  const save = body => rig.api('POST', `/api/orgs/${slug}/settings`, body)
  const others = hubs => hubs.filter(h => h.id !== 'local').map(h => ({ id: h.id, address: h.address, enabled: h.enabled }))
  const hasLocal = hubs => hubs.some(h => h.id === 'local')
  const far = 'http://far.example.invalid:7378'

  const start = await net()
  p.check('a new org lists this computer\'s hub (checkbox on)', hasLocal(start.hubs), JSON.stringify(start.hubs))
  const local = start.hubs.find(h => h.id === 'local')

  // Add a mail hub: the panel sends the other hubs plus the new one
  await save({ net_hubs: [...others(start.hubs), { address: far, enabled: true }] })
  const added = await net()
  p.check('after Add, this computer\'s hub is still listed', hasLocal(added.hubs), JSON.stringify(added.hubs))
  p.check('after Add, it is unchanged and first', JSON.stringify(added.hubs[0]) === JSON.stringify(local), JSON.stringify(added.hubs[0]))
  p.check('after Add, the external hub is listed', added.hubs.some(h => h.address === far))
  p.check('autoconnect stays on', added.autoconnect === true)

  // Connection enabled off on the external hub
  await save({ net_hubs: others(added.hubs).map(h => h.address === far ? { ...h, enabled: false } : h) })
  const toggled = await net()
  p.check('after switching the external hub off, this computer\'s hub is still listed', hasLocal(toggled.hubs), JSON.stringify(toggled.hubs))
  p.check('the external hub is off', toggled.hubs.find(h => h.address === far)?.enabled === false)

  // Remove the external hub
  await save({ net_hubs: others(toggled.hubs).filter(h => h.address !== far) })
  const removed = await net()
  p.check('after Remove, this computer\'s hub is still listed', hasLocal(removed.hubs), JSON.stringify(removed.hubs))
  p.check('after Remove, the external hub is gone', !removed.hubs.some(h => h.address === far))

  // The checkbox alone takes it out, and an external edit does not bring it back
  await save({ net_autoconnect: false })
  const off = await net()
  p.check('the checkbox off removes this computer\'s hub', !hasLocal(off.hubs) && off.autoconnect === false, JSON.stringify(off))
  await save({ net_hubs: [...others(off.hubs), { address: far, enabled: true }] })
  const offAdd = await net()
  p.check('with the checkbox off, Add does not bring it back', !hasLocal(offAdd.hubs) && offAdd.hubs.some(h => h.address === far), JSON.stringify(offAdd.hubs))
  await save({ net_autoconnect: true })
  const on = await net()
  p.check('the checkbox on puts it back first, the external hub kept', on.hubs[0]?.id === 'local' && on.hubs.some(h => h.address === far), JSON.stringify(on.hubs))
  return p.summary()
}
