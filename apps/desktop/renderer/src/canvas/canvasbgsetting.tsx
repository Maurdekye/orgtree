/* App settings > Display: the canvas background picker (user rulings
 * 2026-10-15 18:20Z — the picker lives here; each theme has one intensity
 * slider and uses the current theme colours; there are no colour pickers).
 *
 * Both controls write through canvasbgpref.ts, which shows the choice on
 * every canvas at once and settles the native write behind it: the theme
 * applies the moment it is picked, and the slider previews live while its
 * save is debounced to one write per drag. A failed write snaps both back
 * to what is stored, which is the visible failure. */
import { SetGroup, SetRow } from './settingskit'
import { CANVAS_BACKGROUNDS, CANVAS_BACKGROUND_LABELS, DEFAULT_CANVAS_INTENSITIES } from '../../../../../packages/contracts/canvas-background'
import type { CanvasBackgroundTheme } from '../../../../../packages/contracts/canvas-background'
import { flushCanvasBackground, setCanvasBackgroundIntensity, setCanvasBackgroundTheme, useCanvasBackground } from '../canvasbgpref'

export function CanvasBackgroundSetting() {
  const pref = useCanvasBackground()
  const intensity = pref.intensities[pref.theme] ?? DEFAULT_CANVAS_INTENSITIES[pref.theme] ?? 1
  return <SetGroup title="Canvas background">
    <SetRow label="background"
      hint="Drawn behind the organization canvas. Grids and tiles pan and zoom with the canvas like a floor; the dot grid keeps its gentle parallax.">
      <select aria-label="Canvas background" value={pref.theme}
        onChange={e => setCanvasBackgroundTheme(e.target.value as CanvasBackgroundTheme)}>
        {CANVAS_BACKGROUNDS.map(id => <option key={id} value={id}>{CANVAS_BACKGROUND_LABELS[id]}</option>)}
      </select>
    </SetRow>
    <SetRow label="intensity"
      hint="How strongly this background shows. Each background remembers its own intensity.">
      <input aria-label="Background intensity" type="range" min="0" max="1" step="0.05"
        value={intensity}
        onChange={e => setCanvasBackgroundIntensity(pref.theme, Number(e.target.value))}
        onBlur={() => void flushCanvasBackground()} />
      <span className="set-value">{Math.round(intensity * 100)}%</span>
    </SetRow>
  </SetGroup>
}
