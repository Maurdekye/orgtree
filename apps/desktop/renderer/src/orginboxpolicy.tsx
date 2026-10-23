import { SetGroup, SetRow, SetToggle } from './canvas/settingskit'

export type OrgInboxMode = 'normal' | 'dnd' | 'closed'
export function OrgInboxPolicy({ mode, onMode, multi, onMulti }: {
  mode: OrgInboxMode; onMode: (mode: OrgInboxMode) => void
  multi: boolean; onMulti: (on: boolean) => void
}) {
  return <SetGroup title="External org inbox">
    <SetRow label="outside communication" hint="Normal delivers outside mail to agents. Closed blocks outside communication and hides its retained history.">
      <select aria-label="org inbox mode" value={mode}
        aria-describedby={mode === 'dnd' ? 'org-inbox-dnd-warning' : undefined}
        onChange={e => onMode(e.target.value as OrgInboxMode)}>
        <option value="normal">Normal operations</option>
        <option value="dnd">Do not disturb</option>
        <option value="closed">Closed off inbox</option>
      </select>
    </SetRow>
    {mode === 'dnd' && <p className="orgmd-warn" id="org-inbox-dnd-warning" role="note">
      Hubchat and other outside messages are kept but not read or delivered automatically.
      {' '}An agent must check the org inbox to receive them.
    </p>}
    <SetToggle label="allow multiple org-inbox audience holders" checked={multi} onChange={onMulti}
      hint="off: granting a different holder moves the audience; turning this off with several holders requires revoking all but one first" />
  </SetGroup>
}
