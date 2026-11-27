// fitpins.visual.tsx - the fixture for fitpins.capture.cjs: the Display > Desk rows around "Fit the view around pinned
// windows" (USER 2026-11-27 m56eddd849c57). REAL: the app's stylesheets and the settings kit's group and rows, as the
// settings panel draws them. SYNTHETIC: only the frame around them. Browser-only; nothing is requested.
import { createRoot } from 'react-dom/client'
import { SetGroup } from '../src/canvas/settingskit'
import { CanvasAnchorSettings } from '../src/canvas/canvasanchor'
import { FitAroundPinsSetting } from '../src/canvas/fitpins'
import '../src/styles.css'
import '../src/shell.css'

localStorage.clear()
createRoot(document.getElementById('root')!).render(
  <div className="settings-panel" style={{ width: 640, padding: 16 }}>
    <SetGroup title="Desk"><CanvasAnchorSettings /><FitAroundPinsSetting /></SetGroup>
  </div>)
