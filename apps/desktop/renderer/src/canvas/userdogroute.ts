// canvas/userdogroute.ts — where a click on a watchdog chip goes (docket
// switchboard-clicking-the-user-s-own-watchdog-chi). The user's own dogs (their
// slot holds, listeners, watches and queue place, owner "user") have no owning
// agent, so the detail dialog cannot read them: their chip opens the project
// surface that lists the registration instead.
import type { Watchdog } from '../types'
import { isUserName } from './username'

export type DogClick =
  | { to: 'dialog' }
  | { to: 'listeners' | 'slots' | 'desk'; project: string }
  | { to: 'gone' }

export function dogClick(dog: Watchdog | undefined, hasProject: (id: string) => boolean): DogClick {
  if (!dog) return { to: 'gone' }
  if (!isUserName(dog.owner)) return { to: 'dialog' }
  const project = dog.target.replace(/^@/, '')
  if (!hasProject(project)) return { to: 'gone' }
  if (dog.kind === 'project_listener' || dog.kind === 'listener_watch') return { to: 'listeners', project }
  if (dog.kind === 'slot') return { to: 'slots', project }
  return { to: 'desk', project }
}
