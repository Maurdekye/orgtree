import type { ToolChip } from '../types'

/** Only shell calls named by the request or the harness's shell adapter. */
export function isFailedShellCall(tool: ToolChip): boolean {
  const name = tool.name.split('__').at(-1)?.toLowerCase()
  if (!['bash', 'powershell', 'exec_command', 'run_command', 'run_shell_command', 'shell'].includes(name ?? '')) return false
  return typeof tool.error === 'string' || tool.is_error === true
    || (typeof tool.exit_code === 'number' && tool.exit_code !== 0)
    || (typeof tool.exitCode === 'number' && tool.exitCode !== 0)
    || (typeof tool.status === 'string' && ['failed', 'error'].includes(tool.status.toLowerCase()))
}
