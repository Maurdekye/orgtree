// Regression for the debug worker stack overflow after the depth-four cutoff.
// Exercise direct events and both watch/generic-dog entries into the same chain.
import { Proof } from '../proof.mjs'

export async function setup() { return { recover: true } }

export default async function (rig) {
  const p = new Proof('listener-self-fire-stack')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  try {
    for (const [index, entry] of ['event', 'listener_watch', 'command'].entries()) {
      const project = `stack${index}`, agent = `ear${index}`
      await rig.op({ op: 'create_project', name: project, parent: 'boss' })
      await rig.op({ op: 'hire', name: agent, parent: project, tier: 'haiku', grant: 0, title: 'Stack regression' })
      const action = { tool: 'orgtree_project', args: { action: 'fire_event', name: project } }
      const listener = await rig.tool(agent, 'orgtree_watchdog', {
        action: 'create', name: 'echo', kind: 'project_listener', target: project,
        once: false, notice: true, fire_actions: [action],
      })
      p.check(`${entry}: self-firing listener is armed`, listener.ok, listener.text)
      let result
      if (entry === 'event') {
        result = await rig.tool('boss', 'orgtree_project', action.args)
      } else {
        result = await rig.tool(agent, 'orgtree_watchdog', entry === 'listener_watch' ? {
          action: 'create', name: 'trigger', kind: entry, target: project, count: 1,
          once: true, notice: true, fire_actions: [action],
        } : {
          action: 'create', name: 'trigger', kind: entry, target: 'cmd.exe /d /c echo STACK-READY',
          pattern: 'STACK-READY', interval_s: 60, once: false, notice: true, fire_actions: [action],
        })
      }
      const mail = () => rig.sql(`SELECT m.body,m.ev->>'fire_actions' AS actions FROM ot.mail m
        JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE a.name='${agent}' AND m.sender='echo' ORDER BY m.id`)
      let readError
      await rig.waitFor(() => {
        try { return mail().some(m => /SKIPPED/.test(m.actions ?? '')) }
        catch (error) { readError = error; return true }
      },
        { what: `${entry} depth cutoff`, timeout: 30000 })
      if (readError) throw readError
      if (entry === 'command') await rig.tool(agent, 'orgtree_watchdog', { action: 'pause', id: 'trigger' })
      const rows = mail(), expected = entry === 'event' ? 5 : 4
      const pending = rig.one(`SELECT count(*) AS n FROM ot.listener_fire_outbox f
        JOIN ot.agents a ON a.id=f.project_id WHERE a.name='${project}' AND NOT f.done`)
      p.check(`${entry}: chain returns at depth four with ordered mail and completed delivery`,
        result.ok && rows.length === expected && rows.filter(m => /SKIPPED/.test(m.actions ?? '')).length === 1
        && /depth limit \(4\)/.test(rows.at(-1)?.actions ?? '') && Number(pending.n) === 0,
        { expected, count: rows.length, last: rows.at(-1), pending })
    }
  } catch (error) {
    p.check('self-fire regression completes every entry path without a transport or engine abort', false,
      { name: error.name, message: error.message, code: error.cause?.code, stack: error.stack })
  }
  p.keep(rig, { grep: /listener|watchdog|stack|depth limit/i })
  return p.summary()
}
