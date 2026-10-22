import { run, type Runner } from './runasadmin'
import { readStartupTasks, startEngineTask, type StartupTasks } from './runonstartup'
import type { EngineOptions } from './engine'

/** Where the background engine starts (decision 94; the user, 2026-10-22
 *  07:27Z and 07:28Z: "the main engine should always run in session 0,
 *  through restarts, updates, reboots, etc."). A first start, a restart, an
 *  update and a crash recovery all run the installer's boot task, which starts
 *  the engine in Session 0: at the console too, and while "Run on boot" is off
 *  (its triggers are off; the task still runs on demand). Agents reach the
 *  user's signed-in session through the sign-in helper. Only an installation
 *  without the boot task (a per-user one, a development run) keeps the
 *  desktop's own engine. Decision 93's route into the user's session is gone.
 *  An installed build that cannot read its tasks starts no engine at all
 *  ('unknown'; rig-sol-b's finding on a1f6c43): an unreadable task is no
 *  proof that there is none, and the desktop's own engine would run in the
 *  user's session. */
export type Route = 'boot' | 'managed' | 'unknown'

/** The refusal of an installed build that cannot read its tasks. */
export const UNREADABLE_TASKS = 'Orgtree could not read its background engine task, so it started no engine. Use Start engine in the tray to try again.'

/** Where an engine start goes, by the tasks as read (null: unreadable).
 *  `packaged` is an installed build (app.isPackaged): there only a task read
 *  as absent means a per-user installation. */
export function route(tasks: StartupTasks | null, packaged: boolean): Route {
  if (tasks && tasks.boot !== null) return 'boot'
  return tasks || !packaged ? 'managed' : 'unknown'
}

/** Start (or restart) the background engine where it belongs; 'managed' when
 *  this desktop is to start its own. The caller attaches afterwards. An
 *  installed build that cannot read its tasks throws UNREADABLE_TASKS and
 *  starts nothing. */
export async function launchBackground(_options: EngineOptions, packaged: boolean, runner: Runner = run): Promise<'boot' | 'managed'> {
  const where = route(await readStartupTasks(runner).catch(() => null), packaged)
  if (where === 'unknown') throw new Error(UNREADABLE_TASKS)
  if (where === 'boot') await startEngineTask(runner)
  return where
}
