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
 *  desktop's own engine. Decision 93's route into the user's session is gone. */
export type Route = 'boot' | 'managed'

export function route(tasks: StartupTasks | null): Route {
  return tasks && tasks.boot !== null ? 'boot' : 'managed'
}

/** Start (or restart) the background engine where it belongs; 'managed' when
 *  this desktop is to start its own. The caller attaches afterwards. */
export async function launchBackground(_options: EngineOptions, _restart = false, runner: Runner = run): Promise<Route> {
  const where = route(await readStartupTasks(runner).catch(() => null))
  if (where === 'boot') await startEngineTask(runner)
  return where
}
