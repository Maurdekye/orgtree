// canvas/historydog.tsx — a dog named by a history row of the project desk's
// tables (Orgtree 4.4.0; docket
// `project-desk-mail-event-listeners-and-slots-tabs`, user 2026-10-20
// 06:22Z): Recently Finished, Recently Delivered, Recently Fired and a slot
// lease's claim. The engine sends the dog's identity with the row, kept after
// the dog is spent or removed; while the tree still has the dog, the row's
// chip is the live one.

import type { Watchdog } from '../types'
import { useDogRoute } from './watchdogroute'
import { WatchdogLink } from './watchdoglink'
import { isUserName } from './usermention'

/** A dog as a history row names it (engine `watchdogs::identity`). */
export interface DogIdentity {
  id: string
  owner: string
  name: string
  kind: Watchdog['kind']
  once?: boolean
  state?: string
  /** no longer armed or paused */
  gone?: boolean
}

/** The shared watchdog chip for a history row's dog: live while the tree
 *  has it, else the kept identity, drawn as gone (no detail to open). */
export function HistoryDog({ dog, className }: { dog: DogIdentity | null | undefined; className?: string }) {
  const route = useDogRoute()
  if (!dog) return null
  const live = route?.dogs.find((w) => w.id === dog.id && !w.spent)
  // the user's own dog (owner "user") has no detail panel or menu to open: its chip only says what it is
  if (live && !dog.gone && isUserName(dog.owner)) return <WatchdogLink dog={live} className={className} atDestination />
  if (live && !dog.gone) return <WatchdogLink dog={live} className={className} onOpen={route?.open} />
  const kept = { id: dog.id, owner: dog.owner, name: dog.name, kind: dog.kind, once: !!dog.once, state: 'spent', spent: true,
    target: '', interval_s: 0, at: '', fired: 0 } as Watchdog
  return <WatchdogLink dog={kept} className={className}
    title={`${dog.once ? 'one-shot dog' : 'watchdog'} "${dog.name}" (${dog.kind}) — no longer exists; this row keeps its name`} />
}
