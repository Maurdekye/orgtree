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
export interface RemoteHere { id: string; name: string; state: string }

const valid = (value: unknown): RemoteHere | null => {
  const v = value as Partial<RemoteHere> | null | undefined
  return v && typeof v.id === 'string' && typeof v.name === 'string' && v.name ? v as RemoteHere : null
}

/** The remote engine this window's organization runs on, or null in a window
 *  of a local organization. Asked outside React, at the moment of an action. */
export const remoteHere = (): RemoteHere | null => valid(appValueNow<unknown>('remote_link'))

/** The same for a component, kept current. */
export const useRemoteHere = (): RemoteHere | null => valid(useAppValue<unknown>('remote_link'))

/** T2: a folder (scratch, shared notes, templates, charters). */
export const remoteFolderText = (name: string, path?: string | null): string =>
  path ? `This folder is on ${name}: ${path}` : `This folder is on ${name}, not on this computer.`

/** T3: a file a transcript or a tool row names. */
export const remoteFileText = (name: string): string => `This file is on ${name}. Copy its path to find it there.`

/** T1: a provider's browser sign-in, which would run a CLI on this computer. */
export const remoteSignInText = (name: string, path?: string | null): string =>
  `Sign in on ${name} itself${path ? `: this profile’s folder is ${path}` : ''}. See “Sign in to provider CLIs over SSH” in the standalone engine guide.`

/** T4: an app panel action that needs a file dialog of this computer. */
export const REMOTE_APP_ACTION = 'Not available for an organization on a remote engine.'

/** Open a folder of this computer, unless this window's organization is on a
 *  remote engine: then nothing is opened and the answer says where it is. */
export async function localFolder<T extends { ok: boolean; error?: string }>(open: () => Promise<T>): Promise<T | { ok: false; error: string; remote: true }> {
  const remote = remoteHere()
  return remote ? { ok: false, error: remoteFolderText(remote.name), remote: true } : open()
}
