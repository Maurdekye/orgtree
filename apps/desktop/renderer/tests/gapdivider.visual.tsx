import { createRoot } from 'react-dom/client'
import { Msg } from '../src/canvas/desk'
import { gapDividerText, stateMarkerText } from '../src/canvas/statemarker'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import type { ChatMessage } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

// Capture fixture (USER 2026-11-03 m7ce661ebe984): the same row list the desk draws, through the same helpers
// (stateMarkerText drops silent markers, gapDividerText decides the divider). Theme: ?theme=light|charcoal. Synthetic.
const theme = new URLSearchParams(location.search).get('theme') ?? 'light'
applyContrast(theme === 'charcoal' ? 'charcoal' : 'light'); applyTheme('claude')
const t = (min: number) => new Date(Date.parse('2026-11-03T10:00:00Z') + min * 60e3).toISOString()
const marker = (min: number, state: string, prev: string, secs: number): ChatMessage =>
  ({ role: 'system', kind: 'state', state, prev_state: prev, prev_secs: secs, text: '', ts: t(min), seq: min } as ChatMessage)
const say = (min: number, text: string): ChatMessage => ({ role: 'assistant', text, ts: t(min), seq: min } as ChatMessage)
// Scene A (the screenshot): "Active for 20s", 28 min quiet, "Idle for 28m": ONE line for the quiet time, no divider.
// Scene B: a marker of 10 s next to a 28-minute gap: the divider stays. Scene C: no marker: the divider stays.
const SCENES: Record<string, ChatMessage[]> = {
  A: [marker(0, 'idle', 'active', 20), marker(28, 'active', 'idle', 28 * 60)],
  B: [marker(0, 'idle', 'active', 20), marker(28, 'active', 'idle', 10)],
  C: [say(0, 'Done, waiting.'), say(28, 'Back at it.')],
}
const Scene = ({ id, rows }: { id: string; rows: ChatMessage[] }) =>
  <section data-scene={id} style={{ marginBottom: 14 }}>
    <h4>{id === 'A' ? 'A: marker covers the gap, no divider' : id === 'B' ? 'B: 10 s marker, divider stays' : 'C: no marker, divider stays'}</h4>
    {rows.filter(m => stateMarkerText(m) !== null).map((m, i, all) => {
      const gap = gapDividerText(all[i - 1], m, true)
      return <div key={m.seq} data-transcript-row>
        {gap && <div className="msg sys">— {gap} later —</div>}
        <Msg m={m} slug="fixture" nid="worker" />
      </div>
    })}
  </section>
createRoot(document.getElementById('root')!).render(
  <div className="desk" style={{ width: 460, margin: 24 }}>{Object.entries(SCENES).map(([id, rows]) => <Scene key={id} id={id} rows={rows} />)}</div>)
