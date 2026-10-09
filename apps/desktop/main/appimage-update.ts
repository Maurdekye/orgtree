import fs from 'node:fs'
import path from 'node:path'
import type { HandoffResult } from './updater'

// Linux updates are AppImage-only. electron-updater's own AppImage install
// deletes the running file, moves the download in under a NEW name when the
// old one carries a version, and starts the new copy while this process still
// holds the single-instance lock, so the new copy quits at once. None of that
// is used: the swap and the relaunch below are ours.

/** The AppImage this process was launched from, or undefined when it was not
 *  launched from one (the .deb, a development build). Undefined means no
 *  updater: there is nothing this process could replace. */
export function appImagePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.APPIMAGE
  return file && path.isAbsolute(file) && !file.includes('\0') ? file : undefined
}

type SwapIo = Pick<typeof fs, 'copyFileSync' | 'chmodSync' | 'renameSync' | 'unlinkSync'>

/** Replace the AppImage at `current` with `downloaded`, IN PLACE.
 *
 *  The path stays the same even though the release file name carries a
 *  version, because everything that launches Orgtree points at this path: the
 *  user's own launchers and the background engine's systemd unit or autostart
 *  entry. Renaming it would break every one of them.
 *
 *  Copied into the same folder and then renamed over the old file, so the
 *  replacement is atomic: a failure at any step leaves the old AppImage
 *  untouched and throws. The running copy keeps working after the rename,
 *  because its mount holds the old file open. */
export function replaceAppImage(current: string, downloaded: string | undefined, pid = process.pid, io: SwapIo = fs): HandoffResult {
  if (!downloaded) throw new Error('electron-updater did not name the downloaded AppImage')
  const staged = path.join(path.dirname(current), `.${path.basename(current)}.update-${pid}`)
  try {
    io.copyFileSync(downloaded, staged)
    io.chmodSync(staged, 0o755)
    io.renameSync(staged, current)
  } catch (error) {
    try { io.unlinkSync(staged) } catch { /* nothing was staged */ }
    throw error
  }
  // electron-updater would offer this file again as a prepared update
  try { io.unlinkSync(downloaded) } catch { /* its cache cleans up later */ }
  return { accepted: true, directory: path.dirname(current), appImage: current }
}

/** How to start the AppImage again once THIS process has exited.
 *
 *  Not app.relaunch(): from an AppImage it re-runs process.execPath, a file
 *  inside this run's own mount, which is gone once this process exits. And not
 *  an immediate spawn either: the new copy would find the single-instance lock
 *  still held and quit. So a small shell waits for this pid to end (at most
 *  five minutes, far past the quit deadlines) and then runs the AppImage.
 *  The paths are passed as arguments, never pasted into the script. */
export function appImageRelaunch(appImage: string, pid: number): { file: string; args: string[] } {
  return {
    file: '/bin/sh',
    args: ['-c', 'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.1; i=$((i+1)); done; exec "$2"',
      'orgtree-relaunch', String(pid), appImage],
  }
}

/** The environment for the relaunched AppImage. The AppImage runtime sets
 *  APPIMAGE, APPDIR, ARGV0 and OWD for its own run, and Electron replaced
 *  XDG_CURRENT_DESKTOP after saving the original, so those are put back. */
export function appImageRelaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE']) delete next[key]
  if (next.ORIGINAL_XDG_CURRENT_DESKTOP !== undefined) {
    next.XDG_CURRENT_DESKTOP = next.ORIGINAL_XDG_CURRENT_DESKTOP
    delete next.ORIGINAL_XDG_CURRENT_DESKTOP
  }
  return next
}
