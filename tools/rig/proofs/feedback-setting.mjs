// Real HTTP + PostgreSQL persistence; only the synthetic rig is touched.
import { Proof } from '../proof.mjs'
export default async function (rig) {
  const p = new Proof('feedback-setting')
  const route = '/api/app-settings/runtime'
  const key = 'suggest_agent_feedback_enabled'
  p.check('fresh settings default on', (await rig.api('GET', route))[key] === true)
  const invalid = await rig.api('PUT', route, { [key]: 'false' }).then(() => false, () => true)
  p.check('non-boolean is refused', invalid)
  await rig.api('PUT', route, { [key]: false })
  p.check('explicit false is returned', (await rig.api('GET', route))[key] === false)
  const stored = rig.one("SELECT value FROM ot.kv WHERE key = 'app_settings'").value
  p.check('false is persisted in PostgreSQL', stored.runtime[key] === false)
  await rig.restart()
  p.check('engine restart retains false', (await rig.api('GET', route))[key] === false)
  await rig.api('PUT', route, { [key]: true })
  p.check('explicit true persists', rig.one("SELECT value FROM ot.kv WHERE key = 'app_settings'").value.runtime[key] === true)
  return p.summary()
}
