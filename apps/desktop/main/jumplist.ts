import type { AppFeedState } from '../../../packages/contracts/app-feed'

export type TaskbarTarget = { kind: 'homepage' | 'create' } | { kind: 'org'; slug: string }
export type TaskbarOrg = { slug: string; name: string }
export function taskbarTarget(_argv: readonly string[]): TaskbarTarget | null { return null }
export function taskbarOrgs(_state: AppFeedState): TaskbarOrg[] { return [] }
export function taskbarTasks(_orgs: readonly TaskbarOrg[], _exe: string, _appPath?: string): Electron.JumpListCategory[] { return [] }
