import { SetToggle } from './settingskit'

export function nativeToolCoverage(harness?: string | null): string {
  switch (harness) {
    case 'claude': case 'claude-code':
      return 'Restores AskUserQuestion, EnterPlanMode, ExitPlanMode, CronCreate, CronDelete, CronList, ScheduleWakeup, Monitor and RemoteTrigger. Questions and plan approval keep normal audience routing. SendMessage and other helper tools still follow Use helper agents.'
    case 'openai': case 'codex-cli':
      return 'Restores native request_user_input when offered by Codex. Questions keep normal audience routing. Shell, web, file editing and helper permissions are not affected.'
    case 'muse':
      return 'Restores native user-input questions with normal audience routing. Not affected: reminder observers, proactive workflows and contributor mode; these stay off.'
    case 'google': case 'antigravity':
      return 'Antigravity has no Orgtree replacement tools to restore. Its shell, editing, web and helper permissions are not affected.'
    case 'opencode':
      return 'OpenCode has no replacement tools to restore. Not affected: built-in build/plan agents, unknown-tool refusals and Code Mode security policy.'
    default:
      return 'Coverage follows the selected harness: Claude Code question, plan and scheduling tools; Codex and Muse native questions. Antigravity and OpenCode restore no tools. Muse automation/contributor mode and OpenCode agent/security policies are not affected.'
  }
}

/** Shared by staged hires and saved agent permissions, never hire defaults. */
export function NativeReplacementToggle({ checked, disabled, harness, onChange }: {
  checked: boolean; disabled?: boolean; harness?: string | null; onChange: (next: boolean) => void
}) {
  return <SetToggle label="Disabled by Orgtree" checked={checked} disabled={disabled}
    hint={`Off by default. ${nativeToolCoverage(harness)}${disabled ? ' The superior does not have this permission.' : ''}`}
    onChange={onChange} />
}
