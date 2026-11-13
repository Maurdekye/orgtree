// people.tsx — several people on one organization: whose action a record of
// the user was (docs/rust-engine/remote-org.md, "Several people on one
// organization").
//
// Every connected desktop is the user. The engine that runs an organization
// records which computer each user action came through (`via`), and a window
// shows it on OTHER people's actions: "User · Sam". One's own look as they
// always did, and so does a record that names no computer (an older one, or
// one the engine could not tell). Names tell people apart; they grant nothing.
import { useRemoteHere, remoteHere } from './remotehere'

/** Which computer a user action came through, as the engine recorded it: the
 *  label it had then, and the client's own name when that says more. */
export interface Via { id: string; name: string; on?: string }

export const asVia = (value: unknown): Via | null => {
  const v = value as Partial<Via> | null | undefined
  return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string' && v.name ? v as Via : null
}

/** This window's own origin in the records of its organization: `local` in a
 *  window of a local organization, and in a window of a remote one the client
 *  this desktop is on that engine. Null there until that engine has said so. */
const ownOf = (here: ReturnType<typeof remoteHere>): string | null => here ? here.me?.id ?? null : 'local'
/** Asked outside React, at the moment of an action. */
export const ownOrigin = (): string | null => ownOf(remoteHere())
/** The same for a component, kept current. */
export const useOwnOrigin = (): string | null => ownOf(useRemoteHere())

/** Someone else, when a record of the user was theirs: the name to show and
 *  its tooltip ("Sam, on Orgtree desktop (PC2)"). Null for one's own record
 *  and for a record that names no computer: those read as they always did. */
export function otherPerson(via: unknown, own: string | null): { name: string; title: string } | null {
  const v = asVia(via)
  if (!v || v.id === own) return null
  return { name: v.name, title: v.on && v.on !== v.name ? `${v.name}, on ${v.on}` : v.name }
}
export const useOtherPerson = (via: unknown) => otherPerson(via, useOwnOrigin())

/** What follows the user's own label when the action was someone else's:
 *  " · Sam". Nothing otherwise, so every place keeps the label it had ("User",
 *  "@user", "you"). The name is an outside name to Streamer mode, tooltip
 *  included: the tooltip sits on the masked element itself. */
export function ViaName({ via }: { via?: unknown }) {
  const other = useOtherPerson(via)
  if (!other) return null
  return <span className="user-via">{' · '}<span data-streamer-field="external" title={other.title}>{other.name}</span></span>
}

/** A sentence's name for whoever a record was by: the other person's name, or
 *  null when it was this window's own or names nobody. */
export const otherName = (via: unknown, own: string | null): string | null => otherPerson(via, own)?.name ?? null
