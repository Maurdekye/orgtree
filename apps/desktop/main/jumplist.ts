import type { AppFeedState } from '../../../packages/contracts/app-feed'

export type TaskbarTarget = { kind: 'homepage' | 'create' } | { kind: 'org'; slug: string }
export type TaskbarOrg = { slug: string; name: string; logo?: string }
export type TaskbarIcons = { home?: string; create?: string; orgs?: Record<string, string> }
const PREFIX = '--orgtree-taskbar='
const SLUG = /^[a-z0-9@-]+$/

/** One argument, never a URL, shell command or renderer script. */
export function taskbarTarget(argv: readonly string[]): TaskbarTarget | null {
  const args = argv.filter(arg => arg.startsWith(PREFIX))
  if (args.length !== 1) return null
  const target = args[0].slice(PREFIX.length)
  if (target === 'home') return { kind: 'homepage' }
  if (target === 'new') return { kind: 'create' }
  if (target.startsWith('org:') && SLUG.test(target.slice(4))) return { kind: 'org', slug: target.slice(4) }
  return null
}

/** Same slug order as the org switcher; trashed orgs are absent. Until its
 * summary arrives, a new org has the same slug fallback as the homepage. */
export function taskbarOrgs(state: AppFeedState): TaskbarOrg[] {
  return (state.registry?.records ?? []).filter(({ body }) => body.state === 'active' && SLUG.test(body.slug))
    .map(({ body }) => {
      const summary = state.summary(body)
      const logo = summary?.logo_sha256
      return { slug: body.slug, name: summary?.name || body.slug,
        ...(typeof logo === 'string' && /^[a-f0-9]{64}$/.test(logo) ? { logo } : {}) }
    })
    .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
}

/** Explicit custom category, followed by Windows' fixed Tasks section.
 * Names stay display text; only the validated slug goes into arguments. */
export function taskbarTasks(orgs: readonly TaskbarOrg[], exe: string, appPath?: string, icons: TaskbarIcons = {}): Electron.JumpListCategory[] {
  // Windows paths cannot contain quotes. Escape trailing slashes before the
  // closing quote for development's `electron.exe "<app path>"` invocation.
  const appArg = appPath ? `"${appPath.replace(/(\\+)$/, '$1$1')}" ` : ''
  const task = (title: string, target: string, description: string, iconPath = exe): Electron.JumpListItem => ({
    type: 'task', program: exe, args: appArg + PREFIX + target, title, description: description.slice(0, 260),
    iconPath, iconIndex: 0,
  })
  const items = [task('Home', 'home', 'Open the Orgtree homepage', icons.home),
    task('New org', 'new', 'Create a new organization', icons.create)]
  const current = orgs.filter(org => SLUG.test(org.slug))
  const recent = current.map(org => task(org.name || org.slug, `org:${org.slug}`, `Open ${org.name || org.slug}`,
    typeof icons.orgs?.[org.slug] === 'string' ? icons.orgs[org.slug] : undefined))
  return [...(recent.length ? [{ type: 'custom' as const, name: 'Recent', items: recent }] : []), { type: 'tasks', items }]
}
