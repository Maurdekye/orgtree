/* EPIC Mode — following the switch. main.tsx starts this once per window.

   While the stored switch is off this holds ONE preference subscription (the
   same kind the theme, contrast and Rainbow syncs beside it hold) and nothing
   else: the director's code is not loaded, no stage exists, no AudioContext
   exists, no listener is attached and every tap in App.tsx is a null check.
   Turning the switch on loads the director and starts the show; turning it
   off plays the power-down and takes every piece of it away again.

   The window whose own switch was clicked gets the full fanfare and the
   power-down's sound; every other open window follows the same broadcast
   preference quietly with the smaller launch greeting, so one click does not
   ring out of every window at once. */
import { tookLocalClick, watchEpic } from './pref'
import type { EpicShow } from './director'

export function startEpicSync(): () => void {
  let show: EpicShow | null = null
  let wanted = false
  let first = true
  let generation = 0
  const apply = (on: boolean) => {
    const launch = first
    first = false
    if (on === wanted) return
    wanted = on
    const mine = ++generation
    if (on) {
      const greet = launch ? 'launch' : tookLocalClick() ? 'enable' : 'launch'
      void import('./director')
        .then(m => {
          if (mine !== generation || !wanted || show) return
          show = m.startEpic({ greet })
        })
        .catch(() => { /* the chunk did not load: the app stays ordinary */ })
    } else if (show) {
      const ending = show
      show = null
      ending.stop({ farewell: true, quiet: !tookLocalClick() })
    }
  }
  const stopWatching = watchEpic(apply)
  return () => {
    stopWatching()
    generation++
    wanted = false
    show?.stop()
    show = null
  }
}
