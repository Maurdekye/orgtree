// remotehere.ts — "is this window's organization on a remote engine?", and what
// the controls that depend on the computer say when it is
// (docs/rust-engine/remote-org.md, "What depends on the computer").
//
// An organization on a remote engine keeps its files, folders and provider
// sign-ins on that engine's computer. This computer's Explorer, its disk and
// its sign-in windows have nothing to do with them, so the controls that use
// those are off in such a window, each with a sentence that says where the
// thing is. The main process refuses the same calls on its own (it is the
// authority); this module is what keeps the window from asking.
//
// A window of a remote organization gets the pushed value `remote_link` (its
// own connection) in its app feed; a local window never does. Nothing here
// imports api.ts: api.ts may ask this module.
import { appValueNow, useAppValue } from './appfeed'

/** What this module needs of the connection (`RemoteView` in remotes.ts). */
export interface RemoteHere { id: string; name: string; state: string
  /** that engine's organizations: the name each has here (`alias`) and there (`remote_slug`) */
  orgs?: readonly { alias: string; remote_slug: string; gone?: boolean }[] }

const valid = (value: unknown): RemoteHere | null => {
  const v = value as Partial<RemoteHere> | null | undefined
  return v && typeof v.id === 'string' && typeof v.name === 'string' && v.name ? v as RemoteHere : null
}

/** The remote engine this window's organization runs on, or null in a window
 *  of a local organization. Asked outside React, at the moment of an action. */
export const remoteHere = (): RemoteHere | null => valid(appValueNow<unknown>('remote_link'))

/** The same for a component, kept current. */
export const useRemoteHere = (): RemoteHere | null => valid(useAppValue<unknown>('remote_link'))

// ---------------------------------------------------------------- names
//
// An organization of a remote engine keeps its slug here when the name is free, and otherwise
// goes by an alias ("acme-galaxy"). Text written there (transcripts, mail, tickets) names
// organizations as THAT engine knows them, and that engine knows no alias. So in a remote
// window: references the window holds are under this computer's names (the window's own slug is
// the alias, and everything keyed by it stays so); text is under the organization's own names.
// `windowOrg` is applied where a token is read (canvas/workrefs.tsx), `contentOrg` where one is
// written (`refToken` in canvas/reflinks.tsx). In a local window, and for every name that is
// the same on both sides, both are the identity.

/** The name this computer lists an organization by, given the name text of this window calls
 *  it. A name the window's remote engine does not list is returned as it is. */
export function windowOrg(name: string): string {
  const orgs = remoteHere()?.orgs
  if (!orgs) return name
  return orgs.find(o => !o.gone && o.remote_slug === name)?.alias ?? name
}

/** The name an organization has on its own engine, given the name this computer lists it by. */
export function contentOrg(alias: string): string {
  const orgs = remoteHere()?.orgs
  if (!orgs) return alias
  return orgs.find(o => !o.gone && o.alias === alias)?.remote_slug ?? alias
}

const renamed = new WeakMap<object, { slug: string; value: object }>()

/** The organization a window asked for, under the name the window asked by. The remote engine
 *  answers with the name the organization has THERE; everything the window keys by its
 *  organization (desks, drafts, layout, "is this answer still mine") uses the name it has HERE.
 *  An answer whose name already matches is returned as it is, and the same answer gives the
 *  same object back, so an unchanged tree stays unchanged to React. */
export function treeHere<T extends { slug: string }>(tree: T, slug: string): T {
  if (tree.slug === slug) return tree
  const known = renamed.get(tree)
  if (known?.slug === slug) return known.value as T
  const value = { ...tree, slug }
  renamed.set(tree, { slug, value })
  return value
}

/** T2: a folder (scratch, shared notes, templates, charters). */
export const remoteFolderText = (name: string, path?: string | null): string =>
  path ? `This folder is on ${name}: ${path}` : `This folder is on ${name}, not on this computer.`

/** T3: a file a transcript or a tool row names. */
export const remoteFileText = (name: string): string => `This file is on ${name}. Copy its path to find it there.`

/** T1: a provider's browser sign-in, which would run a CLI on this computer. */
export const remoteSignInText = (name: string, path?: string | null): string =>
  `Sign in on ${name} itself${path ? `: this profile’s folder is ${path}` : ''}. See “Sign in to provider CLIs over SSH” in the standalone engine guide.`

/** An address the engine itself dials (a language model server): from the remote engine's computer. */
export const remoteAddressNote = (name: string): string => `Addresses are as seen from ${name}.`

/** T4: an app panel action that needs a file dialog of this computer. */
export const REMOTE_APP_ACTION = 'Not available for an organization on a remote engine.'

/** Open a folder of this computer, unless this window's organization is on a
 *  remote engine: then nothing is opened and the answer says where it is. */
export async function localFolder<T extends { ok: boolean; error?: string }>(open: () => Promise<T>): Promise<T | { ok: false; error: string; remote: true }> {
  const remote = remoteHere()
  return remote ? { ok: false, error: remoteFolderText(remote.name), remote: true } : open()
}
