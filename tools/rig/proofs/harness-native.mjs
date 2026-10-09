// Proof: `harness` on a hire or a staffing is for OpenRouter tiers; naming the
// tier's own CLI anywhere else is a no-op, and only a real mismatch is refused,
// saying which CLI the tier runs on (coordinator 2026-10-09: an opus hire with
// harness=claude-code was refused as "harness is claude-code or codex-cli for an
// OpenRouter hire", and an agent burned several turns on it).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/harness-native.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('harness-native')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const hire = (name, tier, harness) => rig.op({ op: 'hire', name, parent: 'boss', tier, harness, title: 'harness proof' })
    .then(r => ({ ok: true, r }), e => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  const cases = [
    ['ha-opus', 'opus', 'claude-code', null],
    ['ha-luna', 'luna', 'codex-cli', null],
    ['hb-opus', 'opus', 'codex-cli', 'harness only applies to OpenRouter tiers; opus always runs on claude-code'],
    ['hb-luna', 'luna', 'claude-code', 'harness only applies to OpenRouter tiers; luna always runs on codex-cli'],
    ['hb-flash', 'flash', 'claude-code', 'harness only applies to OpenRouter tiers; flash always runs on antigravity'],
  ]
  for (const [name, tier, harness, refusal] of cases) {
    const got = await hire(name, tier, harness)
    p.check(refusal ? `a ${tier} hire with harness=${harness} is refused: "${refusal}"` : `a ${tier} hire with harness=${harness} (its own CLI) is accepted as a no-op`,
      refusal ? !got.ok && got.status === 400 && got.detail?.includes(refusal) && !rig.agentRow(name)
        : got.ok && rig.agentRow(name)?.state === 'live' && !rig.agentRow(name)?.extra?.harness,
      got.ok ? { node: got.r?.node, extra: rig.agentRow(name)?.extra } : got)
  }
  // the reported case came through staffing as well
  const staffed = await rig.tool('boss', 'orgtree_staff', { action: 'create', title: 'Harness staffing ticket', kind: 'code',
    objective: 'A ticket for the harness proof.\n\nNothing depends on it.', name: 'hc-opus', tier: 'opus', harness: 'claude-code',
    grant: 0, charter: 'You check one thing for the harness proof.', add_dirs: [], org_visibility: 'self',
    tools: { bash: false, web: false, edit: false, subagents: false, mcp: [] } })
  p.check('orgtree_staff with tier=opus and harness=claude-code staffs the ticket', staffed.ok && rig.agentRow('hc-opus')?.state === 'live',
    staffed.ok ? { agent: rig.agentRow('hc-opus')?.state } : staffed.text?.slice(0, 300))
  return p.summary()
}
