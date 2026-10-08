// shell/defaults.tsx — the default-org-settings FIELDS, with no window of
// their own.
//
// The settled v3 layout puts "Default org settings" inside App settings as a
// tab. Rendering the whole `DefaultsPanel` there would nest one modal frame
// inside another: two titled, pinnable, closable surfaces, whose Escape
// handlers fight each other. So the fields live here and both callers pour
// them into their own container — the App settings tab into a tab panel, and
// `DefaultsPanel` in App.tsx into the standalone window it has always had.
//
// It sits in shell/ rather than in App.tsx because canvas/accounts.tsx (the
// App settings panel) has to import it, and importing from App.tsx would make
// a cycle: App.tsx already imports AccountsPanel.
import { useEffect, useState } from 'react'
import { getDefaults, saveDefaults } from '../api'
import { SetGroup, SetRow, SetToggle } from '../canvas/settingskit'
import type { DefaultsPayload, ToastFn } from '../types'

/** The default-org-settings FIELDS, with no window of their own.
 *
 *  Extracted so App settings can carry them as a tab (the settled v3 layout)
 *  without nesting one modal frame inside another — the two would each draw a
 *  titled, pinnable, closable surface and the inner one's Escape would fight
 *  the outer one's. `DefaultsPanel` in App.tsx is the same fields inside the
 *  standalone window they have always had; both call `onDone` where the old
 *  code called `close`, so neither route changed behaviour. */
export function DefaultsForm({ toast, onDone }: {
  toast: ToastFn; onDone: () => void
}) {
  // Partial: the error fallback seeds {} and every read has its own default
  const [d, setD] = useState<Partial<DefaultsPayload> | null>(null)
  useEffect(() => { getDefaults().then(setD).catch(() => setD({})) }, [])
  if (d == null) return <div className="dim pad">loading…</div>
  const close = onDone
  const set = (k: string, v: unknown) => setD({ ...d, [k]: v })
  return (
    <>
        {/* WHICH ORGS THIS APPLIES TO is the panel's most load-bearing
            sentence, and it used to live inside the h3 — where a pinned window
            hides it along with the duplicated heading. Outside it, visible in
            both modes (Astra 2026-09-06). */}
        <div className="dim modalpin-subtitle">applied to every NEW
          organization</div>
        <SetGroup title="Credits">
          <SetRow label="top-level grant cap">
            <input type="number" min="1" step="1" aria-label="top-level grant cap"
              value={d.max_top_grant ?? 1000}
              onChange={(e) => set('max_top_grant', +e.target.value)} />
          </SetRow>
          <SetRow label="default top-level grant" hint="pre-filled on new hires">
            <input type="number" min="0" step="1" aria-label="default top-level grant"
              value={d.default_top_grant ?? 50}
              onChange={(e) => set('default_top_grant', +e.target.value)} />
          </SetRow>
        </SetGroup>
        <SetGroup title="Agents">
          <SetRow label="compaction threshold %" hint="50–95">
            <input type="number" min="50" max="95" step="1" aria-label="compaction threshold %"
              value={Math.round((d.compact_at ?? 0.8) * 100)}
              onChange={(e) => set('compact_at', (+e.target.value || 80) / 100)} />
          </SetRow>
          <SetRow label="default thinking effort"
            hint="agents without their own setting inherit this, live">
            <select value={d.default_effort ?? ''} aria-label="default thinking effort"
              onChange={(e) => set('default_effort', e.target.value)}>
              <option value="">CLI default (no flag)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
          </SetRow>
        </SetGroup>
        <SetGroup title="Credit cost bubbling">
          <SetToggle label="hires bubble their cost up the chain" checked={d.cascade_hire !== false}
            hint="Raise ancestor grants when a hire needs more credits."
            onChange={next => set('cascade_hire', next)} />
          <SetToggle label="allocations & model upgrades bubble their cost up the chain" checked={d.cascade_alloc !== false}
            hint="Raise ancestor grants when an allocation or model upgrade needs more credits."
            onChange={next => set('cascade_alloc', next)} />
        </SetGroup>
        <SetGroup title="Usage limits">
          <SetToggle label="auto-resume usage-limit-frozen agents after the reset time" checked={!!d.auto_resume}
            hint="Resume agents automatically after their usage limit resets."
            onChange={next => set('auto_resume', next)} />
        </SetGroup>
        <div className="hint">
          These defaults apply only when creating an organization; existing
          organizations keep their own settings.
        </div>
        <div className="row">
          <button className="primary" onClick={() =>
            saveDefaults({
              max_top_grant: d.max_top_grant,
              default_top_grant: d.default_top_grant,
              compact_at: Math.round((d.compact_at ?? 0.8) * 100),
              default_effort: d.default_effort ?? '',
              cascade_hire: d.cascade_hire !== false,
              cascade_alloc: d.cascade_alloc !== false,
              auto_resume: !!d.auto_resume,
            }).then(() => {
              toast(['default org settings saved'])
              close()
            })
              .catch((e: Error) => toast([`error: ${e.message}`]))}>save</button>
          <button onClick={close}>cancel</button>
        </div>
    </>
  )
}
