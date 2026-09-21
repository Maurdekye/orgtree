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
import { useEffect, useMemo, useState } from 'react'
import { getDefaults, getProviders, saveDefaults } from '../api'
import { availableAutopsyModels, fmtCredits, usePolled } from '../canvas/shared'
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
  const provPayload = usePolled(getProviders, [], 60000)
  const autopsyGroups = useMemo(
    () => availableAutopsyModels(provPayload, d?.fable_filter_model ?? 'opus'),
    [provPayload, d?.fable_filter_model])
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
        <div className="field-label">top-level grant cap</div>
        <input type="number" min="1" step="1" style={{ width: '8em' }}
          value={d.max_top_grant ?? 1000}
          onChange={(e) => set('max_top_grant', +e.target.value)} />
        <div className="field-label">default top-level grant (pre-filled on new hires)</div>
        <input type="number" min="0" step="1" style={{ width: '8em' }}
          value={d.default_top_grant ?? 50}
          onChange={(e) => set('default_top_grant', +e.target.value)} />
        <div className="field-label">compaction threshold % (50–95)</div>
        <input type="number" min="50" max="95" step="1" style={{ width: '8em' }}
          value={Math.round((d.compact_at ?? 0.8) * 100)}
          onChange={(e) => set('compact_at', (+e.target.value || 80) / 100)} />
        <div className="field-label">default thinking effort (agents without
          their own setting inherit this, live)</div>
        <select value={d.default_effort ?? ''}
          onChange={(e) => set('default_effort', e.target.value)}>
          <option value="">CLI default (no flag)</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
        <div className="field-label">fable weekly-limit policy</div>
        <select value={d.fable_limit_policy ?? 'halt'}
          onChange={(e) => set('fable_limit_policy', e.target.value)}>
          <option value="halt">halt (default)</option>
          <option value="opus">switch to opus</option>
          <option value="dissolve">dissolve subtree</option>
        </select>
        <div className="field-label">fable content-filter policy</div>
        <select value={d.fable_filter_policy ?? 'halt'}
          onChange={(e) => set('fable_filter_policy', e.target.value)}>
          <option value="halt">halt (default)</option>
          <option value="opus">switch to opus + retry</option>
          <option value="auto-autopsy">auto-autopsy</option>
        </select>
        {(d.fable_filter_policy ?? 'halt') === 'auto-autopsy' && (
          <>
            <div className="field-label">autopsy model (fable not selectable)</div>
            <select value={d.fable_filter_model ?? 'opus'} aria-label="autopsy model"
              onChange={(e) => set('fable_filter_model', e.target.value)}>
              {autopsyGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.models.map((m) => (
                    <option key={m.tier} value={m.tier}>
                      {m.label}{m.seat != null ? ` · seat ${fmtCredits(m.seat)}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </>
        )}
        <div className="field-label">credit cost bubbling</div>
        <label className="checkline">
          <input type="checkbox" checked={d.cascade_hire !== false}
            onChange={(e) => set('cascade_hire', e.target.checked)} />
          hires bubble their cost up the chain
        </label>
        <label className="checkline">
          <input type="checkbox" checked={d.cascade_alloc !== false}
            onChange={(e) => set('cascade_alloc', e.target.checked)} />
          allocations &amp; model upgrades bubble their cost up the chain
        </label>
        <label className="checkline">
          <input type="checkbox" checked={!!d.auto_resume}
            onChange={(e) => set('auto_resume', e.target.checked)} />
          auto-resume usage-limit-frozen agents after the reset time
        </label>
        <label className="checkline">
          <input type="checkbox" checked={!!d.auto_resume_compact}
            onChange={(e) => set('auto_resume_compact', e.target.checked)} />
          cheap-compact limit-frozen agents before auto-resume wakes them
        </label>
        <div className="field-label">app-wide Luna reserve default</div>
        <label className="checkline">
          <input type="checkbox" checked={d.prefer_reserve !== false}
            onChange={(e) => set('prefer_reserve', e.target.checked)} />
          prefer reserve capacity first when no individual preference is set
        </label>
        <div className="hint">
          Other defaults apply only when creating an organization. The
          app-wide Luna reserve default also reaches existing agents that have
          no individual preference; an explicit agent preference always wins.
        </div>
        <div className="row">
          <button className="primary" onClick={() =>
            saveDefaults({
              max_top_grant: d.max_top_grant,
              default_top_grant: d.default_top_grant,
              compact_at: Math.round((d.compact_at ?? 0.8) * 100),
              fable_limit_policy: d.fable_limit_policy,
              fable_filter_policy: d.fable_filter_policy,
              fable_filter_model: d.fable_filter_policy === 'auto-autopsy'
                ? (d.fable_filter_model ?? 'opus') : undefined,
              default_effort: d.default_effort ?? '',
              cascade_hire: d.cascade_hire !== false,
              cascade_alloc: d.cascade_alloc !== false,
              auto_resume: !!d.auto_resume,
              auto_resume_compact: !!d.auto_resume_compact,
              prefer_reserve: d.prefer_reserve !== false,
            }).then(() => {
              toast(['default org settings and app-wide Luna default saved'])
              close()
            })
              .catch((e: Error) => toast([`error: ${e.message}`]))}>save</button>
          <button onClick={close}>cancel</button>
        </div>
    </>
  )
}
