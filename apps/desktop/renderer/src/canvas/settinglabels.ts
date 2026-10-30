import type { OrgtreeToolGroup } from '../types'

// The settings dialog's own words (canvas/modals.tsx), shared with the change
// notices that report a change to them (events/change.ts), so a setting reads
// the same in both places (USER 2026-10-29 mb6da9f3ee862, maximal symmetry).

export const VIS_OPTIONS = [
  ['self', 'Only this agent'],
  ['team', 'Its team'],
  ['subtree', 'Its team and all reports'],
  ['full', 'Everyone'],
] as const

export const SESSION_OPTIONS: [string, string][] = [
  ['signed-in', 'Signed-in session when available'],
  ['console', 'Console session'],
  ['remote', 'Remote session'],
  ['session0', 'Always Session 0'],
]

export const PERMISSION_OPTIONS = [
  ['plan', 'Read only'],
  ['default', 'Ask before changes'],
  ['acceptEdits', 'Allow normal changes'],
  ['bypassPermissions', 'Unrestricted access'],
] as const

export const TOOL_LABELS = [
  ['bash', 'Run commands', 'Run terminal commands and programs.'],
  ['web', 'Browse the web', 'Search the web and open web pages.'],
  ['edit', 'Edit files', 'Create and change files in granted folders, including notebooks.'],
  ['subagents', 'Use helper agents', 'Delegate tasks to temporary helper agents within the harness.'],
] as const

export const ORGTREE_GROUPS: ReadonlyArray<readonly [OrgtreeToolGroup, string, string]> = [
  ['docket', 'Docket work', 'Read and update work items. Staffing a work item also needs Team management.'],
  ['team', 'Team management', 'Hire, retire, move and configure agents; manage credits and models.'],
  ['messaging', 'Messaging', 'Send and read mail, manage audiences and attachment transfers.'],
  ['inspection', 'Organization reading', 'Read the chart, agent state, transcripts, scratch folders, tiers and organizations.'],
  ['watchdogs', 'Watchdogs', 'Create and manage persistent watchers. Command watchers also need Run commands.'],
  ['runtime', 'Runtime and accounts', 'Interrupt, halt or resume agents, change their account and inspect capacity marks.'],
  ['user', 'User questions and delivery', 'Ask questions, present documents, send files and request more scope or credits.'],
  ['orgmod', 'Org-modifying tools', 'Manage Apps and saved panels; set or remove the organization logo, with logging and undo history.'],
]
